import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { GATE_RUNNER_SOURCE } from "../runner-source.generated";
import { buildRunnerConfig, buildScanConfig, type GateRunnerConfig } from "../config";
import { fakeLaunch, type FakeSite, type ApiReq } from "./fake-browser";
import { ZaviError, ZAVI_ERROR_CODES, userMessage } from "../../../provisioning/templates/vite-react-zavi/files/src/zavi/errors";
import { TEMPLATE_FILES as ZAVI_STARTER } from "../../../provisioning/templates/vite-react-zavi/template-files.generated";
import { TEMPLATE_FILES as SUPABASE_STARTER } from "../../../provisioning/templates/vite-react-supabase/template-files.generated";

const req = createRequire(__filename);
const runner = req("../runner.cjs") as {
  runGate: (o: { baseUrl: string; ownerLink?: string | null; config: GateRunnerConfig; launch: () => Promise<unknown> }) => Promise<{
    ok: boolean;
    journeys: Array<{ name: string; ok: boolean; skipped?: boolean; reason?: string }>;
    owner: { ok: boolean; reason?: string } | null;
    error?: string;
    infrastructure_error?: boolean;
    screenshots?: Array<{ label: string; path: string; data: string }>;
    og_title?: string;
    page_text?: Array<{ path: string; text: string; sections: string[]; blocks: Array<{ len: number; head: string; mark?: string }> }>;
  }>;
  findErrorText: (path: string, text: string, fields?: string[]) => string | null;
  readOnlyAllows: (method: string) => boolean;
  platformFault: (status: number, pathname: string, location?: string) => string | null;
};

const ORIGIN = "https://s.zaviagent.com";
const PREVIEW = `${ORIGIN}/__zavi_preview/d1-abc/?t=1234.previewsig0123456789`;
const LINK = `${ORIGIN}/api/auth/callback?type=magiclink&token_hash=ownertokenhash123456`;
const TAG = "zavi-smoke-0123456789abcdef";

const DEDICATED_MANIFEST = JSON.stringify({
  smoke: { journeys: [{ name: "home", path: "/" }, { name: "login", path: "/login", expect: "[data-zavi=login-email]" }] },
});

const POOLED_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  collections: {
    messages: {
      rules: { create: ["anyone"], list: ["owner", "admin"], get: ["owner", "admin"], update: ["admin"], delete: ["admin"] },
      schema: {
        type: "object",
        required: ["name", "body"],
        properties: { name: { type: "string", minLength: 1, maxLength: 80 }, body: { type: "string", minLength: 1, maxLength: 2000 } },
      },
    },
  },
  smoke: { journeys: [{ name: "home", path: "/", expect: "[data-zavi=home]" }] },
});

function cfg(manifest: string, allow_writes = false): GateRunnerConfig {
  return buildRunnerConfig({ manifestRaw: manifest, allow_writes, tag: TAG });
}

const healthy = (): FakeSite["routes"] => ({
  "/": { status: 200, text: "Bloom Bakery\nFresh bread every morning", selectors: ["[data-zavi=home]"] },
  "/login": { status: 200, text: "Sign in", selectors: ["[data-zavi=login-email]"] },
});

function gateway(opts: { visitorCanRead?: boolean; createStatus?: number } = {}) {
  let stored: { id: string; data: unknown } | null = null;
  return (r: ApiReq) => {
    if (r.method === "POST" && r.path === "/api/data/messages") {
      if (opts.createStatus) return { status: opts.createStatus, body: { error: { code: "x" } } };
      stored = { id: "11111111-1111-1111-1111-111111111111", data: (r.body as { data: unknown }).data };
      return { status: 201, body: { data: stored } };
    }
    if (r.method === "GET" && r.path.startsWith("/api/data/messages")) {
      const authed = r.headers.authorization === "Bearer owner-access-token-xyz";
      if (!authed && !opts.visitorCanRead) return { status: 401, body: { error: { code: "unauthorized" } } };
      if (r.path.includes("?")) return { status: 200, body: { data: { items: stored ? [stored] : [] } } };
      return stored ? { status: 200, body: { data: stored } } : { status: 404 };
    }
    return { status: 404 };
  };
}

describe("runner source", () => {
  it("the generated string matches runner.cjs (run scripts/generate-gate-runner-source.cjs)", () => {
    expect(GATE_RUNNER_SOURCE).toBe(readFileSync(join(__dirname, "..", "runner.cjs"), "utf-8"));
  });
  it("never shells out or reads the site repo", () => {
    expect(GATE_RUNNER_SOURCE).not.toMatch(/child_process|execSync|spawn\(|\/home\/user\/repo/);
  });
});

describe("platform journeys", () => {
  it("a healthy dedicated site passes home, routes, mobile and its manifest journeys", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy() });
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r.ok).toBe(true);
    expect(r.journeys.map((j) => j.name)).toEqual(["zavi:home", "zavi:routes", "zavi:mobile", "zavi:error-text", "home", "login"]);
    expect(f.isClosed()).toBe(true);
  });

  it("a broken entry stops the run", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), entryStatus: 403 });
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r.ok).toBe(false);
    expect(r.journeys).toHaveLength(1);
    expect(r.journeys[0]).toMatchObject({ name: "zavi:entry", ok: false });
    expect(JSON.stringify(r)).not.toContain("previewsig0123456789");
  });

  it("home fails on a console error", async () => {
    const routes = healthy();
    routes["/"].console = ["Uncaught TypeError: x is undefined"];
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: fakeLaunch({ origin: ORIGIN, routes }).launch });
    expect(r.ok).toBe(false);
    expect(r.journeys.find((j) => j.name === "zavi:home")).toMatchObject({ ok: false, reason: expect.stringMatching(/console error/) });
  });

  it("home ignores a favicon 404 but fails on a blank page", async () => {
    const routes = healthy();
    routes["/"].console = ["Failed to load resource: /favicon.ico 404"];
    const ok = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: fakeLaunch({ origin: ORIGIN, routes }).launch });
    expect(ok.journeys.find((j) => j.name === "zavi:home")?.ok).toBe(true);
    routes["/"].text = "  ";
    const blank = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: fakeLaunch({ origin: ORIGIN, routes }).launch });
    expect(blank.journeys.find((j) => j.name === "zavi:home")).toMatchObject({ ok: false, reason: expect.stringMatching(/no visible text/) });
  });

  it("home ignores a Google Fonts stylesheet or font that cannot load, but not another third-party resource", async () => {
    const routes = healthy();
    routes["/"].resourceErrors = [
      { url: "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" },
      { url: "https://fonts.gstatic.com/s/inter/v13/abc.woff2", text: "Failed to load resource: net::ERR_INTERNET_DISCONNECTED" },
    ];
    const ok = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: fakeLaunch({ origin: ORIGIN, routes }).launch });
    expect(ok.journeys.find((j) => j.name === "zavi:home")).toMatchObject({ ok: true });
    expect(ok.ok).toBe(true);
    routes["/"].resourceErrors = [{ url: "https://fonts.googleapis.com.evil.example/css2" }];
    const lookalike = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: fakeLaunch({ origin: ORIGIN, routes }).launch });
    expect(lookalike.journeys.find((j) => j.name === "zavi:home")).toMatchObject({ ok: false, reason: expect.stringMatching(/console error: Failed to load resource/) });
    routes["/"].resourceErrors = [{ url: "https://cdn.example.com/app.css" }];
    const other = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: fakeLaunch({ origin: ORIGIN, routes }).launch });
    expect(other.journeys.find((j) => j.name === "zavi:home")).toMatchObject({ ok: false, reason: expect.stringMatching(/console error: Failed to load resource/) });
  });

  it("routes fails when a declared route is not 200", async () => {
    const routes = healthy();
    routes["/login"].status = 404;
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: fakeLaunch({ origin: ORIGIN, routes }).launch });
    expect(r.journeys.find((j) => j.name === "zavi:routes")).toMatchObject({ ok: false, reason: "HTTP 404 for /login" });
    expect(r.ok).toBe(false);
  });

  it("mobile fails on sideways scroll at phone width, in a mobile context", async () => {
    const routes = healthy();
    routes["/login"].mobileOverflow = 120;
    const f = fakeLaunch({ origin: ORIGIN, routes });
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "zavi:mobile")).toMatchObject({ ok: false, reason: expect.stringMatching(/\/login scrolls sideways by 120px/) });
    expect(f.calls.contexts.some((o) => (o?.viewport as { width: number } | undefined)?.width === 390 && o?.isMobile === true)).toBe(true);
  });

  it("routes fails when a declared route renders the SPA fallback (same page as a missing route)", async () => {
    const routes = healthy();
    routes["/checkout"] = { status: 200, text: "Not found" };
    const m = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }, { name: "checkout", path: "/checkout" }] } });
    const f = fakeLaunch({ origin: ORIGIN, routes });
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(m), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "zavi:routes")).toMatchObject({ ok: false, reason: "/checkout renders the same page as a route that does not exist" });
    expect(f.calls.goto.some((u) => u.includes("/__zavi-missing-" + TAG))).toBe(true);
  });

  it("a manifest journey fails when its expected hook is missing", async () => {
    const routes = healthy();
    routes["/login"].selectors = [];
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: fakeLaunch({ origin: ORIGIN, routes }).launch });
    expect(r.journeys.find((j) => j.name === "login")).toMatchObject({ ok: false });
  });
});

describe("read-only gate (a preview on a LIVE database)", () => {
  it("only plain reads pass: every write, sign-in and RPC is answered 403 in the browser", () => {
    const ok = runner.readOnlyAllows;
    for (const m of ["GET", "head", "OPTIONS"]) expect(ok(m)).toBe(true);
    for (const m of ["POST", "PATCH", "PUT", "DELETE", "connect", ""]) expect(ok(m)).toBe(false);
  });

  it("installed on every browser context of a read-only gate, never on a writing one", async () => {
    expect(cfg(DEDICATED_MANIFEST, false).read_only).toBe(true);
    const ro = fakeLaunch({ origin: ORIGIN, routes: healthy() });
    await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST, false), launch: ro.launch });
    expect(ro.calls.routes.length).toBeGreaterThanOrEqual(2);
    let sent: unknown;
    await ro.calls.routes[0].handle({
      request: () => ({ method: () => "POST", url: () => "https://ref.supabase.co/rest/v1/orders" }),
      continue: async () => (sent = "continued"),
      fulfill: async (o: { status: number }) => (sent = o.status),
    });
    expect(sent).toBe(403);
    expect(ro.calls.wsRoutes.length).toBe(ro.calls.routes.length);
    let closed: unknown;
    await ro.calls.wsRoutes[0].handle({ close: async (o: unknown) => (closed = o) });
    expect(closed).toEqual({ code: 1008, reason: "read_only_gate" });

    const rw = fakeLaunch({ origin: ORIGIN, routes: healthy() });
    await runner.runGate({ baseUrl: PREVIEW, config: cfg(POOLED_MANIFEST, true), launch: rw.launch });
    expect(rw.calls.routes).toHaveLength(0);
    expect(rw.calls.wsRoutes).toHaveLength(0);
  });
});

describe("owner journey", () => {
  it("the preview link is opened BEFORE the owner link, in the same context (the gateway needs the preview cookie)", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: true, token: null } });
    await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(f.calls.goto[0]).toBe(PREVIEW);
    expect(f.calls.goto.indexOf(LINK)).toBeGreaterThan(0);
  });

  it("dedicated: passes when the link reaches /admin", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: true, token: null } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r.owner).toMatchObject({ name: "owner-admin", ok: true });
    expect(r.ok).toBe(true);
  });

  it("an owner page error is withheld: page text can carry the session", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: true, token: null, pageError: "boom #access_token=leakedjwt0123456789" } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r.owner).toMatchObject({ ok: false, reason: expect.stringMatching(/text withheld/) });
    expect(JSON.stringify(r)).not.toContain("leakedjwt");
  });

  it("an owner journey failure never reports the Playwright call log URL", async () => {
    const m = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }, { name: "owner-orders", path: "/admin", as: "owner", expect: "[data-zavi=orders]" }] } });
    const routes = healthy();
    routes["/admin"] = { status: 200, text: "Admin", selectors: [] };
    const f = fakeLaunch({ origin: ORIGIN, routes, ownerLink: LINK, owner: { reachesAdmin: true, token: "owner-access-token-xyz" } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(m), launch: f.launch });
    const j = r.journeys.find((x) => x.name === "owner-orders");
    expect(j).toMatchObject({ ok: false });
    expect(j?.reason).not.toMatch(/https?:|navigated/);
  });

  it("fails, scrubbed of the link, when the link does not reach /admin", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: false, token: null } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r.ok).toBe(false);
    expect(r.owner).toMatchObject({ ok: false, reason: "the owner sign-in did not reach /admin (the sign-in page showed an error)" });
    expect(r.infrastructure_error).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("ownertokenhash123456");
  });

  it("a sign-in still in progress on /auth/confirm while a platform call has not answered is the platform's, never a paid repair", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: false, token: null, stillSigningIn: true, pendingApi: "/api/site" } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r.ok).toBe(false);
    expect(r.infrastructure_error).toBe(true);
    expect(r.error).toMatch(/sign-in service did not answer in time/);
    expect(JSON.stringify(r)).not.toContain("ownertokenhash123456");
  });

  it("a sign-in stuck with no platform call outstanding (or only the site's own function) stays the site's", async () => {
    for (const pendingApi of [undefined, "/api/fn/load-profile"]) {
      const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: false, token: null, stillSigningIn: true, pendingApi } });
      const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
      expect(r.infrastructure_error, String(pendingApi)).toBeUndefined();
      expect(r.owner).toMatchObject({ ok: false, reason: "the owner sign-in did not reach /admin" });
    }
  });

  it("an owner who lands elsewhere on the site is told where (a path only)", async () => {
    const f = fakeLaunch({
      origin: ORIGIN,
      routes: healthy(),
      ownerLink: LINK,
      owner: { reachesAdmin: false, token: null },
    });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r.owner?.reason).not.toMatch(/https?:|#|access_token/);
  });

  it("/admin without the shell (and no platform fault) is the site's failure, with the root reason", async () => {
    const m = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }, { name: "owner-orders", path: "/admin", as: "owner", expect: "[data-zavi=orders]" }] } });
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: true, token: null, shell: false } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(m), launch: f.launch });
    expect(r.infrastructure_error).toBeUndefined();
    expect(r.owner).toMatchObject({ ok: false, reason: "/admin did not show [data-zavi=admin-shell] to the signed-in owner" });
    expect(r.journeys.find((j) => j.name === "owner-orders")).toMatchObject({ ok: false, reason: "the owner could not sign in" });
  });

  it("a refused owner link is a platform failure: the site cannot fix the sign-in service", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: false, token: null, callbackError: "link_expired" } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r).toMatchObject({ ok: false, infrastructure_error: true });
    expect(r.error).toMatch(/refused the owner link \(link_expired\)/);
    expect(JSON.stringify(r)).not.toContain("ownertokenhash123456");
  });

  it("a gateway 5xx while /admin fails to render is a platform failure", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: true, token: null, shell: false, responses: [{ path: "/api/site", status: 502 }] } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r).toMatchObject({ ok: false, infrastructure_error: true, error: expect.stringMatching(/answered 502 on \/api\/site/) });
  });

  it("the site host answering 503 for the home page is a platform failure (retry), never a repair", async () => {
    const routes = { ...healthy(), "/": { status: 503, text: "Service Unavailable" } };
    const f = fakeLaunch({ origin: ORIGIN, routes });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: null, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r).toMatchObject({ ok: false, infrastructure_error: true, error: expect.stringMatching(/site host answered 503 on \//) });
  });

  it("a preview the browser cannot reach (connection reset) is a platform failure, never a repair", async () => {
    const routes = { ...healthy(), "/": { navError: "page.goto: net::ERR_CONNECTION_RESET at https://x.example/" } };
    const f = fakeLaunch({ origin: ORIGIN, routes });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: null, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r).toMatchObject({ ok: false, infrastructure_error: true, error: expect.stringMatching(/could not be reached/) });
  });

  it("a page that is simply missing (404) stays the site's to fix", async () => {
    const routes = { ...healthy(), "/": { status: 404, text: "Not found" } };
    const f = fakeLaunch({ origin: ORIGIN, routes });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: null, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r.ok).toBe(false);
    expect(r.infrastructure_error).toBeUndefined();
  });

  it("a 5xx from ANOTHER origin (a third-party API the site calls) is not a platform fault", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: true, token: null, shell: false, responses: [] } });
    const launch = async () => {
      const b = (await f.launch()) as { newContext: (o?: unknown) => Promise<{ newPage: () => Promise<{ on: (ev: string, l: (a: unknown) => void) => void }> }> };
      return {
        ...b,
        newContext: async (o?: unknown) => {
          const ctx = await b.newContext(o);
          return {
            ...ctx,
            newPage: async () => {
              const p = await ctx.newPage();
              const on = p.on.bind(p);
              p.on = (ev, l) => {
                on(ev, l);
                if (ev === "response") l({ url: () => "https://third-party.example/api/data/x", status: () => 503, headers: () => ({}) });
              };
              return p;
            },
          };
        },
      };
    };
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch });
    expect(r.infrastructure_error).toBeUndefined();
    expect(r.owner).toMatchObject({ ok: false, reason: expect.stringMatching(/admin-shell/) });
  });

  it("a 5xx from the site's OWN server function is not a platform fault", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: true, token: null, shell: false, responses: [{ path: "/api/fn/report", status: 500 }] } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r.infrastructure_error).toBeUndefined();
    expect(r.owner?.ok).toBe(false);
  });

  it("an owner link that does not load is a platform failure, scrubbed of the link", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), ownerLink: LINK, owner: { reachesAdmin: false, token: null, linkFails: true } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r).toMatchObject({ ok: false, infrastructure_error: true, error: expect.stringMatching(/link did not load/) });
    expect(JSON.stringify(r)).not.toContain("ownertokenhash123456");
  });

  it("platformFault: only platform paths, only real faults, never a URL or token", () => {
    expect(runner.platformFault(200, "/api/site")).toBeNull();
    expect(runner.platformFault(404, "/api/data/x")).toBeNull();
    expect(runner.platformFault(500, "/assets/app.js")).toBe("the site host answered 500 on /assets/app.js");
    expect(runner.platformFault(404, "/assets/app.js")).toBeNull();
    expect(runner.platformFault(500, "/api/fn/x")).toBeNull();
    expect(runner.platformFault(503, "/api/data/x")).toBe("the platform answered 503 on /api/data/x");
    expect(runner.platformFault(303, "/api/auth/callback", "/auth/confirm#type=magiclink&token_hash=abcdefgh123")).toBeNull();
    expect(runner.platformFault(303, "/api/auth/callback", "/auth/confirm#access_token=secretsecret")).toBeNull();
    expect(runner.platformFault(303, "/api/auth/callback", "/auth/confirm#error=unavailable")).toBe("the sign-in service refused the owner link (unavailable)");
    expect(runner.platformFault(303, "/api/auth/callback", "/auth/confirm#error=<script>")).toBe("the sign-in service refused the owner link (unknown)");
    expect(runner.platformFault(200, "/api/auth/callback")).toBe("the sign-in service answered 200 to the owner link");
  });
});

describe("pooled write journey", () => {
  const pooledRoutes = () => ({ "/": { status: 200, text: "Hi", selectors: ["[data-zavi=home]"] } });

  it("create, signed-out denied, owner read-back all pass", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: pooledRoutes(), api: gateway(), ownerLink: LINK, owner: { reachesAdmin: true, token: "owner-access-token-xyz" } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(POOLED_MANIFEST, true), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "zavi:read-denied")?.ok).toBe(true);
    expect(r.journeys.filter((j) => j.name.startsWith("zavi:write")).map((j) => [j.name, j.ok])).toEqual([
      ["zavi:write-create", true],
      ["zavi:write-denied", true],
      ["zavi:write-readback", true],
    ]);
    expect(r.ok).toBe(true);
    const create = f.calls.api.find((a) => a.method === "POST")!;
    expect(JSON.stringify(create.body)).toContain(TAG);
    expect(create.headers.authorization).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("owner-access-token-xyz");
  });

  it("reports exactly the record its own create returned (the only pooled record the cleanup may delete)", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: pooledRoutes(), api: gateway() });
    const r = (await runner.runGate({ baseUrl: PREVIEW, config: cfg(POOLED_MANIFEST, true), launch: f.launch })) as { created?: unknown };
    expect(r.created).toEqual([{ collection: "messages", id: "11111111-1111-1111-1111-111111111111" }]);
    const refused = fakeLaunch({ origin: ORIGIN, routes: pooledRoutes(), api: gateway({ createStatus: 422 }) });
    const r2 = (await runner.runGate({ baseUrl: PREVIEW, config: cfg(POOLED_MANIFEST, true), launch: refused.launch })) as { created?: unknown };
    expect(r2.created).toEqual([]);
  });

  it("fails when a signed-out visitor can read the record", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: pooledRoutes(), api: gateway({ visitorCanRead: true }), ownerLink: LINK, owner: { reachesAdmin: true, token: "owner-access-token-xyz" } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(POOLED_MANIFEST, true), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "zavi:write-denied")).toMatchObject({ ok: false, reason: expect.stringMatching(/signed-out visitor could read/) });
    expect(r.ok).toBe(false);
  });

  it("fails when the create is refused", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: pooledRoutes(), api: gateway({ createStatus: 422 }) });
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(POOLED_MANIFEST, true), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "zavi:write-create")).toMatchObject({ ok: false, reason: expect.stringMatching(/HTTP 422/) });
    expect(r.ok).toBe(false);
    expect(r.infrastructure_error).toBeUndefined();
  });

  it("a gateway 5xx on the create is a platform failure (infrastructure: retry, never a paid repair)", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: pooledRoutes(), api: gateway({ createStatus: 503 }) });
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(POOLED_MANIFEST, true), launch: f.launch });
    expect(r).toMatchObject({ ok: false, infrastructure_error: true, error: expect.stringMatching(/HTTP 503 \(a platform failure\)/) });
  });

  it("the sign-in service answering the session hop with no session is a platform failure", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: pooledRoutes(), api: gateway(), ownerLink: LINK, owner: { reachesAdmin: true, token: null } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(POOLED_MANIFEST, true), launch: f.launch });
    expect(r).toMatchObject({ ok: false, infrastructure_error: true, error: expect.stringMatching(/issued no session/) });
  });

  it("a session hop with no session is a platform failure even when /admin is never reached", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: pooledRoutes(), api: gateway(), ownerLink: LINK, owner: { reachesAdmin: false, token: null } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(POOLED_MANIFEST, true), launch: f.launch });
    expect(r).toMatchObject({ ok: false, infrastructure_error: true, error: expect.stringMatching(/issued no session \(the owner sign-in did not reach \/admin/) });
  });

  it("reaching /admin without ever finishing the link at /auth/confirm is the site's failure", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: pooledRoutes(), api: gateway(), ownerLink: LINK, owner: { reachesAdmin: true, token: null, noCallback: true } });
    const r = await runner.runGate({ baseUrl: PREVIEW, ownerLink: LINK, config: cfg(POOLED_MANIFEST, true), launch: f.launch });
    expect(r.infrastructure_error).toBeUndefined();
    expect(r.owner).toMatchObject({ ok: false, reason: expect.stringMatching(/without finishing the sign-in link/) });
  });

  it("no write journey without allow_writes, but the no-write read probe still runs", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: pooledRoutes(), api: gateway() });
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(POOLED_MANIFEST, false), launch: f.launch });
    expect(r.journeys.some((j) => j.name.startsWith("zavi:write"))).toBe(false);
    expect(r.journeys.find((j) => j.name === "zavi:read-denied")).toMatchObject({ ok: true });
    expect(f.calls.api.some((a) => a.method === "POST")).toBe(false);
  });

  it("the read probe fails when a signed-out visitor can list a protected collection", async () => {
    const leaky = (q: ApiReq) =>
      q.method === "GET" && q.path.startsWith("/api/data/messages?") ? { status: 200, body: { data: { items: [{ id: "x" }] } } } : { status: 404 };
    const f = fakeLaunch({ origin: ORIGIN, routes: pooledRoutes(), api: leaky });
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(POOLED_MANIFEST, false), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "zavi:read-denied")).toMatchObject({ ok: false, reason: "a signed-out visitor can list messages records" });
    expect(r.ok).toBe(false);
  });
});

it("marks browser context creation failure as infrastructure, not a site defect", async () => {
  const result = await runner.runGate({
    baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST),
    launch: async () => ({
      newContext: async () => { throw new Error("browser disconnected"); },
      close: async () => {},
    }),
  });
  expect(result).toMatchObject({ ok: false, infrastructure_error: true, error: "browser disconnected" });
});

it("marks mobile context setup failure as infrastructure after healthy desktop journeys", async () => {
  const f = fakeLaunch({ origin: ORIGIN, routes: healthy() });
  const browser = await f.launch();
  const newContext = browser.newContext;
  let calls = 0;
  browser.newContext = async (options) => {
    if (++calls === 2) throw new Error("browser disconnected");
    return newContext(options);
  };
  const result = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
  expect(result).toMatchObject({ ok: false, infrastructure_error: true, error: "browser disconnected" });
});

it("a browser disconnected during a journey is infrastructure, while site failures stay repairable", async () => {
  const f = fakeLaunch({ origin: ORIGIN, routes: healthy(), entryStatus: 403 });
  const browser = await f.launch();
  const result = await runner.runGate({
    baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST),
    launch: async () => ({ ...browser, isConnected: () => false }),
  });
  expect(result).toMatchObject({ ok: false, infrastructure_error: true, error: "the smoke browser disconnected" });
});

describe("booking dry run (read-only gate)", () => {
  const BOOKING_MANIFEST = JSON.stringify({
    smoke: {
      journeys: [
        { name: "home", path: "/" },
        {
          name: "book",
          path: "/book",
          expect: "[data-zavi=book-form]",
          writes: true,
          steps: [
            { fill: "[data-zavi=book-name]", value: "Test {smoke}" },
            { click: "[data-zavi=book-submit]" },
            { expectText: "You're booked" },
          ],
        },
      ],
    },
  });
  const ENDPOINT = "https://ref.supabase.co/rest/v1/bookings";

  function bookingSite(opts: { submits?: boolean; body?: string; preflight?: number } = {}): FakeSite {
    return {
      origin: ORIGIN,
      routes: {
        ...healthy(),
        "/book": {
          status: 200,
          text: "Book a time",
          selectors: ["[data-zavi=book-form]", "[data-zavi=book-name]", "[data-zavi=book-submit]"],
          ...(opts.submits === false
            ? {}
            : { submits: { "[data-zavi=book-submit]": { method: "POST", url: ENDPOINT, ...(opts.body !== undefined ? { body: opts.body } : {}) } } }),
        },
      },
      api: (r) => (r.method === "OPTIONS" && r.path === "/rest/v1/bookings" ? { status: opts.preflight ?? 204 } : { status: 404 }),
    };
  }

  function dryRunCfg(): GateRunnerConfig {
    const c = cfg(BOOKING_MANIFEST, false);
    c.journeys.find((j) => j.name === "book")!.dry_run = true;
    return c;
  }

  it("without dry_run the booking journey is skipped on a read-only gate (the old 'exists only' behaviour)", async () => {
    const f = fakeLaunch(bookingSite());
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(BOOKING_MANIFEST, false), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "book")).toMatchObject({ skipped: true, reason: "writes not allowed" });
  });

  it("passes when the form submits the tagged test booking and the endpoint answers a preflight; nothing is written", async () => {
    const f = fakeLaunch(bookingSite());
    const r = await runner.runGate({ baseUrl: PREVIEW, config: dryRunCfg(), launch: f.launch });
    const book = r.journeys.find((j) => j.name === "book");
    expect(book).toMatchObject({ ok: true });
    expect(book?.skipped).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(f.calls.api.filter((a) => a.path === "/rest/v1/bookings").map((a) => a.method)).toEqual(["OPTIONS"]);
  });

  it("fails when submitting sends nothing", async () => {
    const f = fakeLaunch(bookingSite({ submits: false }));
    const r = await runner.runGate({ baseUrl: PREVIEW, config: dryRunCfg(), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "book")).toMatchObject({ ok: false, reason: "the booking form never sent the booking when submitted" });
    expect(r.ok).toBe(false);
  });

  it("fails when the request sent is not the test booking the form was filled with", async () => {
    const f = fakeLaunch(bookingSite({ body: JSON.stringify({ name: "someone else" }) }));
    const r = await runner.runGate({ baseUrl: PREVIEW, config: dryRunCfg(), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "book")?.reason).toMatch(/not the test booking/);
  });

  it("fails when the address it submits to is missing or broken", async () => {
    for (const status of [404, 502]) {
      const f = fakeLaunch(bookingSite({ preflight: status }));
      const r = await runner.runGate({ baseUrl: PREVIEW, config: dryRunCfg(), launch: f.launch });
      expect(r.journeys.find((j) => j.name === "book")?.reason).toBe(`the booking form submits to /rest/v1/bookings, which answers HTTP ${status}`);
    }
  });

  it("a same-origin data endpoint (Zavi's gateway) answering 503 to the preflight is a platform failure, not the site's", async () => {
    const site = bookingSite();
    site.routes["/book"].submits = { "[data-zavi=book-submit]": { method: "POST", url: `${ORIGIN}/api/data/bookings` } };
    site.api = (r) => (r.method === "OPTIONS" && r.path === "/api/data/bookings" ? { status: 503 } : { status: 404 });
    const r = await runner.runGate({ baseUrl: PREVIEW, config: dryRunCfg(), launch: fakeLaunch(site).launch });
    expect(r).toMatchObject({ ok: false, infrastructure_error: true, error: expect.stringMatching(/answered 503 on \/api\/data\/bookings/) });
  });

  it("fails when the form itself is missing", async () => {
    const site = bookingSite();
    site.routes["/book"] = { status: 200, text: "Coming soon" };
    const f = fakeLaunch(site);
    const r = await runner.runGate({ baseUrl: PREVIEW, config: dryRunCfg(), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "book")?.ok).toBe(false);
  });

  it("dry_run never runs on a writing gate: there the real booking journey runs", async () => {
    const c = cfg(BOOKING_MANIFEST, true);
    c.journeys.find((j) => j.name === "book")!.dry_run = true;
    const f = fakeLaunch(bookingSite());
    const r = await runner.runGate({ baseUrl: PREVIEW, config: c, launch: f.launch });
    expect(r.journeys.find((j) => j.name === "book")?.reason).toMatch(/You're booked/);
  });
});

describe("booking on a writing gate proves the write", () => {
  const MANIFEST = JSON.stringify({
    smoke: {
      journeys: [
        {
          name: "book",
          path: "/book",
          expect: "[data-zavi=book-form]",
          writes: true,
          steps: [
            { fill: "[data-zavi=book-name]", value: "Test {smoke}" },
            { click: "[data-zavi=book-submit]" },
            { expectText: "You're booked" },
          ],
        },
      ],
    },
  });
  const ENDPOINT = `${ORIGIN}/api/data/bookings`;
  function site(opts: { submits?: boolean; status?: number } = {}): FakeSite {
    return {
      origin: ORIGIN,
      routes: {
        ...healthy(),
        "/book": {
          status: 200,
          text: "Book a time. You're booked",
          selectors: ["[data-zavi=book-form]", "[data-zavi=book-name]", "[data-zavi=book-submit]"],
          ...(opts.submits === false ? {} : { submits: { "[data-zavi=book-submit]": { method: "POST", url: ENDPOINT } } }),
        },
      },
      api: (r) => (r.method === "POST" && r.path === "/api/data/bookings" ? { status: opts.status ?? 201 } : { status: 404 }),
    };
  }
  function bookingCfg(): GateRunnerConfig {
    const c = cfg(MANIFEST, true);
    c.journeys.find((j) => j.name === "book")!.booking = true;
    return c;
  }

  it("passes when the tagged booking reaches the server and is accepted", async () => {
    const f = fakeLaunch(site());
    const r = await runner.runGate({ baseUrl: PREVIEW, config: bookingCfg(), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "book")).toMatchObject({ ok: true });
  });

  it("a client-only success message fails: nothing reached the server", async () => {
    const f = fakeLaunch(site({ submits: false }));
    const r = await runner.runGate({ baseUrl: PREVIEW, config: bookingCfg(), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "book")?.reason).toBe("the booking form never sent the test booking to the server");
  });

  it("a booking the server refuses fails with its answer", async () => {
    const f = fakeLaunch(site({ status: 400 }));
    const r = await runner.runGate({ baseUrl: PREVIEW, config: bookingCfg(), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "book")?.reason).toBe("the server refused the test booking: /api/data/bookings answered HTTP 400");
  });
});

describe("booking dry run: the preflight a real browser needs", () => {
  const MANIFEST = JSON.stringify({
    smoke: {
      journeys: [
        {
          name: "book",
          path: "/book",
          writes: true,
          steps: [{ fill: "[data-zavi=book-name]", value: "Test {smoke}" }, { click: "[data-zavi=book-submit]" }],
        },
      ],
    },
  });
  function site(type: string, preflight: number, method = "POST", headers?: Record<string, string>): FakeSite {
    return {
      origin: ORIGIN,
      routes: {
        ...healthy(),
        "/book": {
          status: 200,
          text: "Book",
          selectors: ["[data-zavi=book-name]", "[data-zavi=book-submit]"],
          submits: { "[data-zavi=book-submit]": { method, url: "https://api.example.com/book", type, ...(headers ? { headers } : {}) } },
        },
      },
      api: (r) => (r.method === "OPTIONS" ? { status: preflight } : { status: 404 }),
    };
  }
  function dry(): GateRunnerConfig {
    const c = cfg(MANIFEST, false);
    c.journeys.find((j) => j.name === "book")!.dry_run = true;
    return c;
  }

  it("a cross-origin JSON booking whose preflight is refused fails (the browser would never send it)", async () => {
    const f = fakeLaunch(site("application/json", 405));
    const r = await runner.runGate({ baseUrl: PREVIEW, config: dry(), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "book")?.reason).toBe(
      "the booking form submits to /book, which refuses the browser's preflight (HTTP 405)",
    );
  });

  it("a form-encoded request is still non-simple when its method or headers need a preflight", async () => {
    const cases: Array<[string, Record<string, string> | undefined]> = [
      ["PUT", undefined],
      ["POST", { authorization: "Bearer x" }],
      ["POST", { "x-requested-with": "fetch" }],
    ];
    for (const [method, headers] of cases) {
      const f = fakeLaunch(site("application/x-www-form-urlencoded", 405, method, headers));
      const r = await runner.runGate({ baseUrl: PREVIEW, config: dry(), launch: f.launch });
      expect(r.journeys.find((j) => j.name === "book")?.reason).toMatch(/refuses the browser's preflight/);
    }
  });

  it("a cross-origin plain form post needs no preflight: a 405 to OPTIONS is not a failure", async () => {
    const f = fakeLaunch(site("application/x-www-form-urlencoded", 405));
    const r = await runner.runGate({ baseUrl: PREVIEW, config: dry(), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "book")).toMatchObject({ ok: true });
  });
});

describe("visible error text (zavi:error-text)", () => {
  const MENU_MANIFEST = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }, { name: "menu", path: "/menu" }, { name: "account", path: "/account" }, { name: "admin", path: "/admin" }] } });
  const routesWith = (over: Partial<Record<string, string>>, extra: Partial<FakeSite["routes"]> = {}): FakeSite["routes"] => {
    const r: FakeSite["routes"] = {
      "/": { status: 200, text: "Bloom Bakery\nFresh bread every morning" },
      "/menu": { status: 200, text: "Our menu\nSourdough" },
      "/account": { status: 200, text: "Your account\nPlease sign in to continue." },
      "/admin": { status: 200, text: "Owner admin\nSign in to manage your site" },
    };
    for (const [k, v] of Object.entries(over)) r[k] = { ...r[k], text: v };
    return { ...r, ...extra } as FakeSite["routes"];
  };
  const run = (routes: FakeSite["routes"], manifest = MENU_MANIFEST) =>
    runner.runGate({ baseUrl: PREVIEW, config: cfg(manifest), launch: fakeLaunch({ origin: ORIGIN, routes }).launch });
  const errorText = (r: Awaited<ReturnType<typeof run>>) => r.journeys.find((j) => j.name === "zavi:error-text");

  it("an SDK error the page caught and rendered (no console error, no page error) fails the gate, naming the route and the exact text", async () => {
    const r = await run(routesWith({ "/": "Bloom Bakery\nSomething went wrong on our side. Please try again." }));
    expect(r.journeys.find((j) => j.name === "zavi:home")).toMatchObject({ ok: true });
    expect(errorText(r)).toMatchObject({ ok: false, reason: 'visible error text on /: "Something went wrong on our side. Please try again."' });
    expect(r.ok).toBe(false);
  });

  it("checks every declared route the gate visits, not only home", async () => {
    const r = await run(routesWith({ "/menu": "Our menu\nFailed to load the menu" }));
    expect(errorText(r)).toMatchObject({ ok: false, reason: 'visible error text on /menu: "Failed to load the menu"' });
  });

  it("every error message the site SDK can show a visitor is caught", () => {
    const benign = new Set(["Please sign in to continue.", "Please check the details and try again.", "Sorry, that's fully booked.", "That was already taken. Please pick another option.", "This works on the published site, not in the preview."]);
    const shown = new Set<string>([userMessage(new Error("boom"))]);
    for (const code of ZAVI_ERROR_CODES) {
      shown.add(userMessage(new ZaviError(code, "", { status: 400 })));
      shown.add(userMessage(new ZaviError(code, "", { status: 403, reason: "forbidden" })));
    }
    shown.add(userMessage(new ZaviError("conflict", "", { reason: "action_bound" })));
    shown.add(userMessage(new ZaviError("not_allowed", "", { status: 401 })));
    shown.add(userMessage(new ZaviError("server", "", { reason: "function_preview_only" })));
    const errors = [...shown].filter((m) => !benign.has(m));
    expect(errors.length).toBeGreaterThanOrEqual(7);
    for (const m of errors) expect(runner.findErrorText("/", `Bloom Bakery\n${m}`), m).toBe(m);
    for (const m of benign) if (shown.has(m)) expect(runner.findErrorText("/", m), m).toBeNull();
  });

  it("the generic patterns: setup, loading and runtime error text, curly apostrophes included", () => {
    for (const t of [
      "This site is not configured yet.",
      "Error loading bookings",
      "Failed to fetch",
      "This can\u2019t be saved right now. Please contact us and we\u2019ll sort it out.",
      "An unexpected error occurred",
      "TypeError: Cannot read properties of undefined (reading 'map')",
      "ReferenceError: process is not defined",
      "undefined is not a function",
    ]) {
      expect(runner.findErrorText("/", `Bloom Bakery\n${t}`), t).toBe(t);
    }
  });

  it("normal copy that mentions errors, failure or loading is not flagged", () => {
    for (const t of [
      "Error-free bookings, every time",
      "We fix errors in your tax return",
      "Our process never fails",
      "Load up on fresh bread",
      "Failure is part of learning to bake",
      "No errors, no stress",
    ]) {
      expect(runner.findErrorText("/", t), t).toBeNull();
    }
  });

  it("the starter's own placeholder sentence left on a page is caught, in both starters, but a real welcome is not", () => {
    for (const home of [ZAVI_STARTER["src/pages/Home.tsx"], SUPABASE_STARTER["src/pages/Home.tsx"]]) {
      const placeholder = /(?:<p[^>]*>|\bsubtitle=")([^<"]*being built[^<"]*)/.exec(home)?.[1]?.trim();
      expect(placeholder).toBeTruthy();
      expect(runner.findErrorText("/", `Bloom Bakery\n${placeholder}`)).toBe(placeholder);
    }
    for (const t of ["Welcome to Lotus Flow Yoga", "A new studio is being built on Elm Street, opening in May"]) {
      expect(runner.findErrorText("/", t), t).toBeNull();
    }
  });

  it("the starter's Welcome heading is caught only as the placeholder pair; lorem ipsum filler is caught; real copy that says welcome is not", () => {
    for (const home of [ZAVI_STARTER["src/pages/Home.tsx"], SUPABASE_STARTER["src/pages/Home.tsx"]]) {
      const heading = /(?:<h1[^>]*>|\btitle=")([^<"]*)/.exec(home)?.[1]?.trim() ?? "";
      expect(heading).toBe("Welcome");
      expect(runner.findErrorText("/", `${heading}\nThis site is coming soon`)).toBe("Welcome");
      expect(runner.findErrorText("/", `${heading.toUpperCase()}\nCheck back soon for our menu`)).toBe("WELCOME");
    }
    for (const t of ["Lorem ipsum dolor sit amet, consectetur adipiscing elit.", "Our story. Lorem Ipsum goes here", "Consectetur dolor sit amet"]) {
      expect(runner.findErrorText("/", `Bloom Bakery\n${t}`), t).toBe(t.trim());
    }
    for (const t of [
      "WELCOME\nFind your breath at Lotus Flow",
      "Welcome\nFresh bread every morning",
      "welcome",
      "Welcome to Sunrise Bakery",
      "Welcome back, Sam",
      "You are always welcome here",
      "Welcome!",
      "Welcomes every dog",
      "Dolores sits at the front desk",
    ]) {
      expect(runner.findErrorText("/", `Bloom Bakery\n${t}`), t).toBeNull();
    }
  });

  it("placeholder pages fail the publish gate and the preview scan alike, and a real welcome passes both", async () => {
    const scan = (routes: FakeSite["routes"]) =>
      runner.runGate({ baseUrl: PREVIEW, config: buildScanConfig({ tag: TAG }), launch: fakeLaunch({ origin: ORIGIN, routes }).launch });
    for (const text of ["Welcome\nThis site is coming soon", "Bloom Bakery\nLorem ipsum dolor sit amet, consectetur adipiscing elit."]) {
      const gate = await run(routesWith({ "/": text }));
      expect(errorText(gate), text).toMatchObject({ ok: false });
      expect(gate.ok).toBe(false);
      const scanned = await scan({ "/": { status: 200, text } });
      expect(scanned.journeys.find((j) => j.name === "zavi:error-text"), text).toMatchObject({ ok: false });
      expect(scanned.ok).toBe(false);
    }
    const real = "Welcome to Sunrise Bakery\nFresh bread every morning";
    const gate = await run(routesWith({ "/": real }));
    expect(errorText(gate)).toMatchObject({ ok: true });
    const scanned = await scan({ "/": { status: 200, text: real } });
    expect(scanned.journeys.find((j) => j.name === "zavi:error-text")).toMatchObject({ ok: true });
    expect(scanned.ok).toBe(true);
  });

  it("sign-in prompts on /login, /account and /admin are expected; an error there still fails", async () => {
    const ok = await run(routesWith({}));
    expect(errorText(ok)).toMatchObject({ ok: true });
    expect(ok.ok).toBe(true);
    expect(runner.findErrorText("/login", "Sign in\nPlease sign in to continue.")).toBeNull();
    expect(runner.findErrorText("/account/orders", "Log in to see your orders")).toBeNull();
    const bad = await run(routesWith({ "/admin": "Owner admin\nSign in to manage your site\nSomething went wrong. Please try again." }));
    expect(errorText(bad)).toMatchObject({ ok: false, reason: 'visible error text on /admin: "Something went wrong. Please try again."' });
  });

  it("text the visitor typed into an input or textarea is never flagged", async () => {
    const routes = routesWith({ "/menu": "Our menu\nLeave a note\nSomething went wrong with my last order" });
    routes["/menu"].fields = ["Something went wrong with my last order"];
    const r = await run(routes);
    expect(errorText(r)).toMatchObject({ ok: true });
  });

  it("a long error line is cut to about 200 characters", () => {
    const long = "Failed to load " + "x".repeat(400);
    const hit = runner.findErrorText("/", long);
    expect(hit).toBe(long.slice(0, 200) + "...");
  });
});

describe("review screenshots", () => {
  const m = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }, { name: "menu", path: "/menu" }, { name: "about", path: "/about" }] } });
  const routes = (): FakeSite["routes"] => ({
    "/": { status: 200, text: "Bloom Bakery", ogTitle: "Bloom Bakery" },
    "/menu": { status: 200, text: "Menu" },
    "/about": { status: 200, text: "About" },
  });

  it("off by default: no screenshot is taken and the output carries none", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: routes() });
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(m), launch: f.launch });
    expect(r.ok).toBe(true);
    expect(f.calls.screenshots).toEqual([]);
    expect(r).not.toHaveProperty("screenshots");
  });

  it("on: home at desktop width, one other route, and home at 390px, as small viewport jpegs, with the og:title", async () => {
    const f = fakeLaunch({ origin: ORIGIN, routes: routes() });
    const r = await runner.runGate({ baseUrl: PREVIEW, config: { ...cfg(m), screenshots: true }, launch: f.launch });
    expect(r.ok).toBe(true);
    expect(f.calls.screenshots.map((s) => [s.width, s.path])).toEqual([[1280, "/"], [1280, "/menu"], [390, "/"]]);
    for (const s of f.calls.screenshots) expect(s).toMatchObject({ type: "jpeg", quality: 60, fullPage: false });
    expect(r.screenshots?.map((s) => [s.label, s.path, Buffer.from(s.data, "base64").toString()])).toEqual([
      ["desktop", "/", "shot:1280:/"],
      ["desktop", "/menu", "shot:1280:/menu"],
      ["mobile", "/", "shot:390:/"],
    ]);
    expect(r.og_title).toBe("Bloom Bakery");
  });
});

describe("images journey (site_images)", () => {
  const withImages = (images: Array<{ src: string; naturalWidth: number; complete?: boolean }>): FakeSite => ({
    origin: ORIGIN,
    routes: { ...healthy(), "/": { ...healthy()["/"], images } },
  });
  const imagesCfg = (require_loaded: boolean): GateRunnerConfig =>
    buildRunnerConfig({ manifestRaw: DEDICATED_MANIFEST, allow_writes: false, tag: TAG, images: { require_loaded } });

  it("runs only when the config asks for it", async () => {
    const f = fakeLaunch(withImages([]));
    const r = await runner.runGate({ baseUrl: PREVIEW, config: cfg(DEDICATED_MANIFEST), launch: f.launch });
    expect(r.journeys.some((j) => j.name === "zavi:images")).toBe(false);
  });

  it("passes when the home page shows a loaded generated photo", async () => {
    const f = fakeLaunch(withImages([{ src: `${ORIGIN}/images/hero-1600.webp`, naturalWidth: 1600 }]));
    const r = await runner.runGate({ baseUrl: PREVIEW, config: imagesCfg(true), launch: f.launch });
    expect(r.journeys.find((j) => j.name === "zavi:images")).toMatchObject({ ok: true });
    expect(r.ok).toBe(true);
  });

  it("fails on a broken image and names its path, never the host", async () => {
    const f = fakeLaunch(
      withImages([
        { src: `${ORIGIN}/images/hero-1600.webp`, naturalWidth: 1600 },
        { src: `${ORIGIN}/images/missing.webp`, naturalWidth: 0 },
      ]),
    );
    const r = await runner.runGate({ baseUrl: PREVIEW, config: imagesCfg(false), launch: f.launch });
    const j = r.journeys.find((x) => x.name === "zavi:images");
    expect(j?.ok).toBe(false);
    expect(j?.reason).toContain("/images/missing.webp");
    expect(j?.reason).not.toContain(ORIGIN);
  });

  it("an own image that never finishes loading fails, even next to a loaded one", async () => {
    const f = fakeLaunch(
      withImages([
        { src: `${ORIGIN}/images/hero-1600.webp`, naturalWidth: 1600 },
        { src: `${ORIGIN}/images/slow.webp`, naturalWidth: 0, complete: false },
      ]),
    );
    const r = await runner.runGate({ baseUrl: PREVIEW, config: imagesCfg(true), launch: f.launch });
    const j = r.journeys.find((x) => x.name === "zavi:images");
    expect(j?.ok).toBe(false);
    expect(j?.reason).toContain("/images/slow.webp");
  });

  it("fails a hotlinked image on its address alone, loaded or not, and allows data: images", async () => {
    for (const naturalWidth of [0, 1200]) {
      const f = fakeLaunch(withImages([{ src: "https://cdn.other.example/x.jpg", naturalWidth }]));
      const r = await runner.runGate({ baseUrl: PREVIEW, config: imagesCfg(false), launch: f.launch });
      expect(r.journeys.find((j) => j.name === "zavi:images")?.reason).toMatch(/hotlinked from cdn\.other\.example/);
    }
    const inline = fakeLaunch(withImages([{ src: "data:image/png;base64,AAAA", naturalWidth: 1 }]));
    const ok = await runner.runGate({ baseUrl: PREVIEW, config: imagesCfg(false), launch: inline.launch });
    expect(ok.journeys.find((j) => j.name === "zavi:images")?.ok).toBe(true);
  });

  it("with owned photos, one of THOSE must load (another image does not count)", async () => {
    const owned = buildRunnerConfig({
      manifestRaw: DEDICATED_MANIFEST,
      allow_writes: false,
      tag: TAG,
      images: { require_loaded: true, owned: ["/images/hero-1600.webp", "/images/hero-800.webp"] },
    });
    const other = await runner.runGate({ baseUrl: PREVIEW, config: owned, launch: fakeLaunch(withImages([{ src: `${ORIGIN}/logo.png`, naturalWidth: 64 }])).launch });
    expect(other.journeys.find((j) => j.name === "zavi:images")?.ok).toBe(false);
    const small = await runner.runGate({ baseUrl: PREVIEW, config: owned, launch: fakeLaunch(withImages([{ src: `${ORIGIN}/images/hero-800.webp`, naturalWidth: 800 }])).launch });
    expect(small.journeys.find((j) => j.name === "zavi:images")?.ok).toBe(true);
  });

  describe("empty image placeholders (2026-10-07: a site went live with four grey 'image' boxes)", () => {
    type Ph = NonNullable<FakeSite["routes"][string]["placeholders"]>;
    const withPlaceholders = (placeholders: Ph): FakeSite => ({
      origin: ORIGIN,
      routes: { ...healthy(), "/": { ...healthy()["/"], images: [], placeholders } },
    });
    const run = async (placeholders: Ph) =>
      (await runner.runGate({ baseUrl: PREVIEW, config: imagesCfg(false), launch: fakeLaunch(withPlaceholders(placeholders)).launch })).journeys.find(
        (j) => j.name === "zavi:images",
      );

    it("fails a photo-sized box holding only an image icon, and tells the builder to use the no-image layout", async () => {
      const j = await run([{ kind: "icon" }, { kind: "icon", text: "Photo" }]);
      expect(j?.ok).toBe(false);
      expect(j?.reason).toMatch(/2 empty image placeholder box/);
      expect(j?.reason).toMatch(/Do not call add_site_images again/);
    });

    it("fails an image the starter swapped for a panel because its file did not load", async () => {
      const f = fakeLaunch({ origin: ORIGIN, routes: { ...healthy(), "/": { ...healthy()["/"], images: [], imageErrors: 1 } } });
      const j = (await runner.runGate({ baseUrl: PREVIEW, config: imagesCfg(false), launch: f.launch })).journeys.find((x) => x.name === "zavi:images");
      expect(j?.ok).toBe(false);
      expect(j?.reason).toMatch(/did not load/);
    });

    it("fails a photo-sized box whose only text is an image label", async () => {
      for (const text of ["Image", "hero image", "Image placeholder", "Your photo here", "Photo"]) {
        expect((await run([{ kind: "label", text }]))?.ok, text).toBe(false);
      }
    });

    it("passes the no-image layout: a brand panel showing a feature's own icon, small icon badges, real text and real media", async () => {
      expect((await run([{ kind: "icon", inBrandPanel: true }]))?.ok).toBe(true);
      expect((await run([{ kind: "icon", width: 48, height: 48 }]))?.ok).toBe(true);
      expect((await run([{ kind: "icon", text: "Wedding photography in natural light" }]))?.ok).toBe(true);
      expect((await run([{ kind: "icon", media: true }]))?.ok).toBe(true);
      expect((await run([{ kind: "label", text: "Photos" , width: 90, height: 30 }]))?.ok).toBe(true);
      expect((await run([{ kind: "label", text: "Fresh sourdough every morning" }]))?.ok).toBe(true);
      expect((await run([{ kind: "icon", inHeader: true }]))?.ok).toBe(true);
      expect((await run([{ kind: "label", text: "Photos" }, { kind: "label", text: "Images" }]))?.ok).toBe(true);
      expect((await run([{ kind: "icon", text: "Photos" }]))?.ok).toBe(true);
    });
  });

  it("requires a loaded image only when the site has generated photos", async () => {
    const required = await runner.runGate({ baseUrl: PREVIEW, config: imagesCfg(true), launch: fakeLaunch(withImages([])).launch });
    expect(required.journeys.find((j) => j.name === "zavi:images")?.ok).toBe(false);
    const optional = await runner.runGate({ baseUrl: PREVIEW, config: imagesCfg(false), launch: fakeLaunch(withImages([])).launch });
    expect(optional.journeys.find((j) => j.name === "zavi:images")?.ok).toBe(true);
  });
});

describe("page text for the page check", () => {
  const twice = "Our crew arrives on time and leaves the place spotless.";
  it("returns each page's content blocks: planned sections when marked, never header/nav/footer", async () => {
    const routes = healthy();
    routes["/"] = {
      ...routes["/"],
      blocks: [
        { text: "Hero  copy\n here", mark: "hero" },
        { text: twice, mark: "reviews" },
        { text: twice, mark: "reviews" },
        { text: "Site menu", mark: "nav", chrome: true },
        { text: "an unmarked section is ignored when the page has marks" },
      ],
    };
    const config = { ...cfg(DEDICATED_MANIFEST), page_text: true };
    const { launch } = fakeLaunch({ origin: ORIGIN, routes });
    const out = await runner.runGate({ baseUrl: PREVIEW, config, launch });
    const home = out.page_text!.find((p) => p.path === "/")!;
    expect(home.sections).toEqual(["hero", "reviews", "reviews", "nav"]);
    expect(home.blocks).toEqual([
      { len: 14, head: "Hero copy here", mark: "hero" },
      { len: twice.length, head: twice, mark: "reviews" },
      { len: twice.length, head: twice, mark: "reviews" },
    ]);
  });

  it("never counts a hidden block (a desktop/mobile twin of the same section)", async () => {
    const routes = healthy();
    routes["/"] = { ...routes["/"], blocks: [{ text: twice, mark: "reviews" }, { text: twice, mark: "reviews", hidden: true }] };
    const config = { ...cfg(DEDICATED_MANIFEST), page_text: true };
    const { launch } = fakeLaunch({ origin: ORIGIN, routes });
    const out = await runner.runGate({ baseUrl: PREVIEW, config, launch });
    expect(out.page_text!.find((p) => p.path === "/")!.blocks).toEqual([{ len: twice.length, head: twice, mark: "reviews" }]);
  });

  it("without marks, reads the innermost sections only", async () => {
    const routes = healthy();
    routes["/"] = { ...routes["/"], blocks: [{ text: "outer wrapper", wraps: true }, { text: "inner one" }, { text: "in the footer", chrome: true }] };
    const config = { ...cfg(DEDICATED_MANIFEST), page_text: true };
    const { launch } = fakeLaunch({ origin: ORIGIN, routes });
    const out = await runner.runGate({ baseUrl: PREVIEW, config, launch });
    expect(out.page_text!.find((p) => p.path === "/")!.blocks).toEqual([{ len: 9, head: "inner one" }]);
  });
});
