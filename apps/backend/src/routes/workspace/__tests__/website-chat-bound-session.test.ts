import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  refineProduct: vi.fn(),
  loadSiteForRun: vi.fn(async (..._a: unknown[]) => null as unknown),
  requireTenantRole: vi.fn(async (..._args: unknown[]) => true),
  isProductBuilderEnabled: vi.fn(async () => true),
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "b92dcbf1-bac9-457a-af81-0bbe5984339b", user_id: "u-1" })),
}));
vi.mock("@/services/auth/tenant-role", async (orig) => ({
  ...(await orig<typeof import("@/services/auth/tenant-role")>()),
  requireTenantRole: mocks.requireTenantRole,
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: mocks.isProductBuilderEnabled }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
const hosting = vi.hoisted(() => ({ url: "https://mohit-93bd8436.onrender.com" as string | null }));
const db = vi.hoisted(() => ({
  product_url: {} as Record<string, unknown>,
  buildRuns: new Set<string>(),
  buildRunsError: null as { message: string } | null,
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "tenants") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { product_url: db.product_url }, error: null }) }) }) };
      }
      if (table === "conductor_runs") {
        const filters: Record<string, string> = {};
        const q = {
          eq(col: string, v: string) {
            filters[col] = v;
            return q;
          },
          async maybeSingle() {
            if (db.buildRunsError) return { data: null, error: db.buildRunsError };
            const hit =
              filters.tenant_id === TENANT && filters.kind === "build_app" && db.buildRuns.has(filters.id!);
            return { data: hit ? { id: filters.id } : null, error: null };
          },
        };
        return { select: () => q };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: async () => ({
                data: hosting.url
                  ? [{ resource_kind: "hosting", status: "ready", external_ref: { url: hosting.url } }]
                  : [],
                error: null,
              }),
            }),
          }),
        }),
      };
    },
  }),
}));
vi.mock("@/services/agents/refine-product", async (orig) => {
  const real = await orig<typeof import("@/services/agents/refine-product")>();
  return {
    ...real,
    refineProduct: mocks.refineProduct,
    realRefineProductDeps: { ...real.realRefineProductDeps, loadSiteForRun: mocks.loadSiteForRun },
  };
});

import { postWebsiteChat } from "../website-chat";

const TENANT = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
const EDIT_MESSAGE = "Change the hero background to dark blue and add a pricing section";

async function route(
  message: string,
  confirm = false,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 200;
  let body: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      return this;
    },
  } as unknown as Response;
  await postWebsiteChat({ body: { message, confirm, ...extra }, headers: {} } as unknown as Request, res);
  return { status, body };
}

beforeEach(() => {
  mocks.refineProduct.mockReset();
  mocks.loadSiteForRun.mockReset();
  mocks.loadSiteForRun.mockResolvedValue(null);
  mocks.requireTenantRole.mockClear();
  db.product_url = {};
  db.buildRuns = new Set();
  db.buildRunsError = null;
  hosting.url = "https://mohit-93bd8436.onrender.com";
});

const BUILD = "d130919a-bec1-48bc-9dbf-fba65217f05a";

describe("postWebsiteChat — a bound build session outranks an own-site product_url", () => {
  beforeEach(() => {
    db.product_url = { marketing: "https://www.mohit.dev/" };
    db.buildRuns = new Set([BUILD]);
  });

  it("without the session, the own-site gate still wins (409), which is what sent Build-tab edits to the operator", async () => {
    const { status, body } = await route(EDIT_MESSAGE);
    expect(status).toBe(409);
    expect((body.error as { code: string }).code).toBe("preview_not_editable");
  });

  it("with the Build tab's SITE session id, the same message routes to app_edit", async () => {
    mocks.loadSiteForRun.mockResolvedValue({ id: "site-1", tenant_id: TENANT, status: "live" });
    const { status, body } = await route(EDIT_MESSAGE, false, { conductor_run_id: BUILD });
    expect(status).toBe(200);
    expect(body.route).toBe("app_edit");
  });

  it("an OLD-FLOW build session is frozen: refused with the Rebuild action, never confirmed or dispatched", async () => {
    const { status, body } = await route(EDIT_MESSAGE, true, { conductor_run_id: BUILD });
    expect(status).toBe(409);
    expect((body.error as { code: string; action: { kind: string } }).code).toBe("old_site_frozen");
    expect((body.error as { action: { kind: string } }).action.kind).toBe("rebuild_old_site");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("a named app that is not this tenant's build is refused, never turned into an unbound edit", async () => {
    db.buildRuns = new Set(["a8c8db32-bac4-4317-8625-d6502d953000"]);
    const { status, body } = await route(EDIT_MESSAGE, true, { conductor_run_id: BUILD });
    expect(status).toBe(404);
    expect((body.error as { code: string }).code).toBe("build_session_not_found");
    const junk = await route(EDIT_MESSAGE, true, { conductor_run_id: "not-a-uuid" });
    expect(junk.status).toBe(400);
    expect((junk.body.error as { code: string }).code).toBe("invalid_build_session");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("a plain question is still the operator's, session or not", async () => {
    const { body } = await route("Can you use this image on our website?", false, { conductor_run_id: BUILD });
    expect(body.route).toBe("operator");
  });

  it("a lookup error is a loud 503, never a silent 'not your build'", async () => {
    db.buildRunsError = { message: "connection reset" };
    const { status, body } = await route(EDIT_MESSAGE, true, { conductor_run_id: BUILD });
    expect(status).toBe(503);
    expect((body.error as { code: string }).code).toBe("build_session_check_failed");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("the role gate lets owners, admins and members change a site (option C, Ravi 2026-10-02), never viewers", async () => {
    mocks.loadSiteForRun.mockResolvedValue({ id: "site-1", tenant_id: TENANT, status: "live" });
    await route(EDIT_MESSAGE, false, { conductor_run_id: BUILD });
    const allowed = mocks.requireTenantRole.mock.calls.at(-1)?.[1] as readonly string[];
    expect([...allowed].sort()).toEqual(["admin", "member", "owner"]);
  });

  it("a viewer is stopped by the role gate before the session is looked up", async () => {
    mocks.requireTenantRole.mockImplementationOnce(async (...args: unknown[]) => {
      const res = args[2] as Response;
      res.status(403).json({ error: { code: "forbidden" } });
      return false;
    });
    db.buildRunsError = { message: "must not be reached" };
    const { status } = await route(EDIT_MESSAGE, true, { conductor_run_id: BUILD });
    expect(status).toBe(403);
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("a confirmed edit carries the bound site session to refineProduct", async () => {
    mocks.loadSiteForRun.mockResolvedValue({ id: "site-1", tenant_id: TENANT, status: "live" });
    mocks.refineProduct.mockResolvedValueOnce({ conductor_run_id: "r-1", parent_conductor_run_id: BUILD, target: {} });
    const { status } = await route(EDIT_MESSAGE, true, { conductor_run_id: BUILD });
    expect(status).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, conductor_run_id: BUILD }),
    );
  });

  it("a confirmed edit without a bound session is the old-flow app: refused, nothing dispatched", async () => {
    db.product_url = {};
    const { status, body } = await route(EDIT_MESSAGE, true);
    expect(status).toBe(409);
    expect((body.error as { code: string }).code).toBe("old_site_frozen");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("a lookup outage refuses a named app even when the singleton app looks editable (it could be a site)", async () => {
    db.product_url = {};
    db.buildRunsError = { message: "connection reset" };
    const { status, body } = await route(EDIT_MESSAGE, true, { conductor_run_id: BUILD });
    expect(status).toBe(503);
    expect((body.error as { code: string }).code).toBe("build_session_check_failed");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("a turn that names no app is unchanged by a session lookup outage (the old-flow app: frozen)", async () => {
    db.product_url = {};
    db.buildRunsError = { message: "connection reset" };
    const { status, body } = await route(EDIT_MESSAGE);
    expect(status).toBe(409);
    expect((body.error as { code: string }).code).toBe("old_site_frozen");
  });

  it("with no tenant-level app, a session lookup outage is a 503 (it could be a site), never a 409 'no app'", async () => {
    hosting.url = null;
    db.buildRunsError = { message: "connection reset" };
    const { status, body } = await route(EDIT_MESSAGE, false, { conductor_run_id: BUILD });
    expect(status).toBe(503);
    expect((body.error as { code: string }).code).toBe("build_session_check_failed");
  });

  it("with no tenant-level app and no session, the answer stays the deterministic 409", async () => {
    hosting.url = null;
    const { status, body } = await route(EDIT_MESSAGE);
    expect(status).toBe(409);
    expect((body.error as { message: string }).message).toContain("no_built_app");
  });
});

describe("postWebsiteChat — a new-flow SITE session (QA B6)", () => {
  const SITE_ROW = { id: "11111111-1111-4111-8111-111111111111", tenant_id: TENANT, status: "live" };

  beforeEach(() => {
    db.buildRuns = new Set([BUILD]);
    hosting.url = null;
    mocks.loadSiteForRun.mockResolvedValue(SITE_ROW);
  });

  it("is editable with no tenant-level hosting, and a SIMPLE edit is a refine of the site (no inline path)", async () => {
    const { status, body } = await route("Change the hero headline to: Austin's happiest dogs", false, {
      conductor_run_id: BUILD,
    });
    expect(status).toBe(200);
    expect(body.route).toBe("app_edit");
    expect(mocks.loadSiteForRun).toHaveBeenCalledWith(TENANT, BUILD);
  });

  it("an unreadable site lookup for a named app fails closed, even when the singleton app is editable", async () => {
    hosting.url = "https://mohit-93bd8436.onrender.com";
    mocks.loadSiteForRun.mockRejectedValue(new Error("site store down"));
    const { status, body } = await route("Change the hero headline to: Austin's happiest dogs", true, { conductor_run_id: BUILD });
    expect(status).toBe(503);
    expect((body.error as { code: string }).code).toBe("preview_sources_unavailable");
    expect(body.route).toBeUndefined();
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("a confirmed edit carries the site's session to refineProduct", async () => {
    mocks.refineProduct.mockResolvedValueOnce({ conductor_run_id: "r-9", parent_conductor_run_id: BUILD, target: {} });
    const { status } = await route(EDIT_MESSAGE, true, { conductor_run_id: BUILD });
    expect(status).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, conductor_run_id: BUILD }));
  });

  it("another tenant's session is refused: it never becomes an unbound edit of this tenant's only site", async () => {
    db.buildRuns = new Set();
    const { status, body } = await route(EDIT_MESSAGE, true, { conductor_run_id: BUILD });
    expect(status).toBe(404);
    expect((body.error as { code: string }).code).toBe("build_session_not_found");
    expect(mocks.loadSiteForRun).not.toHaveBeenCalled();
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });
});

describe("postWebsiteChat: a pasted key is never forwarded", () => {
  it("refuses with secret_in_chat and a chat line pointing at Settings > Secrets, even on confirm", async () => {
    db.buildRuns = new Set([BUILD]);
    const key = ["sk", "test", "51NabcdefGHIJKLmnopQRSTuvwx"].join("_");
    const msg = `here is my stripe key ${key} please set up payments`;
    const { status, body } = await route(msg, true, { conductor_run_id: BUILD });
    expect(status).toBe(422);
    const err = body.error as { code: string; chat: string };
    expect(err.code).toBe("secret_in_chat");
    expect(err.chat).toContain("Settings");
    expect(JSON.stringify(body)).not.toContain("sk_test_51");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });
});
