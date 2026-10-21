// SPDX-License-Identifier: MIT
/**
 * lib/fetch-guard.ts — SSRF guard for server-side fetches of USER-SUPPLIED
 * URLs (Wave D, row 26 — IIIF manifest + canvas image harvest; reused by
 * the Omeka client for response discipline).
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
 * IP-literal coverage (Wave D fix B2 + B2-R round 2): IPv6 literals are
 * EXPANDED to their 8 groups before range checks, so the canonical hex
 * forms WHATWG URL parsing produces are what get checked —
 * `[::ffff:127.0.0.1]` canonicalizes to `[::ffff:7f00:1]`, and a
 * dotted-tail-only check never fires on it. Embedded-IPv4 forms are
 * unwrapped and the embedded address is run through the full IPv4 range
 * checks: IPv4-mapped ::ffff:0:0/96, IPv4-translated ::ffff:0:0:0/96
 * (RFC 6052/7915 SIIT), the deprecated IPv4-compatible ::/96, NAT64
 * 64:ff9b::/96 (well-known) and 64:ff9b:1::/48 (local-use, both the
 * contiguous and the RFC 6052 u-octet-split embeddings), 6to4
 * 2002::/16, Teredo 2001::/32 (server IPv4 stored plain; the client
 * IPv4 in the interface identifier is XOR-obfuscated and is decoded
 * before checking), and ISATAP (interface identifier 0000:5efe:<IPv4>
 * on any prefix). An IPv6 literal that cannot be parsed is refused
 * (fail closed).
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

/** Range checks over 4 octets: private / loopback / link-local / reserved. */
function ipv4OctetsPrivate(o: number[]): boolean {
  const [a, b, c] = o;
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (cloud metadata)
  if (a === 0) return true; // "this network" 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 192 && b === 0 && c === 0) return true; // IETF special-purpose 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // documentation TEST-NET-1 192.0.2.0/24
  if (a === 198 && b === 51 && c === 100) return true; // documentation TEST-NET-2 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // documentation TEST-NET-3 203.0.113.0/24
  if (a >= 240) return true; // reserved 240.0.0.0/4
  return false;
}

/** True for private / loopback / link-local / reserved IPv4 ranges. */
export function isPrivateIpv4(host: string): boolean {
  const o = ipv4Octets(host);
  if (!o) return false;
  return ipv4OctetsPrivate(o);
}

/**
 * Expand an IPv6 literal to its 8 16-bit groups, or null when unparseable.
 * Handles `::` compression and an embedded dotted-IPv4 tail (which is
 * first rewritten to its two hex groups).
 */
export function expandIpv6(host: string): number[] | null {
  let h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const v4 = /(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (v4) {
    const o = ipv4Octets(v4[1]);
    if (!o) return null;
    const hi = (((o[0] as number) << 8) | (o[1] as number)).toString(16);
    const lo = (((o[2] as number) << 8) | (o[3] as number)).toString(16);
    h = h.slice(0, h.length - v4[1].length) + hi + ':' + lo;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const parseSide = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = parseSide(halves[0] as string);
  const right = halves.length === 2 ? parseSide(halves[1] as string) : [];
  if (left === null || right === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/** The IPv4 address embedded in groups `hi`/`lo` (two 16-bit groups). */
function embeddedIpv4Private(hi: number, lo: number): boolean {
  return ipv4OctetsPrivate([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
}

/**
 * True for private / loopback / link-local IPv6 literals (brackets
 * stripped), INCLUDING addresses that embed a private IPv4 address
 * (mapped / translated / compatible / NAT64 / 6to4 / Teredo / ISATAP
 * forms, dotted or canonical hex).
 * Unparseable literals fail closed (true).
 */
export function isPrivateIpv6(host: string): boolean {
  const g = expandIpv6(host);
  if (!g) return true; // fail closed: a literal we cannot parse is not fetched
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  // Embedded-IPv4 forms: unwrap and apply the full IPv4 range checks.
  // The ::-rooted families share the first four groups; the position of
  // the 0xffff marker (group 5 vs group 4) distinguishes mapped from
  // translated — both embed the IPv4 in the last 32 bits. A dotted tail
  // reaches the same expanded groups: expandIpv6 rewrites it to its two
  // hex groups first, and WHATWG URL parsing canonicalizes it likewise,
  // so the g5/g4 marker checks below fire for dotted spellings too.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) {
    if (g4 === 0 && g5 === 0xffff) return embeddedIpv4Private(g6, g7); // ::ffff:0:0/96 IPv4-mapped
    if (g4 === 0xffff && g5 === 0) return embeddedIpv4Private(g6, g7); // ::ffff:0:0:0/96 IPv4-translated (SIIT)
    if (g4 === 0 && g5 === 0) return embeddedIpv4Private(g6, g7); // ::/96 IPv4-compatible (covers ::1)
  }
  if (g0 === 0x0064 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0) return embeddedIpv4Private(g6, g7); // 64:ff9b::/96 NAT64 well-known
    if (g2 === 0x0001) {
      // 64:ff9b:1::/48 local NAT64. RFC 6052 splits the embedded IPv4
      // around the reserved "u" octet (bits 64–71): octets are
      // [g3 hi, g3 lo, g4 lo, g5 hi]. The contiguous reading
      // [g3, g4] is what other stacks emit, so check BOTH decodings —
      // a private target under either reading is rejected.
      return (
        embeddedIpv4Private(g3, g4) ||
        ipv4OctetsPrivate([g3 >> 8, g3 & 0xff, g4 & 0xff, g5 >> 8])
      );
    }
  }
  if (g0 === 0x2002) return embeddedIpv4Private(g1, g2); // 2002::/16 6to4 (site IPv4, stored plain)
  if (g0 === 0x2001 && g1 === 0x0000) {
    // 2001::/32 Teredo. The server IPv4 (g2, g3) is stored plain. The
    // client IPv4 in the interface identifier (g6, g7) is XOR-obfuscated
    // with all-ones (RFC 4380): it must be DECODED before range-checking
    // — checking the raw bits would both miss private clients (127.0.0.1
    // obfuscates to 80ff:fffe) and false-flag public ones (8.8.8.8
    // obfuscates to f7f7:f7f7, raw-reserved 240/4). An all-zero client
    // field carries no client target (it would decode to the broadcast
    // address), so it is not checked.
    if (embeddedIpv4Private(g2, g3)) return true;
    if (g6 !== 0 || g7 !== 0) return embeddedIpv4Private(g6 ^ 0xffff, g7 ^ 0xffff);
    return false;
  }
  // ISATAP (RFC 5214): the interface identifier 0000:5efe:<IPv4> marks
  // an embedded IPv4 on ANY prefix, so this is checked after every
  // prefix-specific family above has had its say.
  if (g4 === 0x0000 && g5 === 0x5efe) return embeddedIpv4Private(g6, g7);
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
  /** Byte cap enforced WHILE streaming the body (read aborts past it). */
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Abort the request after this many milliseconds (per hop). */
  timeoutMs?: number;
}

/**
 * Read a response body with the byte cap enforced WHILE streaming: the
 * read is aborted the moment the running total passes the cap, so peak
 * memory is bounded by the cap plus one chunk — not by the full body.
 * Falls back to a post-read check only when the response exposes no
 * readable stream (some mocked/minimal Response implementations).
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new SsrfError(`response exceeds the ${maxBytes}-byte cap`);
    return buf;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SsrfError(`response exceeds the ${maxBytes}-byte cap`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks, total);
}

/**
 * Fetch a user-supplied URL under the SSRF policy: the initial URL and
 * every redirect target are validated; the body is read with a streaming
 * byte cap. Returns the body bytes + final URL + content-type.
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
    const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
    const res = await doFetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': 'EZVault/1.0 (+iiif-import)', ...(opts.headers ?? {}) },
      ...(signal ? { signal } : {}),
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
    const buf = await readBodyCapped(res, maxBytes);
    return { bytes: buf, finalUrl: current, contentType: res.headers.get('content-type'), status: res.status };
  }
  throw new SsrfError('too many redirects');
}
