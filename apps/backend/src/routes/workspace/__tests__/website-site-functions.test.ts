import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { createSiteFunctionsHandlers, type SiteFunctionsRouteDeps } from "../website-site-functions";
import { BuildSessionError, type BuildSessionApp } from "@/services/sites/session-site";
import { SiteFunctionsError, type SiteFunctionsService } from "@/services/site-functions/contract";
import type { AuthedRequest } from "@/services/auth/middleware";

const TENANT = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
const SITE = "11111111-1111-4111-8111-111111111111";
const BUILD = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const SECRET = ["sk", "test", "51NabcdefGHIJKLmnopQRSTuv"].join("_");

function fakeService(over: Partial<SiteFunctionsService> = {}): SiteFunctionsService & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const svc: SiteFunctionsService = {
    listSecrets: async (site) => {
      calls.push(["listSecrets", site]);
      return { secrets: [{ name: "STRIPE_SECRET_KEY", updated_at: "2026-10-02T00:00:00Z", value: SECRET } as never], required: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] };
    },
    putSecret: async (site, name, value, actor) => {
      calls.push(["putSecret", site, name, value, actor]);
      return { name, updated_at: "2026-10-02T00:00:00Z", value } as never;
    },
    deleteSecret: async (site, name) => {
      calls.push(["deleteSecret", site, name]);
      return name === "STRIPE_SECRET_KEY";
    },
    listFunctions: async () => [
      { name: "stripe-webhook", kind: "webhook", url: "https://shop.example.com/api/hooks/stripe-webhook", cron: null, enabled: null, last_run: null },
      { name: "nightly", kind: "schedule", url: null, cron: "0 3 * * *", enabled: true, last_run: { id: "r1", started_at: "t", duration_ms: 12, status: "ok", http_status: 200 } },
    ],
    listRuns: async (_site, fn) =>
      fn === "nightly"
        ? [{ id: "r1", started_at: "t", duration_ms: 12, status: "error", http_status: 500, log: [{ at: "t", level: "error", message: `stripe said no to ${SECRET}` }] }]
        : null,
    setScheduleEnabled: async (_site, name, enabled) =>
      name === "nightly" ? { name, kind: "schedule", url: null, cron: "0 3 * * *", enabled, last_run: null } : null,
    ...over,
  };
  return Object.assign(svc, { calls });
}

function harness(opts: { role?: boolean; session?: BuildSessionApp | Error; svc?: SiteFunctionsService | null; authed?: boolean } = {}) {
  const svc = opts.svc === undefined ? fakeService() : opts.svc;
  const resolveSession = vi.fn(async (): Promise<BuildSessionApp> => {
    const s = opts.session ?? { kind: "site", run_id: BUILD, site: { id: SITE, tenant_id: TENANT } as never };
    if (s instanceof Error) throw s;
    return s;
  });
  const deps: SiteFunctionsRouteDeps = {
    requireAuth: async (_req, res) => {
      if (opts.authed === false) {
        res.status(401).json({ error: { code: "unauthorized" } });
        return null;
      }
      return { tenant_id: TENANT, user_id: "u-1", access_token: "tok" } as AuthedRequest;
    },
    requireOwnerOrAdmin: async (_auth, res) => {
      if (opts.role === false) {
        res.status(403).json({ error: { code: "forbidden" } });
        return false;
      }
      return true;
    },
    resolveSession,
    service: () => svc,
  };
  return { h: createSiteFunctionsHandlers(deps), svc, resolveSession };
}

async function call(
  fn: (req: Request, res: Response) => Promise<void>,
  req: { query?: Record<string, unknown>; body?: Record<string, unknown>; params?: Record<string, string> },
) {
  let status = 200;
  let body: any = null;
  const res = {
    status(c: number) {
      status = c;
      return this;
    },
    json(p: unknown) {
      body = p;
      return this;
    },
  } as unknown as Response;
  await fn({ query: req.query ?? {}, body: req.body ?? {}, params: req.params ?? {}, headers: {} } as unknown as Request, res);
  return { status, body, text: JSON.stringify(body) };
}

describe("site functions owner routes", () => {
  it("overview returns secret NAMES only and the functions, scoped to the session's site", async () => {
    const { h, svc, resolveSession } = harness();
    const r = await call(h.overview, { query: { build_session_id: BUILD } });
    expect(r.status).toBe(200);
    expect(r.body.secrets).toEqual({ secrets: [{ name: "STRIPE_SECRET_KEY", updated_at: "2026-10-02T00:00:00Z" }], required: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] });
    expect(r.text).not.toContain(SECRET);
    expect(r.body.functions.map((f: { name: string }) => f.name)).toEqual(["stripe-webhook", "nightly"]);
    expect(resolveSession).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT }), BUILD);
    expect((svc as ReturnType<typeof fakeService>).calls[0]).toEqual(["listSecrets", { tenant_id: TENANT, site_id: SITE }]);
  });

  it("put stores the value and answers without it", async () => {
    const { h, svc } = harness();
    const r = await call(h.putSecret, { params: { name: "STRIPE_SECRET_KEY" }, body: { build_session_id: BUILD, value: SECRET } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ secret: { name: "STRIPE_SECRET_KEY", updated_at: "2026-10-02T00:00:00Z" } });
    expect(r.text).not.toContain(SECRET);
    const put = (svc as ReturnType<typeof fakeService>).calls.find((c) => c[0] === "putSecret")!;
    expect(put).toEqual(["putSecret", { tenant_id: TENANT, site_id: SITE }, "STRIPE_SECRET_KEY", SECRET, { user_id: "u-1" }]);
  });

  it("refuses bad names and empty values, never echoing the value", async () => {
    const { h } = harness();
    expect((await call(h.putSecret, { params: { name: "stripe key" }, body: { build_session_id: BUILD, value: SECRET } })).body.error.code).toBe("invalid_secret_name");
    expect((await call(h.putSecret, { params: { name: "ZAVI_X" }, body: { build_session_id: BUILD, value: "v" } })).body.error.code).toBe("invalid_secret_name");
    const empty = await call(h.putSecret, { params: { name: "STRIPE_SECRET_KEY" }, body: { build_session_id: BUILD, value: "  " } });
    expect(empty.body.error.code).toBe("invalid_secret_value");
    const big = await call(h.putSecret, { params: { name: "STRIPE_SECRET_KEY" }, body: { build_session_id: BUILD, value: "x".repeat(9000) } });
    expect(big.status).toBe(400);
  });

  it("delete: 404 when nothing was there", async () => {
    const { h } = harness();
    expect((await call(h.deleteSecret, { params: { name: "STRIPE_SECRET_KEY" }, query: { build_session_id: BUILD } })).body).toEqual({ deleted: true });
    expect((await call(h.deleteSecret, { params: { name: "OTHER_KEY" }, query: { build_session_id: BUILD } })).status).toBe(404);
  });

  it("run logs are masked even if the runtime let a key through", async () => {
    const { h } = harness();
    const r = await call(h.runs, { params: { name: "nightly" }, query: { build_session_id: BUILD, limit: "500" } });
    expect(r.status).toBe(200);
    expect(r.body.runs[0].log[0].message).toBe("stripe said no to [secret]");
    expect(r.text).not.toContain(SECRET);
    expect((await call(h.runs, { params: { name: "nope" }, query: { build_session_id: BUILD } })).status).toBe(404);
    expect((await call(h.runs, { params: { name: "../x" }, query: { build_session_id: BUILD } })).status).toBe(400);
  });

  it("schedules turn on and off; unknown is 404; enabled must be boolean", async () => {
    const { h } = harness();
    const off = await call(h.setSchedule, { params: { name: "nightly" }, body: { build_session_id: BUILD, enabled: false } });
    expect(off.body.function.enabled).toBe(false);
    expect((await call(h.setSchedule, { params: { name: "other" }, body: { build_session_id: BUILD, enabled: true } })).status).toBe(404);
    expect((await call(h.setSchedule, { params: { name: "nightly" }, body: { build_session_id: BUILD, enabled: "yes" } })).status).toBe(400);
  });

  it("gates: signed out, plain member, no session, foreign session, old-flow app, runtime not ready", async () => {
    expect((await call(harness({ authed: false }).h.overview, { query: { build_session_id: BUILD } })).status).toBe(401);
    const member = harness({ role: false });
    expect((await call(member.h.putSecret, { params: { name: "STRIPE_SECRET_KEY" }, body: { build_session_id: BUILD, value: SECRET } })).status).toBe(403);
    expect(member.resolveSession).not.toHaveBeenCalled();
    expect((await call(harness().h.overview, {})).body.error.code).toBe("build_session_required");
    const foreign = await call(harness({ session: new BuildSessionError(404, "build_session_not_found", "build session not found") }).h.overview, { query: { build_session_id: BUILD } });
    expect(foreign.status).toBe(404);
    const old = await call(harness({ session: { kind: "old_flow", run_id: BUILD } }).h.overview, { query: { build_session_id: BUILD } });
    expect(old.body.error.code).toBe("not_a_site");
    const down = await call(harness({ svc: null }).h.overview, { query: { build_session_id: BUILD } });
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("functions_unavailable");
  });

  it("a runtime refusal keeps its status; any other failure is a plain 503 with no detail", async () => {
    const refusing = harness({ svc: fakeService({ putSecret: async () => { throw new SiteFunctionsError(429, "too_many_secrets", "This site has too many secrets."); } }) });
    const r = await call(refusing.h.putSecret, { params: { name: "STRIPE_SECRET_KEY" }, body: { build_session_id: BUILD, value: SECRET } });
    expect(r.status).toBe(429);
    const crashing = harness({ svc: fakeService({ putSecret: async () => { throw new Error(`vault rejected ${SECRET}`); } }) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const c = await call(crashing.h.putSecret, { params: { name: "STRIPE_SECRET_KEY" }, body: { build_session_id: BUILD, value: SECRET } });
    expect(c.status).toBe(503);
    expect(c.text).not.toContain(SECRET);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    spy.mockRestore();
  });
});
