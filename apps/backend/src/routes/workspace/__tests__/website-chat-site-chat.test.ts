import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
const BUILD = "d130919a-bec1-48bc-9dbf-fba65217f05a";

const mocks = vi.hoisted(() => ({
  refineProduct: vi.fn(),
  loadSiteForRun: vi.fn(async (..._a: unknown[]) => null as unknown),
  requireTenantRole: vi.fn(async (..._args: unknown[]) => true),
  send: vi.fn(async () => undefined),
  settings: {} as Record<string, boolean | Error>,
}));

vi.mock("../../../../workers/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/services/agents/conductor-kick", () => ({ requestConductorTick: vi.fn(async () => undefined) }));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: TENANT, user_id: "u-1" })),
}));
vi.mock("@/services/auth/tenant-role", async (orig) => ({
  ...(await orig<typeof import("@/services/auth/tenant-role")>()),
  requireTenantRole: mocks.requireTenantRole,
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: vi.fn(async () => true) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/settings", async (orig) => ({
  ...(await orig<typeof import("@/services/settings")>()),
  getBoolSetting: vi.fn(async (key: string) => {
    const v = mocks.settings[key];
    if (v instanceof Error) throw v;
    return v === true;
  }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "tenants") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { product_url: {} }, error: null }) }) }) };
      }
      if (table === "conductor_runs") {
        const filters: Record<string, string> = {};
        const q = {
          eq(col: string, v: string) {
            filters[col] = v;
            return q;
          },
          async maybeSingle() {
            const hit = filters.tenant_id === TENANT && filters.kind === "build_app" && filters.id === BUILD;
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
                data: [{ resource_kind: "hosting", status: "ready", external_ref: { url: "https://old-app.onrender.com" } }],
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

import {
  postWebsiteChat,
  APP_EDIT_CONFIRM_AUTO_PUBLISH,
  APP_EDIT_CONFIRM_PR,
  APP_EDIT_CONFIRM_PREVIEW,
} from "../website-chat";
import { DATA_DELETE_NOTE } from "@/services/agents/app-edit-intent";

async function route(
  message: string,
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
  await postWebsiteChat({ body: { message, ...extra }, headers: {} } as unknown as Request, res);
  return { status, body };
}

const SITE = { id: "f20600a6-0000-4000-8000-000000000001", tenant_id: TENANT, status: "live" };
const BADGE = "Add a gluten-free badge next to the sourdough";
const PHONE = "remove the phone field and delete phone data";

beforeEach(() => {
  mocks.refineProduct.mockReset();
  mocks.loadSiteForRun.mockReset();
  mocks.loadSiteForRun.mockResolvedValue(SITE);
  mocks.requireTenantRole.mockClear();
  mocks.settings = { refine_direct_merge_enabled: true, build_publish_on_request: true };
});

describe("a site's own Build chat edits that site", () => {
  it("an additive edit with no UI noun is an edit of the bound site, never the operator", async () => {
    const { status, body } = await route(BADGE, { conductor_run_id: BUILD });
    expect(status).toBe(200);
    expect(body).toMatchObject({ route: "app_edit", stage: "confirm", prompt: APP_EDIT_CONFIRM_PREVIEW });
    expect(body).not.toHaveProperty("note");
  });

  it("a destructive data edit reaches the edit path with a plain note that stored data stays", async () => {
    const { status, body } = await route(PHONE, { conductor_run_id: BUILD });
    expect(status).toBe(200);
    expect(body).toMatchObject({ route: "app_edit", stage: "confirm", note: DATA_DELETE_NOTE });
    expect(String(body.prompt)).toContain(DATA_DELETE_NOTE);
    expect(String(body.prompt)).toContain("Click Publish");
  });

  it("confirming dispatches a refine bound to THIS site, and the reply carries the note and the preview stop", async () => {
    mocks.refineProduct.mockResolvedValue({
      conductor_run_id: "cr-1",
      parent_conductor_run_id: BUILD,
      target: { github_full_name: "praxis-built/bakery" },
      direct_merge_enabled: true,
      site_id: SITE.id,
      stop_at_preview: true,
    });
    const { status, body } = await route(PHONE, { conductor_run_id: BUILD, confirm: true });
    expect(status).toBe(200);
    expect(mocks.refineProduct).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, conductor_run_id: BUILD }));
    expect(body).toMatchObject({ route: "app_edit", stage: "dispatched", stop_at_preview: true, note: DATA_DELETE_NOTE });
  });

  it("a question in the site chat still goes to the operator", async () => {
    for (const q of ["How many orders did I get this week?", "What does the phone field do?", "Draft a short update for investors"]) {
      const { body } = await route(q, { conductor_run_id: BUILD });
      expect(body, q).toEqual({ route: "operator" });
    }
    expect(mocks.requireTenantRole).not.toHaveBeenCalled();
  });

  it("the same loose words with NO site named keep the operator route (no guessing which site)", async () => {
    const { body } = await route(BADGE);
    expect(body).toEqual({ route: "operator" });
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });

  it("the same loose words in an old-flow app's session keep the operator route", async () => {
    mocks.loadSiteForRun.mockResolvedValue(null);
    const { body } = await route(BADGE, { conductor_run_id: BUILD });
    expect(body).toEqual({ route: "operator" });
  });
});

describe("a turn sent with an element picked in the preview", () => {
  it("is an edit of that element whatever its wording, even one word", async () => {
    for (const q of ["bigger", "What about red?", "make it pop"]) {
      const { status, body } = await route(q, { conductor_run_id: BUILD, scoped: true });
      expect(status, q).toBe(200);
      expect(body, q).toMatchObject({ route: "app_edit", stage: "confirm" });
    }
  });

  it("needs the site named: a scoped flag on its own changes nothing", async () => {
    const { body } = await route("make it bigger", { scoped: true });
    expect(body).toEqual({ route: "operator" });
  });

  it("only boolean true counts as scoped", async () => {
    const { body } = await route("What about red?", { conductor_run_id: BUILD, scoped: "true" });
    expect(body).toEqual({ route: "operator" });
  });

  it("a confirm turn is never read as scoped (the scope rides on the refine request, not here)", async () => {
    const { status } = await route("red", { conductor_run_id: BUILD, scoped: true, confirm: true });
    expect(status).toBe(200);
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });
});

describe("the confirm question matches what will happen to the site", () => {
  it("publish on request on: ready in the preview, Publish puts it live", async () => {
    const { body } = await route(BADGE, { conductor_run_id: BUILD });
    expect(body.prompt).toBe(APP_EDIT_CONFIRM_PREVIEW);
  });

  it("publish on request off: it goes live by itself", async () => {
    mocks.settings.build_publish_on_request = false;
    const { body } = await route(BADGE, { conductor_run_id: BUILD });
    expect(body.prompt).toBe(APP_EDIT_CONFIRM_AUTO_PUBLISH);
  });

  it("an unreadable publish setting answers the waiting wording (an edit then waits; never a promised auto-live)", async () => {
    mocks.settings.build_publish_on_request = new Error("settings down");
    const { body } = await route(BADGE, { conductor_run_id: BUILD });
    expect(body.prompt).toBe(APP_EDIT_CONFIRM_PREVIEW);
  });

  it("the direct-merge brake: the PR wording", async () => {
    mocks.settings.refine_direct_merge_enabled = false;
    const { body } = await route(BADGE, { conductor_run_id: BUILD });
    expect(body.prompt).toBe(APP_EDIT_CONFIRM_PR);
  });
});

describe("separate projects bypass the existing-site edit route", () => {
  it.each([
    "Build a separate website for a new business",
    "Create a standalone application with a login page",
    "Crea una aplicación separada de mi aplicación actual",
  ])("routes to operator without an edit confirmation or refine: %s", async (message) => {
    for (const extra of [
      {},
      { conductor_run_id: BUILD },
      { conductor_run_id: BUILD, scoped: true },
      { conductor_run_id: BUILD, confirm: true },
      { conductor_run_id: BUILD, confirm: true, scoped: true },
    ]) {
      const result = await route(message, extra);
      expect(result).toEqual({ status: 200, body: { route: "operator" } });
    }
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    expect(mocks.requireTenantRole).not.toHaveBeenCalled();
  });

  it.each([
    "Create a login page for my app",
    "Create a signup form for the app",
    "Create a checkout flow for my marketplace",
    "Build a checkout flow for my marketplace",
    "Create an admin dashboard for the platform",
    "Build an admin dashboard for the platform",
  ])("keeps a component request on the existing site's confirmation path: %s", async (message) => {
    const result = await route(message, { conductor_run_id: BUILD });
    expect(result.body).toMatchObject({ route: "app_edit", stage: "confirm" });
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });
});
