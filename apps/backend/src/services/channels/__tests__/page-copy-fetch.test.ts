
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";

const https = vi.hoisted(() => ({ opts: [] as Array<Record<string, unknown>>, chunks: [] as Buffer[], headers: {} as Record<string, string>, status: 200, drip: false }));
vi.mock("node:https", () => ({
  request: (opts: Record<string, unknown>, onRes: (res: EventEmitter & Record<string, unknown>) => void) => {
    https.opts.push(opts);
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
    let timer: ReturnType<typeof setInterval> | null = null;
    req.destroy = () => { if (timer) clearInterval(timer); req.emit("close"); };
    req.end = () => {
      if (https.drip) {
        const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
        res.statusCode = 200; res.headers = {}; res.resume = () => undefined; res.destroy = () => { if (timer) clearInterval(timer); };
        onRes(res);
        timer = setInterval(() => res.emit("data", Buffer.from("x")), 20);
        return;
      }
      const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
      res.statusCode = https.status;
      res.headers = https.headers;
      res.resume = () => undefined;
      let destroyed = false;
      res.destroy = () => { destroyed = true; };
      onRes(res);
      for (const c of https.chunks) { if (destroyed) return; res.emit("data", c); }
      if (!destroyed) res.emit("end");
    };
    return req;
  },
  default: {},
}));

import { PAGE_HTML_CAP, fetchPageHtml, type PageFetchDeps } from "../page-copy-check";
import { isPrivateIp } from "@/services/onboarding/enrichment/url-guard";

const deps = (over: Partial<PageFetchDeps> = {}): PageFetchDeps => ({
  resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  isPrivate: isPrivateIp,
  get: async () => ({ status: 200, location: null, body: "<p>ok</p>" }),
  ...over,
});

describe("SSRF: one DNS answer, checked, and the connection pinned to it", () => {
  it("connects to the checked address only", async () => {
    const get = vi.fn(async () => ({ status: 200, location: null, body: "<p>hi</p>" }));
    expect(await fetchPageHtml("https://acme.com/", deps({ get }))).toBe("<p>hi</p>");
    expect(get).toHaveBeenCalledWith(new URL("https://acme.com/"), "93.184.216.34", 4, expect.any(AbortSignal));
  });

  it("refuses a host that resolves to any private address", async () => {
    await expect(fetchPageHtml("https://acme.com/", deps({ resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] }))).rejects.toThrow(/not a public address/);
    await expect(fetchPageHtml("https://acme.com/", deps({ resolve: async () => [{ address: "169.254.169.254", family: 4 }] }))).rejects.toThrow();
  });

  it("follows only same-site https redirects, resolving and checking each hop", async () => {
    const resolve = vi.fn(async (h: string) => [{ address: h === "www.acme.com" ? "127.0.0.1" : "93.184.216.34", family: 4 }]);
    const get = vi.fn(async (u: URL) => (u.hostname === "acme.com" ? { status: 301, location: "https://www.acme.com/", body: "" } : { status: 200, location: null, body: "x" }));
    await expect(fetchPageHtml("https://acme.com/", deps({ resolve, get }))).rejects.toThrow(/not a public address/);
    await expect(fetchPageHtml("https://acme.com/", deps({ get: async () => ({ status: 302, location: "https://evil.example/", body: "" }) }))).rejects.toThrow(/off the site/);
    await expect(fetchPageHtml("https://acme.com/", deps({ get: async () => ({ status: 302, location: "http://acme.com/", body: "" }) }))).rejects.toThrow(/https/);
  });

  it("the real GET pins the socket to the given IP and keeps the TLS name", async () => {
    https.opts.length = 0; https.chunks = [Buffer.from("<p>ok</p>")]; https.headers = {}; https.status = 200;
    const body = await fetchPageHtml("https://acme.com/a?b=1", { ...deps(), get: (await import("../page-copy-check")).__pinnedGetForTest });
    expect(body).toBe("<p>ok</p>");
    const o = https.opts[0]!;
    expect(o).toMatchObject({ hostname: "acme.com", servername: "acme.com", path: "/a?b=1" });
    const looked = await new Promise((r) => (o.lookup as (h: string, x: unknown, cb: (e: null, a: string, f: number) => void) => void)("acme.com", {}, (_e, a) => r(a)));
    expect(looked).toBe("93.184.216.34");
    const all = await new Promise((r) => (o.lookup as (h: string, x: unknown, cb: (e: null, a: unknown) => void) => void)("acme.com", { all: true }, (_e, a) => r(a)));
    expect(all).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("DNS that never answers counts against the deadline", async () => {
    await expect(fetchPageHtml("https://acme.com/", deps({ resolve: () => new Promise(() => undefined) }), 200)).rejects.toThrow(/deadline/);
  });
});

describe("one overall deadline for the whole read (security review)", () => {
  it("a slow-drip body fails by the deadline instead of staying open", async () => {
    https.drip = true; https.chunks = []; https.headers = {}; https.status = 200;
    const started = Date.now();
    await expect(fetchPageHtml("https://acme.com/", { ...deps(), get: (await import("../page-copy-check")).__pinnedGetForTest }, 300)).rejects.toThrow(/deadline/);
    expect(Date.now() - started).toBeLessThan(2000);
    https.drip = false;
  });

  it("the deadline spans redirect hops", async () => {
    let hops = 0;
    const get = async (_u: URL, _ip: string, _f: 4 | 6, signal: AbortSignal) => {
      hops++;
      await new Promise((r) => setTimeout(r, 120));
      if (signal.aborted) throw new Error("page read deadline passed");
      return { status: 302, location: `https://acme.com/${hops}`, body: "" };
    };
    await expect(fetchPageHtml("https://acme.com/", deps({ get }), 200)).rejects.toThrow(/deadline/);
    expect(hops).toBeLessThan(4);
  });
});

describe("the body is capped while it streams", () => {
  const pinned = async () => (await import("../page-copy-check")).__pinnedGetForTest;

  it("a declared Content-Length over the cap is refused before reading", async () => {
    https.chunks = [Buffer.from("x")]; https.headers = { "content-length": String(PAGE_HTML_CAP + 1) }; https.status = 200;
    await expect(fetchPageHtml("https://acme.com/", { ...deps(), get: await pinned() })).rejects.toThrow(/too large/);
  });

  it("a body that grows past the cap stops being read", async () => {
    https.headers = {}; https.status = 200;
    https.chunks = [Buffer.alloc(PAGE_HTML_CAP), Buffer.alloc(10), Buffer.alloc(10)];
    await expect(fetchPageHtml("https://acme.com/", { ...deps(), get: await pinned() })).rejects.toThrow(/too large/);
  });
});
