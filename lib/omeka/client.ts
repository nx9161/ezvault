// SPDX-License-Identifier: MIT
/**
 * lib/omeka/client.ts — Omeka S REST client (Wave D, row 25).
 *
 * Pure module (no server-only, no DB): the fetch implementation is
 * injectable so unit tests drive the real request-building code against
 * a mocked fetch. Implemented from the public Omeka S REST API spec
 * (JSON-LD resources under {base}/api, key auth via the `key_identity`
 * + `key_credential` query parameters) — clean-room, no Tropy code.
 *
 * Mapping (binding): EZVault templates are Dublin-Core-vocabulary based,
 * so an item's metadata values map by PROPERTY URI onto Omeka's
 * `dcterms` terms: both `http://purl.org/dc/terms/<local>` and the older
 * `http://purl.org/dc/elements/1.1/<local>` become `dcterms:<local>`.
 * Non-DC properties have no Omeka counterpart unless the target site
 * imported that vocabulary — they are reported as warnings, never
 * silently dropped and never faked into a DC term.
 * Item notes ride along as extra `dcterms:description` literal values
 * (the property model allows multiple values; notes have no closer DC
 * home on a stock Omeka S install).
 * Photos attach as media via the `url` ingester: Omeka fetches the
 * bytes itself from a presigned GET URL — the supported server-side
 * mechanism (the `upload` ingester is a browser multipart flow).
 */

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface OmekaSettingsInput {
  baseUrl: string;
  keyIdentity: string;
  keyCredential: string;
}

export class OmekaError extends Error {
  status: number;
  /** Response body excerpt, surfaced verbatim-ish to the user (≤500 chars). */
  body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Omeka S request failed (HTTP ${status})${body ? `: ${body.slice(0, 300)}` : ''}`);
    this.name = 'OmekaError';
    this.status = status;
    this.body = body.slice(0, 500);
  }
}

/** Normalize + validate an instance base URL (trailing slash stripped). */
export function normalizeOmekaBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OmekaError(0, '', 'Omeka base URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OmekaError(0, '', 'Omeka base URL must start with http:// or https://');
  }
  if (url.username || url.password) {
    throw new OmekaError(0, '', 'Omeka base URL must not embed credentials');
  }
  return url.toString().replace(/\/+$/, '');
}

const DC_TERMS = 'http://purl.org/dc/terms/';
const DC_ELEMENTS = 'http://purl.org/dc/elements/1.1/';

/** Map a property URI to its Omeka `dcterms:` term, or null when not DC. */
export function dcTermForUri(propertyUri: string): string | null {
  if (propertyUri.startsWith(DC_TERMS)) return `dcterms:${propertyUri.slice(DC_TERMS.length)}`;
  if (propertyUri.startsWith(DC_ELEMENTS)) return `dcterms:${propertyUri.slice(DC_ELEMENTS.length)}`;
  return null;
}

export interface ItemForPush {
  metadata: { property_uri: string; text: string; datatype?: string }[];
  /** Plain-text note bodies, in order. */
  notes: string[];
}

export interface OmekaValue {
  property_id?: number;
  type: 'literal';
  '@value': string;
}

export interface BuiltPayload {
  payload: Record<string, OmekaValue[]>;
  /** Human-readable mapping losses (non-DC properties, unresolved terms). */
  warnings: string[];
}

/**
 * Build the Omeka item body from an item's metadata + notes.
 * `propertyIds` maps term -> Omeka property id (from GET /api/properties);
 * a DC term missing from the map is dropped with a warning — Omeka
 * rejects values without a property_id, so sending one would fail the
 * whole push; the warning keeps the loss honest.
 */
export function buildOmekaItemPayload(item: ItemForPush, propertyIds: Map<string, number>): BuiltPayload {
  const payload: Record<string, OmekaValue[]> = {};
  const warnings: string[] = [];
  const push = (term: string, text: string) => {
    const value = text.trim();
    if (!value) return;
    const pid = propertyIds.get(term);
    if (pid === undefined) {
      warnings.push(`property ${term} not found on the Omeka site — value skipped`);
      return;
    }
    (payload[term] ??= []).push({ property_id: pid, type: 'literal', '@value': value.slice(0, 100_000) });
  };
  for (const m of item.metadata) {
    const term = dcTermForUri(m.property_uri);
    if (!term) {
      warnings.push(`property ${m.property_uri} is not Dublin Core — not mapped to Omeka`);
      continue;
    }
    push(term, m.text);
  }
  for (const note of item.notes) push('dcterms:description', note);
  return { payload, warnings };
}

export class OmekaClient {
  private baseUrl: string;
  private keyIdentity: string;
  private keyCredential: string;
  private doFetch: FetchImpl;
  private propertyMap: Map<string, number> | null = null;

  constructor(settings: OmekaSettingsInput, fetchImpl?: FetchImpl) {
    this.baseUrl = normalizeOmekaBaseUrl(settings.baseUrl);
    this.keyIdentity = settings.keyIdentity;
    this.keyCredential = settings.keyCredential;
    this.doFetch = fetchImpl ?? ((u, i) => fetch(u, i));
  }

  /** API URL with key auth as query params (the Omeka S key-auth scheme). */
  apiUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.baseUrl}/api/${path.replace(/^\/+/, '')}`);
    url.searchParams.set('key_identity', this.keyIdentity);
    url.searchParams.set('key_credential', this.keyCredential);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, params?: Record<string, string>): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(this.apiUrl(path, params), {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'EZVault/1.0 (+omeka-push)',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new OmekaError(0, '', `could not reach the Omeka S instance: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new OmekaError(res.status, text);
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OmekaError(res.status, text, 'Omeka S returned a non-JSON response');
    }
  }

  /** term -> property id, from GET /api/properties (paginated, cached). */
  async getPropertyMap(): Promise<Map<string, number>> {
    if (this.propertyMap) return this.propertyMap;
    const map = new Map<string, number>();
    let page = 1;
    for (;;) {
      const rows = await this.request<Array<Record<string, unknown>>>('GET', 'properties', undefined, {
        per_page: '100',
        page: String(page),
      });
      if (!Array.isArray(rows)) break;
      for (const r of rows) {
        const term = r['o:term'];
        const id = r['o:id'];
        if (typeof term === 'string' && typeof id === 'number') map.set(term, id);
      }
      if (rows.length < 100) break;
      page++;
      if (page > 50) break; // sanity bound; DC vocabularies resolve on page 1
    }
    this.propertyMap = map;
    return map;
  }

  async createItem(payload: Record<string, OmekaValue[]>): Promise<{ id: number; url: string | null }> {
    const res = await this.request<Record<string, unknown>>('POST', 'items', payload);
    const id = res['o:id'];
    if (typeof id !== 'number') throw new OmekaError(0, JSON.stringify(res).slice(0, 500), 'Omeka S create response carried no o:id');
    return { id, url: typeof res['@id'] === 'string' ? res['@id'] : null };
  }

  async updateItem(remoteId: number, payload: Record<string, OmekaValue[]>): Promise<{ id: number; url: string | null }> {
    const res = await this.request<Record<string, unknown>>('PUT', `items/${remoteId}`, payload);
    const id = typeof res['o:id'] === 'number' ? res['o:id'] : remoteId;
    return { id, url: typeof res['@id'] === 'string' ? res['@id'] : null };
  }

  /** Attach one photo as media via the URL ingester (Omeka fetches the bytes). */
  async createMediaForItem(remoteItemId: number, sourceUrl: string, title: string | undefined, propertyIds: Map<string, number>): Promise<number> {
    const body: Record<string, unknown> = {
      'o:item': { 'o:id': remoteItemId },
      'o:ingester': 'url',
      'o:renderer': 'file',
      'o:source': sourceUrl,
    };
    if (title) {
      const pid = propertyIds.get('dcterms:title');
      if (pid !== undefined) {
        body['dcterms:title'] = [{ property_id: pid, type: 'literal', '@value': title.slice(0, 500) }] as OmekaValue[];
      }
    }
    const res = await this.request<Record<string, unknown>>('POST', 'media', body);
    const id = res['o:id'];
    if (typeof id !== 'number') throw new OmekaError(0, JSON.stringify(res).slice(0, 500), 'Omeka S media response carried no o:id');
    return id;
  }
}
