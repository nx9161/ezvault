// SPDX-License-Identifier: MIT
/**
 * lib/import/jsonld-context.ts — B10 strict documentLoader.
 *
 * Split out of jsonld-accept.ts so the pure loader logic is unit-testable:
 * this module has NO `import 'server-only'` and no DB access.
 */

export const TROPY_CONTEXT_URL = 'https://tropy.org/v1/tropy#';

/** Inline allowlisted context (B10 — the ONLY remote context ever served). */
const INLINE_TROPY_CONTEXT = {
  '@context': {
    '@vocab': TROPY_CONTEXT_URL,
    Item: `${TROPY_CONTEXT_URL}Item`,
    Note: `${TROPY_CONTEXT_URL}Note`,
    Selection: `${TROPY_CONTEXT_URL}Selection`,
  },
};

export class RemoteContextRejectedError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`remote JSON-LD context rejected: ${url}`);
    this.name = 'RemoteContextRejectedError';
    this.url = url;
  }
}

/**
 * B10 documentLoader: serves the inline tropy.org context, rejects every
 * other remote context (SSRF guard). Throws on any non-allowlisted URL.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function strictDocumentLoader(url: string): Promise<any> {
  const normalized = url.trim().replace(/#$/, '');
  if (normalized === TROPY_CONTEXT_URL || normalized === 'https://tropy.org/v1/tropy') {
    return { contextUrl: null, documentUrl: url, document: INLINE_TROPY_CONTEXT };
  }
  throw new RemoteContextRejectedError(url);
}
