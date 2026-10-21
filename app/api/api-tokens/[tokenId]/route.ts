// SPDX-License-Identifier: MIT
import { handle, ok, HttpError, isUuid } from '@/lib/api/route-utils';
import { revokeApiToken, rejectTokenAuth } from '@/lib/token-auth';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ tokenId: string }> };

/** DELETE — revoke a token. Revoked tokens authenticate as 401 everywhere. */
export const DELETE = handle(async (req: Request, ctx: Ctx) => {
  rejectTokenAuth(req);
  const { tokenId } = await ctx.params;
  if (!isUuid(tokenId)) throw new HttpError(400, 'validation', 'invalid token id');
  const revoked = await revokeApiToken(tokenId);
  if (!revoked) throw new HttpError(404, 'not_found', 'token not found or already revoked');
  return ok({ revoked: tokenId });
});
