import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const pw = vi.hoisted(() => {
  const state = {
    routeThrows: false,
    handler: null as null | ((route: unknown) => Promise<void>),
    url: "https://example.com/",
    chain: [] as string[],
  };
  const page = {
    goto: vi.fn(async (u: string) => {
      state.url = u;
      if (u === "about:blank") return null;
      const hops = state.chain.length ? state.chain : [u];
      let req: { url: () => string; redirectedFrom: () => unknown } | null = null;
      for (let i = hops.length - 1; i >= 0; i--) {
        const prev: { url: () => string; redirectedFrom: () => unknown } | null = req;
        const hop = hops[i];
        req = { url: () => hop, redirectedFrom: () => prev };
      }
      state.url = hops[0];
      return { request: () => req };
    }),
    url: vi.fn(() => state.url),
    content: vi.fn(async () => "<html><head><title>T</title></head><body><h1>Hi</h1><a href='/p'>Pricing</a></body></html>"),
  };
  const ctx = {
    pages: () => [page],
    newPage: async () => page,
    route: vi.fn(async (_pattern: string, h: (route: unknown) => Promise<void>) => {
      if (state.routeThrows) throw new Error("route unsupported");
      state.handler = h;
    }),
  };
  const browser = { contexts: () => [ctx], newContext: async () => ctx, close: vi.fn(async () => {}) };
  const connectOverCDP = vi.fn(async () => browser);
  return { state, page, ctx, connectOverCDP };
});
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: pw.connectOverCDP } }));

import { checkBrowserRequestUrl, installNetworkGuard } from "../network-guard";
import { createRestAnchorClient, _setGuardLookupForTest } from "../anchor-rest-client";

const publicLookup = async (host: string) => (host === "rebind.test" ? ["10.0.0.5"] : ["93.184.216.34"]);

beforeEach(() => {
  pw.state.routeThrows = false;
  pw.state.handler = null;
  pw.state.chain = [];
  pw.page.goto.mockClear();
  pw.ctx.route.mockClear();
  _setGuardLookupForTest(publicLookup);
});
afterEach(() => _setGuardLookupForTest(undefined));

describe("checkBrowserRequestUrl", () => {
  it.each([
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.1.2.3/",
    "http://192.168.0.1/",
    "http://[::1]/",
    "http://localhost:3000/",
    "http://metadata.google.internal/",
    "http://printer.local/",
  ])("refuses private/loopback/link-local/metadata: %s", async (u) => {
    const v = await checkBrowserRequestUrl(u, publicLookup);
    expect(v.allowed).toBe(false);
  });

  it.each(["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)", "chrome://settings", "ws://example.com/"])(
    "refuses non-http(s) scheme: %s",
    async (u) => {
      const v = await checkBrowserRequestUrl(u, publicLookup);
      expect(v).toMatchObject({ allowed: false });
    },
  );

  it("refuses a hostname that resolves to a private address", async () => {
    expect((await checkBrowserRequestUrl("https://rebind.test/", publicLookup)).allowed).toBe(false);
  });

  it("fails closed when DNS fails", async () => {
    const v = await checkBrowserRequestUrl("https://nx.example/", async () => {
      throw new Error("ENOTFOUND");
    });
    expect(v).toEqual({ allowed: false, reason: "dns_failed" });
  });

  it("allows public http and https", async () => {
    expect((await checkBrowserRequestUrl("https://example.com/a", publicLookup)).allowed).toBe(true);
    expect((await checkBrowserRequestUrl("http://example.com/a", publicLookup)).allowed).toBe(true);
  });
});

describe("installNetworkGuard (route handler)", () => {
  it("aborts private requests and continues public ones", async () => {
    let handler: ((r: unknown) => Promise<void>) | null = null;
    const blocked: string[] = [];
    await installNetworkGuard(
      { route: async (_p, h) => void (handler = h as never) },
      { lookup: publicLookup, onBlock: (u) => blocked.push(u) },
    );
    const mk = (url: string) => ({ request: () => ({ url: () => url }), continue: vi.fn(async () => {}), abort: vi.fn(async () => {}) });
    const priv = mk("http://169.254.169.254/");
    const pub = mk("https://cdn.example.com/app.js");
    await handler!(priv);
    await handler!(pub);
    expect(priv.abort).toHaveBeenCalled();
    expect(priv.continue).not.toHaveBeenCalled();
    expect(pub.continue).toHaveBeenCalled();
    expect(blocked).toEqual(["http://169.254.169.254/"]);
  });
});

describe("anchor-rest-client with network_guard", () => {
  const SESSION = { id: "g1", cdp_url: "wss://anchor/g1", network_guard: true } as const;

  it("installs the guard on the context before any op", async () => {
    const c = createRestAnchorClient();
    const r = await c.runAction({ apiKey: "k", session: { ...SESSION, id: "g-install" }, op: { op: "nav", url: "https://example.com/" } });
    expect(r.ok).toBe(true);
    expect(pw.ctx.route).toHaveBeenCalledWith("**/*", expect.any(Function));
  });

  it("fails CLOSED when the guard cannot be installed: no navigation happens", async () => {
    pw.state.routeThrows = true;
    const c = createRestAnchorClient();
    const r = await c.runAction({ apiKey: "k", session: { ...SESSION, id: "g-fail" }, op: { op: "nav", url: "https://example.com/" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_message).toContain("network_guard_install_failed");
    expect(pw.page.goto).not.toHaveBeenCalled();
  });

  it("refuses a private first navigation without calling goto", async () => {
    const c = createRestAnchorClient();
    const r = await c.runAction({ apiKey: "k", session: { ...SESSION, id: "g-priv" }, op: { op: "nav", url: "http://169.254.169.254/" } });
    expect(r).toMatchObject({ ok: false, error_code: "nav_blocked_by_guard" });
    expect(pw.page.goto).not.toHaveBeenCalled();
  });

  it("refuses a redirect that landed on a private address and blanks the page", async () => {
    pw.state.chain = ["http://10.0.0.7/admin", "https://example.com/go"];
    const c = createRestAnchorClient();
    const r = await c.runAction({ apiKey: "k", session: { ...SESSION, id: "g-redir" }, op: { op: "nav", url: "https://example.com/go" } });
    expect(r).toMatchObject({ ok: false, error_code: "nav_blocked_by_guard" });
    expect(pw.page.goto).toHaveBeenLastCalledWith("about:blank");
  });

  it("page_outline returns a bounded outline built from the page HTML", async () => {
    const c = createRestAnchorClient();
    await c.runAction({ apiKey: "k", session: { ...SESSION, id: "g-outline" }, op: { op: "nav", url: "https://example.com/" } });
    const r = await c.runAction({ apiKey: "k", session: { ...SESSION, id: "g-outline" }, op: { op: "page_outline" } });
    expect(r.ok).toBe(true);
    const out = (r as { result: { title: string; headings: string[]; links: Array<{ href: string }> } }).result;
    expect(out.title).toBe("T");
    expect(out.headings).toEqual(["h1: Hi"]);
    expect(out.links[0].href).toBe("https://example.com/p");
  });
});
