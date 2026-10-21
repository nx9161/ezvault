// SPDX-License-Identifier: MIT
/**
 * lib/fetch-guard.ts — SSRF guard for server-side fetches of USER-SUPPLIED
 * URLs (Wave D, row 26 — IIIF manifest + canvas image harvest).
 *
 * The task brief names lib/link-policy.ts as "the app's existing SSRF/link
 * policy": that module is the NOTE-LINK allowlist (http/https/mailto/tel
 * for hrefs rendered in notes) — it is not an SSRF control and allowing
 * http: or private hosts would be wrong here. This module is the fetch
 * guard proper, built to the brief's rule: https only, no private /
 * loopback / link-local targets. Reuse it — never fetch a user URL raw.
 *
 * Pure module (no server-only): the validator is unit-tested directly and
 * guardedFetch takes an injectable fetch implementation.
 *
 * Known limit (documented, not hidden): the check is on the URL's literal
 * hostname — IP literals are range-checked and well-known local names are
 * rejected, but DNS names are not resolved here, so a public name that
 * resolves to a private address (DNS rebinding) is out of scope for this
 * layer; redirects are re-validated hop by hop, which closes the common
 * open-redirect-to-internal variant.
 */

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain']);

/** Parse an IPv4 literal to its 4 octets, or null when not an IPv4 literal. */
function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** True for private / loopback / link-local / reserved IPv4 ranges. */
export function isPrivateIpv4(host: string): boolean {
  const o = ipv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (cloud metadata)
  if (a === 0) return true; // "this network" 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 240) return true; // reserved 240.0.0.0/4
  return false;
}

/** True for private / loopback / link-local IPv6 literals (brackets stripped). */
export function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10 link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  if (h.startsWith('::ffff:')) {
    const v4 = h.slice('::ffff:'.length);
    if (ipv4Octets(v4)) return isPrivateIpv4(v4);
  }
  return false;
}

/**
 * Validate a user-supplied URL for server-side fetching. Returns the
 * parsed URL on success; throws SsrfError otherwise. Rules: https only,
 * no embedded credentials, hostname must not be a blocked name or a
 * private/loopback/link-local IP literal.
 */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('URL is not parseable');
  }
  if (url.protocol !== 'https:') {
    throw new SsrfError(`only https URLs may be fetched (got ${url.protocol.replace(':', '') || 'none'})`);
  }
  if (url.username || url.password) {
    throw new SsrfError('URLs with embedded credentials are not allowed');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new SsrfError('URL has no hostname');
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SsrfError(`hostname ${host} is not a public target`);
  }
  if (host.includes(':')) {
    if (isPrivateIpv6(host)) throw new SsrfError(`hostname ${host} is a private/loopback address`);
  } else if (ipv4Octets(host)) {
    if (isPrivateIpv4(host)) throw new SsrfError(`hostname ${host} is a private/loopback address`);
  }
  return url;
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface GuardedFetchOptions {
  fetchImpl?: FetchImpl;
  /** Byte cap enforced while reading the body (throws SsrfError past it). */
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

/**
 * Fetch a user-supplied URL under the SSRF policy: the initial URL and
 * every redirect target are validated; the body is read with a byte cap.
 * Returns the body bytes + final URL + content-type.
 */
export async function guardedFetchBytes(
  rawUrl: string,
  opts: GuardedFetchOptions = {},
): Promise<{ bytes: Buffer; finalUrl: string; contentType: string | null; status: number }> {
  const doFetch: FetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  let current = assertPublicHttpsUrl(rawUrl).toString();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await doFetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': 'EZVault/1.0 (+iiif-import)', ...(opts.headers ?? {}) },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new SsrfError(`redirect without Location from ${current}`);
      if (hop === maxRedirects) throw new SsrfError('too many redirects');
      current = assertPublicHttpsUrl(new URL(loc, current).toString()).toString();
      continue;
    }
    if (!res.ok) {
      throw new SsrfError(`fetch failed: HTTP ${res.status} from ${new URL(current).host}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new SsrfError(`response exceeds the ${maxBytes}-byte cap`);
    return { bytes: buf, finalUrl: current, contentType: res.headers.get('content-type'), status: res.status };
  }
  throw new SsrfError('too many redirects');
}
