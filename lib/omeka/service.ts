// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/omeka/service.ts — Omeka S settings + push orchestration (row 25).
 *
 * Settings live in omeka_settings (migration 0011). The key credential
 * is stored ONLY as AES-256-GCM ciphertext under a key derived from
 * MASTER_KEY (lib/crypto/master-key.ts). When MASTER_KEY is not
 * configured, saving a credential is refused with a `not_configured`
 * error — there is no plaintext fallback, ever.
 *
 * Push: one item -> Omeka item (create, or PUT-update when omeka_sync
 * already holds a remote id), photos attached once via the URL ingester
 * with a 1-hour presigned GET (media_map in omeka_sync tracks what is
 * attached). Errors from Omeka surface verbatim-ish (OmekaError body).
 * Project push runs the import_jobs pattern (kind 'omeka') with per-item
 * results in the job report.
 */

import { randomUUID } from 'node:crypto';
import { sql, tx, bumpRevQuery, type TxQuery } from '../db/index';
import { HttpError } from '../api/route-utils';
import { getStorageDriver } from '../storage/driver';
import { encryptSecret, decryptSecret, masterKeyFromEnv } from '../crypto/master-key';
import { OmekaClient, buildOmekaItemPayload, normalizeOmekaBaseUrl, type ItemForPush } from './client';

export interface OmekaSettingsView {
  configured: boolean;
  /** Why not usable: 'not_configured' when unset or MASTER_KEY missing. */
  status: 'ok' | 'not_configured';
  base_url: string | null;
  key_identity: string | null;
  has_credential: boolean;
  master_key_configured: boolean;
}

export async function getOmekaSettingsView(projectId: string): Promise<OmekaSettingsView> {
  const master = masterKeyFromEnv();
  const rows = await sql()`SELECT base_url, key_identity, credential_cipher FROM omeka_settings WHERE project_id = ${projectId}`;
  if (!rows.length) {
    return { configured: false, status: 'not_configured', base_url: null, key_identity: null, has_credential: false, master_key_configured: !!master };
  }
  const r = rows[0];
  const hasCred = typeof r['credential_cipher'] === 'string' && (r['credential_cipher'] as string).length > 0;
  const configured = hasCred && !!master;
  return {
    configured,
    status: configured ? 'ok' : 'not_configured',
    base_url: r['base_url'] as string,
    key_identity: r['key_identity'] as string,
    has_credential: hasCred,
    master_key_configured: !!master,
  };
}

export async function saveOmekaSettings(
  projectId: string,
  input: { base_url: string; key_identity: string; key_credential?: string },
): Promise<OmekaSettingsView> {
  const baseUrl = normalizeOmekaBaseUrl(input.base_url);
  const identity = input.key_identity.trim().slice(0, 300);
  if (!identity) throw new HttpError(400, 'validation', 'key_identity is required');
  let cipher: string | null = null;
  let keepExisting = false;
  if (input.key_credential !== undefined && input.key_credential !== '') {
    const master = masterKeyFromEnv();
    if (!master) {
      // Honest refusal: never store a credential we cannot encrypt.
      throw new HttpError(400, 'not_configured', 'MASTER_KEY is not configured on the server, so the Omeka credential cannot be stored encrypted. Set MASTER_KEY and retry — the credential was NOT saved.');
    }
    cipher = encryptSecret(input.key_credential, master);
  } else {
    keepExisting = true;
  }
  if (keepExisting) {
    await sql()`INSERT INTO omeka_settings (project_id, base_url, key_identity)
      VALUES (${projectId}, ${baseUrl}, ${identity})
      ON CONFLICT (project_id) DO UPDATE SET base_url = EXCLUDED.base_url, key_identity = EXCLUDED.key_identity, updated_at = now()`;
  } else {
    await sql()`INSERT INTO omeka_settings (project_id, base_url, key_identity, credential_cipher)
      VALUES (${projectId}, ${baseUrl}, ${identity}, ${cipher})
      ON CONFLICT (project_id) DO UPDATE SET base_url = EXCLUDED.base_url, key_identity = EXCLUDED.key_identity, credential_cipher = EXCLUDED.credential_cipher, updated_at = now()`;
  }
  return getOmekaSettingsView(projectId);
}

async function loadClient(projectId: string): Promise<OmekaClient> {
  const master = masterKeyFromEnv();
  const rows = await sql()`SELECT base_url, key_identity, credential_cipher FROM omeka_settings WHERE project_id = ${projectId}`;
  if (!rows.length || !rows[0]['credential_cipher']) {
    throw new HttpError(400, 'not_configured', 'Omeka S is not configured for this project (set the instance URL and API key in Project settings)');
  }
  if (!master) {
    throw new HttpError(400, 'not_configured', 'MASTER_KEY is not configured on the server, so the stored Omeka credential cannot be decrypted');
  }
  const credential = decryptSecret(rows[0]['credential_cipher'] as string, master);
  return new OmekaClient({
    baseUrl: rows[0]['base_url'] as string,
    keyIdentity: rows[0]['key_identity'] as string,
    keyCredential: credential,
  });
}

async function loadItemForPush(projectId: string, itemId: string): Promise<ItemForPush & { photos: { subject_id: string; r2_key: string | null; original_filename: string; missing_original: boolean }[] }> {
  const chk = await sql()`SELECT id FROM subjects WHERE id = ${itemId} AND project_id = ${projectId} AND kind = 'item'`;
  if (!chk.length) throw new HttpError(404, 'not_found', 'item not found');
  const trashed = await sql()`SELECT subject_id FROM trash WHERE subject_id = ${itemId}`;
  if (trashed.length) throw new HttpError(400, 'validation', 'item is in trash');
  const meta = await sql()`SELECT m.property_uri, v.datatype, v.text FROM metadata m
    JOIN metadata_values v ON v.value_id = m.value_id WHERE m.subject_id = ${itemId} ORDER BY m.created_at`;
  const notes = await sql()`SELECT text FROM notes WHERE subject_id = ${itemId} AND deleted_at IS NULL ORDER BY created_at`;
  const photos = await sql()`SELECT subject_id, r2_key, original_filename, missing_original FROM photos
    WHERE item_id = ${itemId} ORDER BY position`;
  return {
    metadata: meta.map((r) => ({ property_uri: r['property_uri'] as string, text: r['text'] as string, datatype: r['datatype'] as string })),
    notes: notes.map((r) => r['text'] as string).filter((t) => t.trim()),
    photos: photos.map((r) => ({
      subject_id: r['subject_id'] as string,
      r2_key: (r['r2_key'] as string | null) ?? null,
      original_filename: r['original_filename'] as string,
      missing_original: Boolean(r['missing_original']),
    })),
  };
}

export interface PushItemResult {
  item_id: string;
  remote_id: number;
  remote_url: string | null;
  action: 'created' | 'updated';
  media_attached: number;
  warnings: string[];
}

/** Push ONE item (create or update) + attach any not-yet-attached photos. */
export async function pushItemToOmeka(projectId: string, itemId: string, client?: OmekaClient): Promise<PushItemResult> {
  const omeka = client ?? (await loadClient(projectId));
  const item = await loadItemForPush(projectId, itemId);
  const propertyIds = await omeka.getPropertyMap();
  const { payload, warnings } = buildOmekaItemPayload(item, propertyIds);

  const syncRows = await sql()`SELECT remote_id, media_map FROM omeka_sync WHERE item_id = ${itemId} AND project_id = ${projectId}`;
  const existingRemote = syncRows.length ? Number(syncRows[0]['remote_id']) : null;
  const mediaMap: Record<string, number> = syncRows.length && syncRows[0]['media_map'] && typeof syncRows[0]['media_map'] === 'object'
    ? (syncRows[0]['media_map'] as Record<string, number>) : {};

  let remoteId: number;
  let remoteUrl: string | null;
  let action: 'created' | 'updated';
  try {
    if (existingRemote) {
      const r = await omeka.updateItem(existingRemote, payload);
      remoteId = r.id; remoteUrl = r.url; action = 'updated';
    } else {
      const r = await omeka.createItem(payload);
      remoteId = r.id; remoteUrl = r.url; action = 'created';
    }
  } catch (err) {
    await recordSync(projectId, itemId, existingRemote ?? 0, null, mediaMap, 'error', err instanceof Error ? err.message.slice(0, 1000) : String(err));
    throw err;
  }

  // Attach photos not yet on the remote item (URL ingester, 1h presign).
  const storage = await getStorageDriver();
  let attached = 0;
  for (const photo of item.photos) {
    if (mediaMap[photo.subject_id] !== undefined) continue;
    if (!photo.r2_key || photo.missing_original) {
      warnings.push(`photo ${photo.original_filename} has no original bytes — not attached`);
      continue;
    }
    const sourceUrl = await storage.presignGet(photo.r2_key, { ttlSec: 3600, disposition: 'inline' });
    const mediaId = await omeka.createMediaForItem(remoteId, sourceUrl, photo.original_filename, propertyIds);
    mediaMap[photo.subject_id] = mediaId;
    attached++;
  }

  await recordSync(projectId, itemId, remoteId, remoteUrl, mediaMap, 'ok', null);
  return { item_id: itemId, remote_id: remoteId, remote_url: remoteUrl, action, media_attached: attached, warnings };
}

async function recordSync(
  projectId: string, itemId: string, remoteId: number, remoteUrl: string | null,
  mediaMap: Record<string, number>, status: string, error: string | null,
): Promise<void> {
  if (!remoteId) {
    if (status === 'error') return; // no remote identity yet — nothing to track
  }
  await sql()`INSERT INTO omeka_sync (item_id, project_id, remote_id, remote_url, media_map, last_pushed_at, last_status, last_error)
    VALUES (${itemId}, ${projectId}, ${remoteId}, ${remoteUrl}, ${JSON.stringify(mediaMap)}::jsonb, now(), ${status}, ${error})
    ON CONFLICT (item_id) DO UPDATE SET remote_id = EXCLUDED.remote_id, remote_url = EXCLUDED.remote_url,
      media_map = EXCLUDED.media_map, last_pushed_at = now(), last_status = EXCLUDED.last_status, last_error = EXCLUDED.last_error`;
}

export interface PushProjectResult {
  job_id: string;
  pushed: number;
  failed: number;
  results: ({ item_id: string; status: 'ok'; remote_id: number; action: string; warnings: string[] } | { item_id: string; status: 'failed'; error: string })[];
}

/** Push every non-trashed item in the project; per-item results, job-tracked. */
export async function pushProjectToOmeka(projectId: string): Promise<PushProjectResult> {
  const client = await loadClient(projectId); // fail fast when unconfigured
  const jobId = randomUUID();
  const items = await sql()`SELECT s.id FROM subjects s JOIN items i ON i.subject_id = s.id
    WHERE s.project_id = ${projectId} AND s.kind = 'item'
      AND NOT EXISTS (SELECT 1 FROM trash t WHERE t.subject_id = s.id)
    ORDER BY s.created_at`;
  const itemIds = items.map((r) => r['id'] as string);
  await sql()`INSERT INTO import_jobs (id, project_id, kind, status, total)
    VALUES (${jobId}, ${projectId}, 'omeka', 'running', ${itemIds.length})`;
  const results: PushProjectResult['results'] = [];
  let pushed = 0;
  let failed = 0;
  for (const itemId of itemIds) {
    try {
      const r = await pushItemToOmeka(projectId, itemId, client);
      results.push({ item_id: itemId, status: 'ok', remote_id: r.remote_id, action: r.action, warnings: r.warnings });
      pushed++;
      await sql()`UPDATE import_jobs SET done = done + 1, updated_at = now() WHERE id = ${jobId}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ item_id: itemId, status: 'failed', error: message.slice(0, 1000) });
      failed++;
      await sql()`UPDATE import_jobs SET failed = failed + 1, updated_at = now() WHERE id = ${jobId}`;
    }
  }
  const status = failed === 0 ? 'done' : pushed > 0 ? 'done' : 'failed';
  await tx((q: (text: string, params?: unknown[]) => TxQuery) => [
    q(`UPDATE import_jobs SET status = $2, report = $3::jsonb, error = $4, updated_at = now() WHERE id = $1`,
      [jobId, status, JSON.stringify({ results }), failed ? `${failed} item(s) failed to push` : null]),
    bumpRevQuery(projectId),
  ]);
  return { job_id: jobId, pushed, failed, results };
}
