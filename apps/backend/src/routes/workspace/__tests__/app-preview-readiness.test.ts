import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rowsByTenant: {} as Record<string, Array<{ resource_kind: string; external_ref: Record<string, unknown> }>>,
  tenantFilters: [] as string[],
  sandboxRows: {} as Record<string, Array<{ preview_url: string | null }>>,
  sandboxTenants: [] as string[],
  sitesByTenant: {} as Record<string, Array<Record<string, unknown>>>,
  siteListTenants: [] as string[],
  siteListFails: false,
}));

vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    listForTenant: async (tenant: string) => {
      mocks.siteListTenants.push(tenant);
      if (mocks.siteListFails) throw new Error("sites read failed");
      return mocks.sitesByTenant[tenant] ?? [];
    },
  }),
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      mocks.sandboxTenants.push(`${table}:${tenant}`);
      const b: Record<string, unknown> = {
        select: () => b,
        not: async () => ({ data: table === "tenant_sandbox" ? mocks.sandboxRows[tenant] ?? [] : [], error: null }),
      };
      return b;
    },
  }),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.auth }));
vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: (table: string) => {
      let tenant = "";
      let kinds: string[] = [];
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: string) => {
          if (col === "tenant_id") {
            tenant = val;
            mocks.tenantFilters.push(val);
          }
          return b;
        },
        in: async (col: string, vals: string[]) => {
          if (col === "resource_kind") kinds = vals;
          const rows = table === "tenant_resources" ? mocks.rowsByTenant[tenant] ?? [] : [];
          return { data: rows.filter((r) => kinds.includes(r.resource_kind)), error: null };
        },
      };
      return b;
    },
  }),
}));

import {
  getAppPreviewReadinessHandler,
  READINESS_PROBE_TIMEOUT_MS,
} from "../app-preview-readiness";

const fetchMock = vi.fn();

function response() {
  let status = 200;
  let body: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status: vi.fn((v: number) => { status = v; return res; }),
    json: vi.fn((v: unknown) => { body = v; return res; }),
    set: vi.fn((k: string, v: string) => { headers[k] = v; return res; }),
  } as unknown as Response;
  return { res, result: () => ({ status, body, headers }) };
}

async function call(url: string | undefined) {
  const { res, result } = response();
  await getAppPreviewReadinessHandler({ query: url === undefined ? {} : { url }, headers: {} } as unknown as Request, res);
  return result();
}

function upstream(status: number, headers: Record<string, string>, body = "<html><title>Hi</title></html>") {
  return new Response(body, { status, headers });
}

describe("GET /api/workspace/app-preview/readiness", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    mocks.auth.mockResolvedValue({ tenant_id: "tenant-a", user_id: "user-a", access_token: "tok-a" });
    mocks.tenantFilters.length = 0;
    mocks.sandboxTenants.length = 0;
    mocks.siteListTenants.length = 0;
    mocks.siteListFails = false;
    const site = (tenant: string, label: string, status = "live") => ({
      id: `${label}-id`,
      tenant_id: tenant,
      hostname: `${label}.zaviagent.com`,
      live_url: status === "live" ? `https://${label}.zaviagent.com/` : null,
      status,
    });
    mocks.sitesByTenant = {
      "tenant-a": [site("tenant-a", "bakery-a1b2"), site("tenant-a", "gym-c3d4", "building"), site("tenant-a", "old-e5f6", "deleted")],
      "tenant-b": [site("tenant-b", "rival-9z9z")],
    };
    mocks.sandboxRows = {
      "tenant-a": [{ preview_url: "https://5173-ownbox123abc.e2b.app" }, { preview_url: null }],
      "tenant-b": [{ preview_url: "https://5173-otherbox456.e2b.app" }],
    };
    mocks.rowsByTenant = {
      "tenant-a": [
        { resource_kind: "hosting", external_ref: { url: "https://mohit-93bd8436.onrender.com", render_service_id: "srv-a" } },
        { resource_kind: "domain", external_ref: { hostname: "mohit-93bd8436.zaviagent.com", status: "live" } },
      ],
      "tenant-b": [
        { resource_kind: "hosting", external_ref: { url: "https://other-11111111.onrender.com" } },
        { resource_kind: "domain", external_ref: { hostname: "other-11111111.zaviagent.com" } },
      ],
    };
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("probes each of the tenant's own sites (two sites in one workspace)", async () => {
    fetchMock.mockResolvedValue(upstream(200, {}));
    for (const url of ["https://bakery-a1b2.zaviagent.com/", "https://gym-c3d4.zaviagent.com"]) {
      const out = await call(url);
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ state: "ready" });
    }
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://bakery-a1b2.zaviagent.com/",
      "https://gym-c3d4.zaviagent.com/",
    ]);
    expect(mocks.siteListTenants.every((t) => t === "tenant-a")).toBe(true);
  });

  it("refuses another tenant's site and a deleted site, and answers 503 when the sites read fails", async () => {
    for (const url of ["https://rival-9z9z.zaviagent.com/", "https://old-e5f6.zaviagent.com/"]) {
      const out = await call(url);
      expect(out.status).toBe(400);
    }
    mocks.siteListFails = true;
    expect((await call("https://bakery-a1b2.zaviagent.com/")).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.siteListTenants.every((t) => t === "tenant-a")).toBe(true);
  });

  it("does not read sites for the singleton app's own host", async () => {
    fetchMock.mockResolvedValue(upstream(200, {}));
    expect((await call("https://mohit-93bd8436.zaviagent.com/")).status).toBe(200);
    expect(mocks.siteListTenants).toEqual([]);
  });

  it("400s a foreign host and never fetches it", async () => {
    const out = await call("https://evil.example.com/");
    expect(out.status).toBe(400);
    expect(out.body).toMatchObject({ error: { code: "bad_url" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s another tenant's own app host and never fetches it", async () => {
    for (const url of ["https://other-11111111.onrender.com/", "https://other-11111111.zaviagent.com"]) {
      const out = await call(url);
      expect(out.status).toBe(400);
    }
    expect(mocks.tenantFilters.every((t) => t === "tenant-a")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never fetches a domain-row hostname that is not a real built-in <label>.zaviagent.com", async () => {
    const hostile = ["127.0.0.1", "169.254.169.254", "internal.corp", "www.zaviagent.com", "a.b.zaviagent.com", "growth.zaviagent.com"];
    mocks.rowsByTenant["tenant-a"] = [
      { resource_kind: "hosting", external_ref: { url: "https://10.0.0.5" } },
      ...hostile.map((hostname) => ({ resource_kind: "domain", external_ref: { hostname } })),
    ];
    for (const host of [...hostile, "10.0.0.5"]) {
      const out = await call(`https://${host}/`);
      expect(out.status, host).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s http, a port, credentials, a lookalike suffix and a missing url without fetching", async () => {
    const bad = [
      "http://mohit-93bd8436.onrender.com/",
      "https://mohit-93bd8436.onrender.com:8443/",
      "https://user:pw@mohit-93bd8436.onrender.com/",
      "https://mohit-93bd8436.onrender.com.evil.example/",
      "https://x.mohit-93bd8436.onrender.com/",
      "not a url",
      "",
      undefined,
    ];
    for (const url of bad) {
      const out = await call(url);
      expect(out.status, String(url)).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a Render wake header as waking", async () => {
    fetchMock.mockResolvedValue(upstream(503, { "content-type": "text/html", "x-render-routing": "hibernate-wake" }));
    const out = await call("https://mohit-93bd8436.onrender.com/");
    expect(out).toMatchObject({ status: 200, body: { state: "waking" } });
  });

  it("classifies a suspended service as suspended", async () => {
    fetchMock.mockResolvedValue(upstream(503, { "content-type": "text/html", "x-render-routing": "suspend-by-user" }, "<title>Service Suspended</title>"));
    const out = await call("https://mohit-93bd8436.onrender.com/");
    expect(out.body).toEqual({ state: "suspended" });
  });

  it("classifies the app's own 200 as ready even with Render's origin headers", async () => {
    fetchMock.mockResolvedValue(upstream(200, { "rndr-id": "abc", "x-render-origin-server": "Render" }));
    const out = await call("https://mohit-93bd8436.onrender.com/");
    expect(out.body).toEqual({ state: "ready" });
    expect(out.headers["Cache-Control"]).toBe("no-store");
  });

  it("classifies the app's own 404 and redirect as ready", async () => {
    fetchMock.mockResolvedValueOnce(upstream(404, { "content-type": "text/html" }));
    expect((await call("https://mohit-93bd8436.onrender.com/")).body).toEqual({ state: "ready" });
    fetchMock.mockResolvedValueOnce(upstream(302, { location: "https://elsewhere.example/" }));
    expect((await call("https://mohit-93bd8436.onrender.com/")).body).toEqual({ state: "ready" });
  });

  it("probes only the origin root of the zaviagent host with a manual redirect and no credentials", async () => {
    fetchMock.mockResolvedValue(upstream(200, {}));
    await call("https://MOHIT-93bd8436.zaviagent.com/pricing?_v=7#x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://mohit-93bd8436.zaviagent.com/");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).Accept).toBe("*/*");
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|cookie|tok-a/i);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports waking when the probe times out, and aborts the request", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const pending = call("https://mohit-93bd8436.onrender.com/");
    await vi.advanceTimersByTimeAsync(READINESS_PROBE_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await pending;
    expect(signal?.aborted).toBe(true);
    expect(out.body).toEqual({ state: "waking" });
  });

  it("reports waking on a network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect((await call("https://mohit-93bd8436.onrender.com/")).body).toEqual({ state: "waking" });
  });

  it("shares one outbound probe across concurrent requests for the same app", async () => {
    let release: (r: globalThis.Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<globalThis.Response>((resolve) => { release = resolve; }));
    const a = call("https://mohit-93bd8436.onrender.com/");
    const b = call("https://mohit-93bd8436.onrender.com/about");
    const c = call("https://mohit-93bd8436.onrender.com");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(upstream(503, { "x-render-routing": "hibernate-wake" }));
    const outs = await Promise.all([a, b, c]);
    expect(outs.map((o) => o.body)).toEqual([{ state: "waking" }, { state: "waking" }, { state: "waking" }]);

    fetchMock.mockResolvedValue(upstream(200, {}));
    expect((await call("https://mohit-93bd8436.onrender.com/")).body).toEqual({ state: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never returns the upstream body", async () => {
    fetchMock.mockResolvedValue(upstream(503, { "x-render-routing": "hibernate-wake" }, "<h1>START BUILDING ON RENDER TODAY</h1>"));
    const out = await call("https://mohit-93bd8436.onrender.com/");
    expect(JSON.stringify(out.body)).not.toMatch(/render/i);
  });

  describe("the tenant's own sandbox preview (e2b dev server)", () => {
    const BOX = "https://5173-ownbox123abc.e2b.app";
    const VITE_HTML =
      '<!doctype html><html><head><script type="module">import R from "/@react-refresh"</script>' +
      '<script type="module" src="/@vite/client"></script></head><body><div id="root"></div>' +
      '<script type="module" src="/src/main.tsx"></script>' +
      '<script type="module" src="https://cdn.example.com/x.js"></script></body></html>';

    function serve(map: Record<string, globalThis.Response | (() => globalThis.Response)>) {
      fetchMock.mockImplementation(async (url: string) => {
        const hit = map[url];
        if (!hit) return new Response("nope", { status: 404 });
        return typeof hit === "function" ? hit() : hit;
      });
    }

    it("400s another tenant's sandbox preview and never fetches it", async () => {
      const out = await call("https://5173-otherbox456.e2b.app/");
      expect(out.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.sandboxTenants.every((t) => t === "tenant_sandbox:tenant-a")).toBe(true);
    });

    it("is waking while the page answers but its Vite client still 404s (the blank-pane bug)", async () => {
      serve({
        [`${BOX}/`]: () => new Response(VITE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
        [`${BOX}/src/main.tsx`]: () => new Response("export {}", { status: 200 }),
      });
      const out = await call(`${BOX}/`);
      expect(out.body).toEqual({ state: "waking" });
    });

    it("is ready only when the page AND every same-origin module script it loads answer 2xx", async () => {
      serve({
        [`${BOX}/`]: () => new Response(VITE_HTML, { status: 200, headers: { "content-type": "text/html" } }),
        [`${BOX}/@vite/client`]: () => new Response("//client", { status: 200 }),
        [`${BOX}/src/main.tsx`]: () => new Response("export {}", { status: 200 }),
      });
      const out = await call(`${BOX}/some/path`);
      expect(out.body).toEqual({ state: "ready" });
      const urls = fetchMock.mock.calls.map(([u]) => u);
      expect(urls).toEqual(expect.arrayContaining([`${BOX}/`, `${BOX}/@vite/client`, `${BOX}/src/main.tsx`]));
      expect(urls.some((u: string) => u.includes("cdn.example.com"))).toBe(false);
    });

    it("is waking when the dev server is not up yet (proxy 404/502) or the page is not HTML", async () => {
      serve({ [`${BOX}/`]: () => new Response("port not open", { status: 502 }) });
      expect((await call(`${BOX}/`)).body).toEqual({ state: "waking" });
      serve({ [`${BOX}/`]: () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) });
      expect((await call(`${BOX}/`)).body).toEqual({ state: "waking" });
    });

    it("is waking on a network error", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));
      expect((await call(`${BOX}/`)).body).toEqual({ state: "waking" });
    });

    it("never trusts a preview_url that is not a raw e2b sandbox host", async () => {
      mocks.sandboxRows["tenant-a"] = [{ preview_url: "https://169.254.169.254" }, { preview_url: "https://evil.example.com" }];
      for (const u of ["https://169.254.169.254/", "https://evil.example.com/"]) {
        expect((await call(u)).status, u).toBe(400);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
