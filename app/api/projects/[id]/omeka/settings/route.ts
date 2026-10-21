// SPDX-License-Identifier: MIT
import { handle, ok, parseJson, requireProject, HttpError } from '@/lib/api/route-utils';
import { getOmekaSettingsView, saveOmekaSettings } from '@/lib/omeka/service';
import { OmekaError } from '@/lib/omeka/client';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/omeka/settings — connection view. The credential
 * is NEVER returned (has_credential only). `status: 'not_configured'`
 * when unset, or when MASTER_KEY is missing (stored ciphertext would be
 * undecryptable — reported honestly, never papered over).
 */
export const GET = handle(async (_req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  return ok(await getOmekaSettingsView(id));
});

/**
 * PUT — save instance URL + key identity (+ credential when provided).
 * A provided credential is stored ONLY as AES-256-GCM ciphertext under
 * MASTER_KEY; without MASTER_KEY the save is refused (not_configured)
 * and nothing is persisted. Omitting the credential keeps the stored one.
 */
export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  await requireProject(id);
  const body = await parseJson<{ base_url?: string; key_identity?: string; key_credential?: string }>(req);
  if (!body.base_url?.trim()) throw new HttpError(400, 'validation', 'base_url is required');
  if (!body.key_identity?.trim()) throw new HttpError(400, 'validation', 'key_identity is required');
  try {
    const view = await saveOmekaSettings(id, {
      base_url: body.base_url,
      key_identity: body.key_identity,
      key_credential: body.key_credential,
    });
    return ok(view);
  } catch (err) {
    if (err instanceof OmekaError) throw new HttpError(400, 'validation', err.message);
    throw err;
  }
});
