import { isIPv4Literal, parseIPv6 } from "../scraper/fetch";

type Bucket = number[];

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX = envInt("RATE_LIMIT_MAX", 5);
const WINDOW_MS = envInt("RATE_LIMIT_WINDOW_MS", 60_000);
const MAX_BUCKETS = envInt("RATE_LIMIT_MAX_BUCKETS", 10_000);

export interface RateLimitResult {
  allowed: boolean;
}

export async function checkRateLimit(
  identifier: string,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const cutoff = now - WINDOW_MS;
  if (now - lastSweep > WINDOW_MS) {
    for (const [key, timestamps] of buckets.entries()) {
      if (timestamps.every((t) => t <= cutoff)) buckets.delete(key);
    }
    lastSweep = now;
  }

  const existing = buckets.get(identifier);
  if (existing === undefined && buckets.size >= MAX_BUCKETS) {
    // Fail closed: deny a brand-new identifier rather than evict an
    // active bucket to make room for it.
    return { allowed: false };
  }

  // Only ever store the MAX accepted timestamps needed to enforce the
  // sliding window; a client that keeps getting blocked must not grow
  // this array further.
  const fresh = (existing ?? []).filter((t) => t > cutoff);
  const allowed = fresh.length < MAX;
  if (allowed) fresh.push(now);
  buckets.set(identifier, fresh);
  return { allowed };
}

export function __resetRateLimiterForTests(): void {
  buckets.clear();
  lastSweep = 0;
}

export function __getStoreSize(): number {
  return buckets.size;
}

export function __getBucketLengthForTests(identifier: string): number {
  return buckets.get(identifier)?.length ?? 0;
}

export function __getMaxBucketsForTests(): number {
  return MAX_BUCKETS;
}

function isValidIp(value: string): boolean {
  return isIPv4Literal(value) || parseIPv6(value) !== null;
}

// Recompresses parsed IPv6 groups per RFC 5952 (lowercase, no leading
// zeros, longest run of zero groups replaced by "::"), so differently
// cased/expanded textual forms of the same address collapse to one string.
function compressIPv6(groups: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  const before = hex.slice(0, bestStart);
  const after = hex.slice(bestStart + bestLen);
  return `${before.join(":")}::${after.join(":")}`;
}

// Canonicalizes a validated IP so that re-encoding the same address
// (leading zeros, hex case, "::" compression style) cannot mint a new
// rate-limiter bucket for what is really one client.
function canonicalIp(value: string): string {
  if (isIPv4Literal(value)) {
    return value
      .split(".")
      .map((n) => String(Number(n)))
      .join(".");
  }
  const groups = parseIPv6(value);
  return groups ? compressIPv6(groups) : value;
}

// Given a (possibly comma-separated) forwarded-for style header value,
// return its rightmost non-empty, syntactically valid IP (canonicalized),
// or null. The rightmost entry is the one appended by the hop closest to
// this server; earlier entries are attacker-prependable and never trusted.
function rightmostValidIp(headerValue: string): string | null {
  const candidate = headerValue
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .pop();
  return candidate && isValidIp(candidate) ? canonicalIp(candidate) : null;
}

/**
 * Platform assumption (Vercel, this project's stated deploy target): per
 * Vercel's documented request-header behavior
 * (https://vercel.com/docs/headers/request-headers), Vercel's edge
 * overwrites `x-forwarded-for` and does not forward externally-supplied
 * values, but `x-vercel-forwarded-for` is documented as remaining accurate
 * even if a proxy in front of Vercel rewrites `x-forwarded-for` -- so it is
 * checked first. `x-real-ip` is documented as identical to `x-forwarded-for`.
 *
 * This trust is a documented ASSUMPTION, not something verified at runtime:
 * there is no reliable, unconditionally-available signal (Vercel's `VERCEL`
 * env var is only exposed when a project opts in to "System Environment
 * Variables") that this code is actually running behind Vercel's real edge.
 * If it ever runs elsewhere -- local dev, a non-Vercel host, or exposed
 * directly with no reverse proxy in front at all -- every one of these
 * headers, including `x-vercel-forwarded-for`, must be treated as fully
 * attacker-controlled, and "rightmost entry" carries no more trust than
 * "leftmost entry" when there is no proxy actually appending a real hop.
 * For environments where the platform guarantee DOES hold, only the
 * rightmost `x-forwarded-for` entry is ever trusted -- never the leftmost,
 * which a client can freely set to rotate through unlimited fake identities.
 * Every candidate is validated as a syntactically real IP and canonicalized
 * (so re-encoding the same address can't mint a new bucket) before use;
 * anything else falls through to "unknown" rather than being used as a
 * rate-limiter bucket key.
 */
export function extractClientIp(req: Request): string {
  const vercelFwd = req.headers.get("x-vercel-forwarded-for");
  if (vercelFwd) {
    const ip = rightmostValidIp(vercelFwd);
    if (ip) return ip;
  }
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const ip = rightmostValidIp(fwd);
    if (ip) return ip;
  }
  const real = req.headers.get("x-real-ip");
  if (real) {
    const trimmed = real.trim();
    if (isValidIp(trimmed)) return canonicalIp(trimmed);
  }
  return "unknown";
}
