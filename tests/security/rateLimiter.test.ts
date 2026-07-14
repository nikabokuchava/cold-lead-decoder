import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __getBucketLengthForTests,
  __getMaxBucketsForTests,
  __getStoreSize,
  __resetRateLimiterForTests,
  checkRateLimit,
  extractClientIp,
} from "../../lib/security/rateLimiter";

beforeEach(() => __resetRateLimiterForTests());
afterEach(() => __resetRateLimiterForTests());

describe("checkRateLimit (bucket enforcement)", () => {
  it("allows the first 5 requests from one identifier within the window", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit("1.2.3.4");
      expect(r.allowed).toBe(true);
    }
  });

  it("blocks the 6th request from the same identifier within the window", async () => {
    for (let i = 0; i < 5; i++) await checkRateLimit("1.2.3.4");
    const r = await checkRateLimit("1.2.3.4");
    expect(r.allowed).toBe(false);
  });

  it("tracks identifiers independently", async () => {
    for (let i = 0; i < 5; i++) await checkRateLimit("1.2.3.4");
    const other = await checkRateLimit("9.9.9.9");
    expect(other.allowed).toBe(true);
  });

  it("forgets requests older than the window (sliding behavior)", async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) await checkRateLimit("1.2.3.4", t0 + i);
    const stillBlocked = await checkRateLimit("1.2.3.4", t0 + 100);
    expect(stillBlocked.allowed).toBe(false);
    const afterWindow = await checkRateLimit("1.2.3.4", t0 + 60_001);
    expect(afterWindow.allowed).toBe(true);
  });

  it("[BUCKET CLEANUP] sweeps stale buckets after window expiry", async () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 10; i++) {
      await checkRateLimit(`ip-${i}`, t0);
    }
    await checkRateLimit("ip-new", t0 + 60_001);
    expect(__getStoreSize()).toBe(1);
  });
});

describe("checkRateLimit (bounded per-identifier storage)", () => {
  it("allows exactly the first MAX (5) requests", async () => {
    const t0 = 3_000_000;
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit("storm-ip", t0 + i);
      expect(r.allowed).toBe(true);
    }
    expect(__getBucketLengthForTests("storm-ip")).toBe(5);
  });

  it("blocks request MAX+1", async () => {
    const t0 = 3_100_000;
    for (let i = 0; i < 5; i++) await checkRateLimit("storm-ip-2", t0 + i);
    const r = await checkRateLimit("storm-ip-2", t0 + 5);
    expect(r.allowed).toBe(false);
  });

  it("[UNBOUNDED GROWTH] does not grow the stored timestamp count beyond MAX under a sustained storm of blocked requests", async () => {
    const t0 = 3_200_000;
    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit("storm-ip-3", t0 + i);
      expect(r.allowed).toBe(true);
    }
    for (let i = 0; i < 2000; i++) {
      const r = await checkRateLimit("storm-ip-3", t0 + 5 + i);
      expect(r.allowed).toBe(false);
      expect(__getBucketLengthForTests("storm-ip-3")).toBeLessThanOrEqual(5);
    }
    expect(__getBucketLengthForTests("storm-ip-3")).toBe(5);
  });

  it("[UNBOUNDED GROWTH] re-admits the client once the oldest accepted timestamps expire, even after thousands of blocked requests", async () => {
    const t0 = 3_300_000;
    for (let i = 0; i < 5; i++) await checkRateLimit("storm-ip-4", t0 + i);
    for (let i = 0; i < 3000; i++) {
      const r = await checkRateLimit("storm-ip-4", t0 + 5 + i);
      expect(r.allowed).toBe(false);
    }
    // +60_005 so every one of the 5 initial timestamps (t0..t0+4) has
    // fully aged out of the 60s window, not just the oldest one.
    const afterWindow = await checkRateLimit("storm-ip-4", t0 + 60_005);
    expect(afterWindow.allowed).toBe(true);
    expect(__getBucketLengthForTests("storm-ip-4")).toBe(1);
  });
});

describe("checkRateLimit (bounded identifier cardinality — RATE_LIMIT_MAX_BUCKETS)", () => {
  it("admits new identifiers while below the cap", async () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 100; i++) {
      const r = await checkRateLimit(`cap-ip-${i}`, t0);
      expect(r.allowed).toBe(true);
    }
    expect(__getStoreSize()).toBe(100);
  });

  it("[CARDINALITY] denies a brand-new identifier once the cap is reached, without allocating it a bucket", async () => {
    const t0 = 6_000_000;
    const cap = __getMaxBucketsForTests();
    for (let i = 0; i < cap; i++) {
      const r = await checkRateLimit(`fill-${i}`, t0);
      expect(r.allowed).toBe(true);
    }
    expect(__getStoreSize()).toBe(cap);

    const overflow = await checkRateLimit("overflow-ip", t0);
    expect(overflow.allowed).toBe(false);
    expect(__getStoreSize()).toBe(cap);
    expect(__getBucketLengthForTests("overflow-ip")).toBe(0);
  });

  it("[CARDINALITY] never lets the store size exceed the cap, and never evicts an active bucket to admit a new one", async () => {
    const t0 = 7_000_000;
    const cap = __getMaxBucketsForTests();
    for (let i = 0; i < cap; i++) await checkRateLimit(`active-${i}`, t0);
    for (let i = 0; i < 50; i++) {
      await checkRateLimit(`overflow-${i}`, t0);
    }
    expect(__getStoreSize()).toBe(cap);
    // Every originally-active identifier must still be tracked (not evicted).
    expect(__getBucketLengthForTests("active-0")).toBe(1);
    expect(__getBucketLengthForTests(`active-${cap - 1}`)).toBe(1);
  });

  it("[CARDINALITY] a stale-bucket sweep frees capacity for new identifiers after the window expires", async () => {
    const t0 = 8_000_000;
    const cap = __getMaxBucketsForTests();
    for (let i = 0; i < cap; i++) await checkRateLimit(`stale-${i}`, t0);
    expect(__getStoreSize()).toBe(cap);

    const t1 = t0 + 60_001;
    const r = await checkRateLimit("fresh-after-sweep", t1);
    expect(r.allowed).toBe(true);
    expect(__getStoreSize()).toBeLessThanOrEqual(cap);
  });
});

describe("extractClientIp", () => {
  const mk = (h: Record<string, string>) =>
    new Request("http://x/", { method: "POST", headers: h });

  it("[SPOOF] does not trust the leftmost x-forwarded-for entry as the identifier", () => {
    // An attacker can freely set their own leftmost value; only the
    // rightmost entry (the hop closest to this server) is trustworthy
    // absent a dedicated Vercel header.
    const result = extractClientIp(
      mk({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }),
    );
    expect(result).not.toBe("9.9.9.9");
    expect(result).toBe("1.2.3.4");
  });

  it("[SPOOF] a rotating attacker-supplied leftmost value does not create independent buckets", () => {
    const first = extractClientIp(
      mk({ "x-forwarded-for": "1.1.1.1, 5.5.5.5" }),
    );
    const second = extractClientIp(
      mk({ "x-forwarded-for": "2.2.2.2, 5.5.5.5" }),
    );
    expect(first).toBe(second);
    expect(first).toBe("5.5.5.5");
  });

  it("[PLATFORM] prefers x-vercel-forwarded-for over a plain x-forwarded-for", () => {
    expect(
      extractClientIp(
        mk({
          "x-vercel-forwarded-for": "9.9.9.9",
          "x-forwarded-for": "1.2.3.4",
        }),
      ),
    ).toBe("9.9.9.9");
  });

  it("[PLATFORM] falls back to x-real-ip when no forwarded-for header is present", () => {
    expect(extractClientIp(mk({ "x-real-ip": "7.7.7.7" }))).toBe("7.7.7.7");
  });

  it("[FALLBACK] returns 'unknown' when no IP headers are present", () => {
    expect(extractClientIp(mk({}))).toBe("unknown");
  });

  it("[FALLBACK] returns 'unknown' for an empty x-forwarded-for value", () => {
    expect(extractClientIp(mk({ "x-forwarded-for": "" }))).toBe("unknown");
  });

  it("[FALLBACK] returns 'unknown' for a malformed (non-IP) x-forwarded-for value", () => {
    expect(extractClientIp(mk({ "x-forwarded-for": "not-an-ip" }))).toBe(
      "unknown",
    );
  });

  it("[FALLBACK] returns 'unknown' for whitespace-only / trailing-comma segments", () => {
    expect(extractClientIp(mk({ "x-forwarded-for": " , ," }))).toBe(
      "unknown",
    );
  });

  it("[FALLBACK] falls through to x-real-ip when x-forwarded-for is malformed", () => {
    expect(
      extractClientIp(
        mk({ "x-forwarded-for": "not-an-ip", "x-real-ip": "7.7.7.7" }),
      ),
    ).toBe("7.7.7.7");
  });

  it("[MULTI-HOP] deterministically selects the rightmost entry among 3+ hops", () => {
    expect(
      extractClientIp(
        mk({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }),
      ),
    ).toBe("3.3.3.3");
  });

  it("[MULTI-HOP] ignores trailing empty segments and picks the last real entry", () => {
    expect(
      extractClientIp(mk({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, " })),
    ).toBe("5.6.7.8");
  });

  it("validates IPv6 addresses as well as IPv4", () => {
    expect(
      extractClientIp(mk({ "x-forwarded-for": "1.2.3.4, ::1" })),
    ).toBe("::1");
  });

  it("[SPOOF] rejects an IPv6-looking value with a garbage suffix rather than truncating and accepting it", () => {
    expect(
      extractClientIp(mk({ "x-forwarded-for": "1:2:3:4:5:6:7:1zz" })),
    ).toBe("unknown");
    expect(
      extractClientIp(
        mk({ "x-forwarded-for": "1:2:3:4:5:6:7:1garbageA" }),
      ),
    ).toBe("unknown");
  });

  it("[FALLBACK] rejects a forwarded-for entry with a port suffix", () => {
    expect(extractClientIp(mk({ "x-forwarded-for": "1.2.3.4:8080" }))).toBe(
      "unknown",
    );
  });

  it("accepts a valid IPv4-mapped IPv6 address in dotted-decimal form", () => {
    expect(
      extractClientIp(mk({ "x-forwarded-for": "9.9.9.9, ::ffff:1.2.3.4" })),
    ).not.toBe("unknown");
  });

  it("[SPOOF] rejects an IPv4-mapped IPv6 address with invalid embedded octets", () => {
    expect(
      extractClientIp(
        mk({ "x-forwarded-for": "9.9.9.9, ::ffff:999.999.999.999" }),
      ),
    ).toBe("unknown");
  });

  describe("[PLATFORM] x-vercel-forwarded-for edge cases", () => {
    it("falls through to x-forwarded-for when x-vercel-forwarded-for is malformed", () => {
      expect(
        extractClientIp(
          mk({
            "x-vercel-forwarded-for": "not-an-ip",
            "x-forwarded-for": "1.2.3.4",
          }),
        ),
      ).toBe("1.2.3.4");
    });

    it("selects the rightmost entry when x-vercel-forwarded-for has multiple values", () => {
      expect(
        extractClientIp(mk({ "x-vercel-forwarded-for": "9.9.9.9, 1.2.3.4" })),
      ).toBe("1.2.3.4");
    });
  });

  describe("[NORMALIZE] canonicalizes an IP so re-encoding it cannot mint a new bucket", () => {
    it("treats differently-cased/compressed IPv6 forms of the same address as identical", () => {
      const a = extractClientIp(mk({ "x-forwarded-for": "2001:DB8::1" }));
      const b = extractClientIp(
        mk({ "x-forwarded-for": "2001:db8:0:0:0:0:0:1" }),
      );
      expect(a).toBe(b);
    });

    it("treats an IPv4 address with and without a leading zero as identical", () => {
      const a = extractClientIp(mk({ "x-forwarded-for": "10.0.0.1" }));
      const b = extractClientIp(mk({ "x-forwarded-for": "010.0.0.1" }));
      expect(a).toBe(b);
    });

    it("[SPOOF] a client cannot obtain extra quota by re-encoding its own IP address", async () => {
      for (let i = 0; i < 5; i++) {
        await checkRateLimit(extractClientIp(mk({ "x-forwarded-for": "2001:DB8::1" })));
      }
      const sameClientReencoded = await checkRateLimit(
        extractClientIp(mk({ "x-forwarded-for": "2001:db8:0:0:0:0:0:1" })),
      );
      expect(sameClientReencoded.allowed).toBe(false);
    });

    it("never collapses two genuinely different real IPv6 addresses into the same identifier", () => {
      const a = extractClientIp(mk({ "x-forwarded-for": "2001:db8::1" }));
      const b = extractClientIp(mk({ "x-forwarded-for": "2001:db8::2" }));
      expect(a).not.toBe(b);
    });

    it("never collapses two genuinely different real IPv4 addresses into the same identifier", () => {
      const a = extractClientIp(mk({ "x-forwarded-for": "010.0.0.1" }));
      const b = extractClientIp(mk({ "x-forwarded-for": "010.0.0.2" }));
      expect(a).not.toBe(b);
    });
  });
});
