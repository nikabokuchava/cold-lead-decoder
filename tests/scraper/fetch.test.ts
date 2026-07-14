import { isIP } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  assertSafeUrl,
  isBlockedIp,
  parseIPv6,
  safeFetch,
  type Fetcher,
  type Resolver,
} from "../../lib/scraper/fetch";

const v4 = (address: string): Resolver => async () => [address];
const v6 = (address: string): Resolver => async () => [address];
const vAll = (...addresses: string[]): Resolver => async () => addresses;

function makeFetcher(steps: Array<{ status: number; location?: string; body?: string }>): {
  fetcher: Fetcher;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const headers = new Headers();
    if (step.location) headers.set("location", step.location);
    return new Response(step.body ?? "", { status: step.status, headers });
  };
  return { fetcher, calls };
}

describe("isBlockedIp — IPv4 ranges from ADR-006 + CGNAT extension", () => {
  it.each([
    ["127.0.0.1", "loopback 127/8"],
    ["127.255.255.254", "loopback 127/8 upper"],
    ["10.0.0.1", "private 10/8"],
    ["10.255.255.255", "private 10/8 upper"],
    ["172.16.0.1", "private 172.16/12 lower"],
    ["172.31.255.255", "private 172.16/12 upper"],
    ["192.168.0.1", "private 192.168/16 lower"],
    ["192.168.255.255", "private 192.168/16 upper"],
    ["169.254.169.254", "link-local 169.254/16 (cloud metadata)"],
    ["100.64.0.1", "CGNAT 100.64/10 lower (ADR-006 extension)"],
    ["100.127.255.255", "CGNAT 100.64/10 upper"],
  ])("blocks %s — %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ["8.8.8.8", "public DNS"],
    ["1.1.1.1", "public DNS"],
    ["172.32.0.1", "just outside 172.16/12"],
    ["172.15.255.255", "just below 172.16/12"],
    ["100.128.0.1", "just outside CGNAT 100.64/10"],
    ["100.63.255.255", "just below CGNAT 100.64/10"],
    ["192.167.255.255", "just below 192.168/16"],
    ["192.169.0.1", "just above 192.168/16"],
  ])("allows %s — %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe("isBlockedIp — IPv6 ranges", () => {
  it.each([
    ["::1", "IPv6 loopback"],
    ["fc00::1", "IPv6 ULA fc00::/7 lower"],
    ["fd00::1", "IPv6 ULA fc00::/7 (fd-half)"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "IPv6 ULA upper"],
    ["fe80::1", "IPv6 link-local fe80::/10"],
    ["ff02::1", "IPv6 multicast ff00::/8"],
    ["::", "IPv6 unspecified"],
    ["::ffff:7f00:1", "IPv4-mapped loopback ::ffff:127.0.0.1"],
    ["::ffff:c0a8:101", "IPv4-mapped private ::ffff:192.168.1.1"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback, dotted-decimal notation"],
    ["::ffff:192.168.1.1", "IPv4-mapped private, dotted-decimal notation"],
  ])("blocks %s — %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    ["2606:4700:4700::1111", "Cloudflare public IPv6"],
    ["2001:4860:4860::8888", "Google public IPv6"],
    ["fe00::1", "just below fc00::/7"],
    ["2001:db8::1", "documentation prefix (not in a blocked range)"],
    ["::ffff:8.8.8.8", "IPv4-mapped public IP, dotted-decimal notation"],
  ])("allows %s — %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it.each([
    ["1:2:3:4:5:6:7:1zz", "trailing non-hex characters must not be truncated to a valid group"],
    ["1:2:3:4:5:6:7:1garbageA", "trailing garbage must not be truncated to a valid group"],
    ["::ffff:999.999.999.999", "invalid octets in an IPv4-mapped suffix"],
    ["::ffff:1.2.3", "incomplete IPv4-mapped suffix"],
  ])("does not treat %s as a valid IPv6 address (%s)", (ip) => {
    expect(parseIPv6(ip)).toBeNull();
  });
});

describe("parseIPv6 — zero-length :: compression must be rejected", () => {
  // RFC 4291: "::" MUST replace at least one group of zeros. A form that
  // already spells out all 8 groups and then appends/prepends an empty
  // "::" is not valid shorthand for anything — node:net.isIP agrees (0).
  it.each([
    ["1:2:3:4:5:6:7:8::", "all 8 groups spelled out plus a trailing zero-length ::"],
    ["::1:2:3:4:5:6:7:8", "all 8 groups spelled out plus a leading zero-length ::"],
  ])("rejects %s (%s)", (ip) => {
    expect(parseIPv6(ip)).toBeNull();
    expect(isIP(ip)).toBe(0);
  });

  it.each([
    ["1:2:3:4:5:6:7::", [1, 2, 3, 4, 5, 6, 7, 0]],
    ["::1:2:3:4:5:6:7", [0, 1, 2, 3, 4, 5, 6, 7]],
    ["::", [0, 0, 0, 0, 0, 0, 0, 0]],
    ["1::2", [1, 0, 0, 0, 0, 0, 0, 2]],
  ])("still accepts the valid boundary case %s", (ip, expected) => {
    expect(parseIPv6(ip)).toEqual(expected);
    expect(isIP(ip)).toBe(6);
  });

  it.each([
    "1:2:3:4:5:6:7:8",
    "1:2:3:4:5:6:7::",
    "::1:2:3:4:5:6:7",
    "::",
    "1::2",
    "::1",
    "1::",
    "2001:db8::1",
    "::ffff:1.2.3.4",
    "fe80::1",
  ])("agrees with node:net.isIP that %s is valid IPv6", (ip) => {
    expect(isIP(ip)).toBe(6);
    expect(parseIPv6(ip)).not.toBeNull();
  });

  it.each([
    "1:2:3:4:5:6:7:8::",
    "::1:2:3:4:5:6:7:8",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7",
    ":::",
    "1:2:3::4:5:6:7:8",
  ])("agrees with node:net.isIP that %s is invalid IPv6", (ip) => {
    expect(isIP(ip)).toBe(0);
    expect(parseIPv6(ip)).toBeNull();
  });

  it("existing IPv4-mapped IPv6 tests still pass with the fixed fill check", () => {
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6("::ffff:192.168.1.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x101]);
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("assertSafeUrl — literal hosts (no DNS needed)", () => {
  it("rejects http://127.0.0.1/", async () => {
    await expect(assertSafeUrl("http://127.0.0.1/", v4("127.0.0.1"))).rejects.toThrow();
  });

  it("rejects http://192.168.1.1/", async () => {
    await expect(assertSafeUrl("http://192.168.1.1/", v4("192.168.1.1"))).rejects.toThrow();
  });

  it("rejects https://[::1]/", async () => {
    await expect(assertSafeUrl("https://[::1]/", v6("::1"))).rejects.toThrow();
  });

  it("rejects file:// scheme", async () => {
    await expect(assertSafeUrl("file:///etc/passwd", v4("8.8.8.8"))).rejects.toThrow();
  });

  it("rejects gopher:// scheme", async () => {
    await expect(assertSafeUrl("gopher://example.com/", v4("8.8.8.8"))).rejects.toThrow();
  });

  it("rejects a malformed URL", async () => {
    await expect(assertSafeUrl("not a url", v4("8.8.8.8"))).rejects.toThrow();
  });
});

describe("assertSafeUrl — hostname resolution", () => {
  it("rejects localhost (resolver returns 127.0.0.1)", async () => {
    await expect(assertSafeUrl("http://localhost/", v4("127.0.0.1"))).rejects.toThrow();
  });

  it("allows a public hostname (resolver returns 8.8.8.8)", async () => {
    await expect(assertSafeUrl("https://example.com/", v4("8.8.8.8"))).resolves.toBeUndefined();
  });
});

describe("assertSafeUrl — DNS rebinding (public hostname → private IP)", () => {
  it("rejects when evil.example resolves to a private IP (10.0.0.5)", async () => {
    await expect(assertSafeUrl("http://evil.example/", v4("10.0.0.5"))).rejects.toThrow();
  });

  it("rejects when a public-looking hostname resolves to 169.254.169.254 (EC2 metadata)", async () => {
    await expect(
      assertSafeUrl("https://metadata-bypass.example/", v4("169.254.169.254")),
    ).rejects.toThrow();
  });

  it("propagates a typed lookup error when resolver throws ENOTFOUND", async () => {
    const resolver: Resolver = async () => {
      const err = new Error("getaddrinfo ENOTFOUND nonexistent.example") as Error & {
        code?: string;
      };
      err.code = "ENOTFOUND";
      throw err;
    };
    await expect(assertSafeUrl("https://nonexistent.example/", resolver)).rejects.toThrow(
      /ENOTFOUND|lookup/i,
    );
  });

  it("rejects when resolver returns multiple addresses and ANY is in a blocked range", async () => {
    // Multi-A-record rebinding: first record is public, second is private.
    // A single-address check would accept this; the guard must reject.
    await expect(
      assertSafeUrl("http://multi-a.example/", vAll("8.8.8.8", "10.0.0.1")),
    ).rejects.toThrow();
  });
});

describe("safeFetch — manual redirect with per-hop re-check", () => {
  it("rejects a 302 → http://internal.example/ that resolves to 10.0.0.5 (without reading the second body)", async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 302, location: "http://internal.example/" },
      { status: 200, body: "<should never be read>" },
    ]);
    const resolver = vi.fn<Resolver>(async (host: string) => {
      if (host === "good.example") return ["8.8.8.8"];
      if (host === "internal.example") return ["10.0.0.5"];
      throw new Error(`unexpected host ${host}`);
    });

    await expect(
      safeFetch("https://good.example/", { resolver, fetcher, maxRedirects: 3 }),
    ).rejects.toThrow();
    expect(calls).toEqual(["https://good.example/"]);
    expect(resolver).toHaveBeenCalledWith("internal.example");
  });

  it("rejects a 302 → http://169.254.169.254/latest/meta-data/", async () => {
    const { fetcher } = makeFetcher([
      { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
    ]);
    const resolver: Resolver = async (host) =>
      host === "169.254.169.254" ? ["169.254.169.254"] : ["8.8.8.8"];
    await expect(
      safeFetch("https://innocent.example/", { resolver, fetcher, maxRedirects: 3 }),
    ).rejects.toThrow();
  });

  it("rejects when the redirect chain exceeds maxRedirects (default 3)", async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 302, location: "https://a.example/" },
      { status: 302, location: "https://b.example/" },
      { status: 302, location: "https://c.example/" },
      { status: 302, location: "https://d.example/" },
      { status: 200, body: "unreachable" },
    ]);
    const resolver: Resolver = async () => ["8.8.8.8"];
    await expect(
      safeFetch("https://start.example/", { resolver, fetcher, maxRedirects: 3 }),
    ).rejects.toThrow(/redirect/i);
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it("follows a 302 → public host and returns the final 200 response", async () => {
    const { fetcher, calls } = makeFetcher([
      { status: 302, location: "https://final.example/" },
      { status: 200, body: "ok" },
    ]);
    const resolver: Resolver = async () => ["8.8.8.8"];
    const res = await safeFetch("https://start.example/", {
      resolver,
      fetcher,
      maxRedirects: 3,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(calls).toEqual(["https://start.example/", "https://final.example/"]);
  });
});

describe("safeFetch — ADR-003 hard caps", () => {
  it("aborts via AbortSignal after 8s timeout", async () => {
    vi.useFakeTimers();
    try {
      const resolver: Resolver = async () => ["8.8.8.8"];
      const fetcher: Fetcher = (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted") as Error & { name: string };
            err.name = "AbortError";
            reject(err);
          });
        });

      const promise = safeFetch("https://slow.example/", { resolver, fetcher });
      const expectation = expect(promise).rejects.toThrow(/timeout|abort/i);
      await vi.advanceTimersByTimeAsync(8001);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the body stream when bytes exceed 1.5 MB (no content-length)", async () => {
    const resolver: Resolver = async () => ["8.8.8.8"];
    const MAX_CHUNKS = 10;
    let chunksRead = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksRead >= MAX_CHUNKS) {
          controller.close();
          return;
        }
        chunksRead += 1;
        controller.enqueue(new Uint8Array(500_000));
      },
    });
    const fetcher: Fetcher = async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/html" } });

    await expect(
      safeFetch("https://big.example/", { resolver, fetcher }),
    ).rejects.toThrow(/body|size|limit|1\.?5/i);
    expect(chunksRead).toBeLessThan(MAX_CHUNKS);
  });

  it("sends the exact ADR-003 User-Agent header", async () => {
    const resolver: Resolver = async () => ["8.8.8.8"];
    const inits: RequestInit[] = [];
    const fetcher: Fetcher = async (_url, init) => {
      inits.push(init);
      return new Response("<html></html>", {
        status: 200,
        headers: { "content-length": "13", "content-type": "text/html" },
      });
    };

    await safeFetch("https://ua.example/", { resolver, fetcher });

    expect(inits).toHaveLength(1);
    const headers = new Headers(inits[0]?.headers);
    expect(headers.get("user-agent")).toBe(
      "Mozilla/5.0 (compatible; ColdLeadDecoder/1.0)",
    );
  });
});
