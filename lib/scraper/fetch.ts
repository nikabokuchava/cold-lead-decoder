import { promises as dns } from "node:dns";

const TIMEOUT_MS = 8000;
const BODY_LIMIT_BYTES = 1_500_000;
const USER_AGENT = "Mozilla/5.0 (compatible; ColdLeadDecoder/1.0)";

export class SSRFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SSRFBlockedError";
  }
}

export type Resolver = (host: string) => Promise<string[]>;

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface SafeFetchOpts {
  resolver?: Resolver;
  fetcher?: Fetcher;
  maxRedirects?: number;
}

const defaultResolver: Resolver = async (host) => {
  const safeResolve = async (
    fn: (h: string) => Promise<string[]>,
  ): Promise<string[]> => {
    try {
      return await fn(host);
    } catch (err) {
      const code = (err as { code?: string }).code;
      // ENODATA: host has no records of this family (common: A-only or AAAA-only hosts).
      // ENOTFOUND on a per-family resolve also means "no records of this type" in some
      // resolver implementations; tolerate it here and let the combined empty result
      // throw a single synthesized DNS-lookup-failed error below.
      if (code === "ENODATA" || code === "ENOTFOUND") return [];
      throw err;
    }
  };
  const [v4Addrs, v6Addrs] = await Promise.all([
    safeResolve(dns.resolve4),
    safeResolve(dns.resolve6),
  ]);
  const all = [...v4Addrs, ...v6Addrs];
  if (all.length === 0) {
    const err = new Error("no addresses") as Error & { code?: string };
    err.code = "ENODATA";
    throw err;
  }
  return all;
};

const defaultFetcher: Fetcher = (url, init) => fetch(url, init);

export function isIPv4Literal(s: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return false;
  return s.split(".").every((n) => {
    const v = Number(n);
    return Number.isInteger(v) && v >= 0 && v <= 255;
  });
}

function isBlockedIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4) return false;
  if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (p[0] === 127) return true;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  return false;
}

const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

// A trailing dotted-decimal segment (e.g. the "1.2.3.4" in "::ffff:1.2.3.4")
// is a valid RFC 4291 IPv4-mapped/compatible suffix; expand it into the two
// 16-bit hex groups it represents, or return null if it isn't a real IPv4.
function expandTrailingIPv4(segments: string[]): string[] | null {
  if (segments.length === 0) return segments;
  const last = segments[segments.length - 1];
  if (!last.includes(".")) return segments;
  if (!isIPv4Literal(last)) return null;
  const octets = last.split(".").map(Number);
  const hi = ((octets[0] << 8) | octets[1]).toString(16);
  const lo = ((octets[2] << 8) | octets[3]).toString(16);
  return [...segments.slice(0, -1), hi, lo];
}

export function parseIPv6(ip: string): number[] | null {
  if (!ip.includes(":")) return null;
  if (ip.includes(":::")) return null;
  const doubleColonCount = (ip.match(/::/g) ?? []).length;
  if (doubleColonCount > 1) return null;
  let parts: string[];
  if (doubleColonCount === 0) {
    const expanded = expandTrailingIPv4(ip.split(":"));
    if (!expanded || expanded.length !== 8) return null;
    parts = expanded;
  } else {
    const [headStr, tailStr] = ip.split("::");
    const head = headStr ? headStr.split(":") : [];
    const tail = expandTrailingIPv4(tailStr ? tailStr.split(":") : []);
    if (!tail) return null;
    const fill = 8 - head.length - tail.length;
    // "::" must replace at least one zero group (RFC 4291); fill === 0
    // would mean it replaced nothing, which node:net.isIP also rejects.
    if (fill <= 0) return null;
    parts = [...head, ...Array(fill).fill("0"), ...tail];
  }
  // Every group must be 1-4 hex digits and nothing else -- parseInt alone
  // would silently truncate a group like "1zz" or "1garbageA" to a valid-
  // looking number instead of rejecting it.
  if (!parts.every((g) => HEX_GROUP.test(g))) return null;
  return parts.map((g) => parseInt(g, 16));
}

function isBlockedIPv6(ip: string): boolean {
  const groups = parseIPv6(ip);
  if (!groups) return false;
  // ::1 (loopback)
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  // fc00::/7 — first 7 bits of first byte equal 0b1111110
  const firstByte = (groups[0] >> 8) & 0xff;
  if ((firstByte & 0xfe) === 0xfc) return true;
  // fe80::/10 (link-local)
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  // ff00::/8 (multicast)
  if ((groups[0] >> 8) === 0xff) return true;
  // :: (unspecified, all-zeros)
  if (groups.every((g) => g === 0)) return true;
  // IPv4-mapped (::ffff:x.x.x.x in pure hex) -> validate the embedded IPv4
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    if (isBlockedIPv4(v4)) return true;
  }
  return false;
}

export function isBlockedIp(ip: string): boolean {
  if (isIPv4Literal(ip)) return isBlockedIPv4(ip);
  if (ip.includes(":")) return isBlockedIPv6(ip);
  return false;
}

export async function assertSafeUrl(
  url: string,
  resolver: Resolver = defaultResolver,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SSRFBlockedError(`Blocked URL scheme: ${parsed.protocol}`);
  }
  let host = parsed.hostname;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (isIPv4Literal(host) || parseIPv6(host) !== null) {
    if (isBlockedIp(host)) throw new SSRFBlockedError(`Blocked IP literal: ${host}`);
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch (err) {
    const code = (err as { code?: string }).code;
    const reason = code ?? (err instanceof Error ? err.message : String(err));
    throw new SSRFBlockedError(`DNS lookup failed (${reason}): ${host}`);
  }
  if (addresses.length === 0) {
    throw new SSRFBlockedError(`DNS lookup failed (no addresses): ${host}`);
  }
  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new SSRFBlockedError(`Blocked IP from DNS: ${host} → ${address}`);
    }
  }
}

async function enforceBodyLimit(res: Response): Promise<Response> {
  if (!res.body) return res;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > BODY_LIMIT_BYTES) {
        await reader.cancel();
        throw new Error(
          `Response body exceeds size limit (${total} > ${BODY_LIMIT_BYTES})`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buffer.set(c, offset);
    offset += c.byteLength;
  }
  return new Response(buffer, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

export async function safeFetch(url: string, opts: SafeFetchOpts = {}): Promise<Response> {
  const resolver = opts.resolver ?? defaultResolver;
  const fetcher = opts.fetcher ?? defaultFetcher;
  const maxRedirects = opts.maxRedirects ?? 3;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let currentUrl = url;
    let redirects = 0;

    while (true) {
      await assertSafeUrl(currentUrl, resolver);
      const res = await fetcher(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT },
      });
      const isRedirect = res.status >= 300 && res.status < 400 && res.status !== 304;
      if (isRedirect) {
        const location = res.headers.get("location");
        if (!location) return res;
        if (redirects >= maxRedirects) {
          throw new Error(`Too many redirects (max ${maxRedirects})`);
        }
        redirects += 1;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      const lenHeader = res.headers.get("content-length");
      if (lenHeader !== null) {
        const n = Number(lenHeader);
        if (Number.isFinite(n) && n > BODY_LIMIT_BYTES) {
          throw new Error(
            `Response body exceeds size limit (content-length ${n} > ${BODY_LIMIT_BYTES})`,
          );
        }
      }
      return await enforceBodyLimit(res);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
