import { describe, it, expect, vi } from "vitest";
import { pinnedGet, pinnedLookup, siteBuilderFor, withDeadline, type SiteBuilderDeps } from "../site-builder";
import { builderFromPage } from "../site-builder-markers";

describe("builderFromPage", () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ["wordpress", '<link rel="stylesheet" href="/wp-content/themes/x/style.css">', {}],
    ["wordpress", '<meta name="generator" content="WordPress 6.5">', {}],
    ["webflow", '<html data-wf-site="65ab" data-wf-page="1">', {}],
    ["shopify", '<script src="https://cdn.shopify.com/s/files/theme.js"></script>', {}],
    ["squarespace", '<script src="https://static1.squarespace.com/static/x.js"></script>', {}],
    ["wix", "<img src='https://static.wixstatic.com/media/a.jpg'>", {}],
    ["wix", "<html></html>", { "X-Wix-Request-Id": "abc" }],
    ["framer", '<img src="https://framerusercontent.com/images/a.png">', {}],
    ["unknown", "<html><body>Hand-made site</body></html>", { server: "nginx" }],
  ];
  for (const [want, html, headers] of cases)
    it(`${want}: ${html.slice(0, 40)}`, () => expect(builderFromPage(html, headers)).toBe(want));
});

describe("pinnedLookup", () => {
  const call = (resolve: ReturnType<typeof vi.fn>, host: string, opts: object = {}) =>
    new Promise<{ err: unknown; addr?: unknown; family?: unknown }>((ok) =>
      pinnedLookup(resolve as never)(host, opts as never, ((err: unknown, addr?: unknown, family?: unknown) =>
        ok({ err, addr, family })) as never),
    );

  it("connects to the public address it approved", async () => {
    const resolve = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const r = await call(resolve, "example.com");
    expect(r.err).toBeNull();
    expect(r.addr).toBe("93.184.216.34");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("example.com", { all: true });
  });

  it("refuses an answer that contains any private address (metadata, loopback, RFC1918)", async () => {
    for (const bad of ["169.254.169.254", "127.0.0.1", "10.0.0.5", "::1"]) {
      const resolve = vi.fn().mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: bad, family: bad.includes(":") ? 6 : 4 },
      ]);
      const r = await call(resolve, "rebind.example");
      expect((r.err as { code?: string })?.code).toBe("ESSRFBLOCKED");
    }
  });

  it("refuses a literal private IP without any DNS", async () => {
    const resolve = vi.fn();
    const r = await call(resolve, "169.254.169.254");
    expect((r.err as { code?: string })?.code).toBe("ESSRFBLOCKED");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("hands back every approved address when the socket asks for all", async () => {
    const addrs = [{ address: "93.184.216.34", family: 4 }];
    const r = await call(vi.fn().mockResolvedValue(addrs), "example.com", { all: true });
    expect(r.addr).toEqual(addrs);
  });
});

describe("siteBuilderFor", () => {
  const NOW = Date.parse("2026-09-24T12:00:00Z");
  const deps = (o: Partial<SiteBuilderDeps> = {}): SiteBuilderDeps => ({
    now: () => NOW,
    readStored: vi.fn().mockResolvedValue({ builder: null, checked_at: null }),
    writeStored: vi.fn().mockResolvedValue(undefined),
    zaviHosts: vi.fn().mockResolvedValue([]),
    website: vi.fn().mockResolvedValue("acme.example"),
    fetchPage: vi.fn().mockResolvedValue({ html: '<meta name="generator" content="WordPress">', headers: {} }),
    ...o,
  });

  it("never checked: fetches the https site once, saves and returns the builder", async () => {
    const d = deps();
    expect(await siteBuilderFor("t1", d)).toBe("wordpress");
    expect(d.fetchPage).toHaveBeenCalledWith("https://acme.example/", expect.any(AbortSignal));
    expect(d.writeStored).toHaveBeenCalledWith("t1", { builder: "wordpress", checked_at: "2026-09-24T12:00:00.000Z" });
  });

  it("an http website is upgraded to https before the fetch", async () => {
    const d = deps({ website: vi.fn().mockResolvedValue("http://acme.example/about") });
    await siteBuilderFor("t1", d);
    expect(d.fetchPage).toHaveBeenCalledWith("https://acme.example/about", expect.any(AbortSignal));
  });

  it("a fresh saved answer is used without fetching", async () => {
    const d = deps({ readStored: vi.fn().mockResolvedValue({ builder: "shopify", checked_at: "2026-09-10T00:00:00Z" }) });
    expect(await siteBuilderFor("t1", d)).toBe("shopify");
    expect(d.fetchPage).not.toHaveBeenCalled();
  });

  it("a known answer older than 30 days is re-checked; unknown is retried after a day", async () => {
    const stale = deps({ readStored: vi.fn().mockResolvedValue({ builder: "shopify", checked_at: "2026-08-01T00:00:00Z" }) });
    expect(await siteBuilderFor("t1", stale)).toBe("wordpress");
    const unknownYesterday = deps({ readStored: vi.fn().mockResolvedValue({ builder: "unknown", checked_at: "2026-09-23T00:00:00Z" }) });
    await siteBuilderFor("t1", unknownYesterday);
    expect(unknownYesterday.fetchPage).toHaveBeenCalled();
    const unknownRecent = deps({ readStored: vi.fn().mockResolvedValue({ builder: "unknown", checked_at: "2026-09-24T06:00:00Z" }) });
    await siteBuilderFor("t1", unknownRecent);
    expect(unknownRecent.fetchPage).not.toHaveBeenCalled();
  });

  it("a site Zavi hosts is 'zavi' with no fetch", async () => {
    const d = deps({
      website: vi.fn().mockResolvedValue("https://www.acme-x1.zaviagent.com"),
      zaviHosts: vi.fn().mockResolvedValue(["acme-x1.zaviagent.com"]),
    });
    expect(await siteBuilderFor("t1", d)).toBe("zavi");
    expect(d.fetchPage).not.toHaveBeenCalled();
  });

  it("any failure is unknown, saved, and never thrown", async () => {
    for (const o of [
      { fetchPage: vi.fn().mockRejectedValue(new Error("blocked address")) },
      { website: vi.fn().mockResolvedValue(null) },
      { website: vi.fn().mockResolvedValue("::not a url::") },
      { zaviHosts: vi.fn().mockRejectedValue(new Error("db down")) },
    ]) {
      const d = deps(o);
      expect(await siteBuilderFor("t1", d)).toBe("unknown");
      expect(d.writeStored).toHaveBeenCalledWith("t1", expect.objectContaining({ builder: "unknown" }));
    }
    const failsToSave = deps({ writeStored: vi.fn().mockRejectedValue(new Error("x")) });
    expect(await siteBuilderFor("t1", failsToSave)).toBe("wordpress");
  });
});

describe("one absolute deadline", () => {
  it("a fetch that never finishes is aborted at the deadline and the builder is unknown", async () => {
    let aborted = false;
    const d: SiteBuilderDeps = {
      now: () => Date.parse("2026-09-24T12:00:00Z"),
      readStored: async () => ({ builder: null, checked_at: null }),
      writeStored: vi.fn(async () => undefined),
      zaviHosts: async () => [],
      website: async () => "slow.example",
      fetchPage: (_u, signal) =>
        new Promise(() => {
          signal.addEventListener("abort", () => (aborted = true));
        }),
      deadlineMs: 30,
    };
    const t0 = Date.now();
    expect(await siteBuilderFor("t1", d)).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(aborted).toBe(true);
  });

  it("withDeadline passes a fast result through", async () => {
    expect(await withDeadline(1000, async () => 7)).toBe(7);
  });
});

describe("pinnedGet", () => {
  it("refuses plain http and never connects", async () => {
    const lookup = vi.fn();
    await expect(pinnedGet("http://example.com/", undefined, lookup as never)).rejects.toThrow(/https only/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("connects through the pinned lookup, so a blocked answer fails the request", async () => {
    const resolve = vi.fn().mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await expect(pinnedGet("https://rebind.example/", undefined, pinnedLookup(resolve as never))).rejects.toThrow(/blocked address/);
    expect(resolve).toHaveBeenCalledWith("rebind.example", { all: true });
  });

  it("a literal private IP is refused before connecting (Node skips lookup for an IP)", async () => {
    for (const u of ["https://10.0.0.5/", "https://169.254.169.254/latest/meta-data/", "https://127.0.0.1:8443/", "https://[::1]/"]) {
      const lookup = vi.fn();
      await expect(pinnedGet(u, undefined, lookup as never), u).rejects.toThrow(/blocked address/);
      expect(lookup).not.toHaveBeenCalled();
    }
  });

  it("an aborted signal stops it before connecting", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const lookup = vi.fn();
    await expect(pinnedGet("https://example.com/", ctl.signal, lookup as never)).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });
});
