import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  refineProduct: vi.fn(),
  requireTenantRole: vi.fn(async (..._args: unknown[]) => true),
  isProductBuilderEnabled: vi.fn(async () => true),
  send: vi.fn(),
  order: [] as string[],
}));

vi.mock("../../../../workers/client", () => ({ inngest: { send: mocks.send } }));

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
    realRefineProductDeps: {
      ...real.realRefineProductDeps,
      loadSiteForRun: async () => ({ id: "site-1", tenant_id: "b92dcbf1-bac9-457a-af81-0bbe5984339b", status: "live" }),
    },
  };
});

import { postWebsiteChat } from "../website-chat";

const TENANT = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
const EDIT_MESSAGE = "Change the hero background to dark blue and add a pricing section";
const BUILD = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const REFINE = "6c1d6a3e-2f0b-4f47-9d52-0d6f5c2f7a11";

async function route(extra: Record<string, unknown> = {}) {
  let status = 200;
  let body: Record<string, unknown> = {};
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: Record<string, unknown>) {
      mocks.order.push("respond");
      body = payload;
      return this;
    },
  } as unknown as Response;
  await postWebsiteChat({ body: { message: EDIT_MESSAGE, confirm: true, ...extra }, headers: {} } as unknown as Request, res);
  return { status, body };
}

beforeEach(() => {
  mocks.refineProduct.mockReset();
  mocks.send.mockReset();
  mocks.send.mockImplementation(async () => {
    mocks.order.push("kick");
    return { ids: ["e"] };
  });
  mocks.order = [];
  db.product_url = {};
  db.buildRuns = new Set([BUILD]);
  db.buildRunsError = null;
  hosting.url = "https://mohit-93bd8436.onrender.com";
});

describe("postWebsiteChat app edit kicks the conductor", () => {
  it("ticks the NEW refine run right away, before answering, instead of waiting for the cron", async () => {
    mocks.refineProduct.mockResolvedValueOnce({ conductor_run_id: REFINE, parent_conductor_run_id: BUILD, target: {} });
    const { status, body } = await route({ conductor_run_id: BUILD });
    expect(status).toBe(200);
    expect(body.stage).toBe("dispatched");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({
      name: "conductor/tick.requested",
      data: { conductor_run_id: REFINE },
    });
    expect(mocks.order).toEqual(["kick", "respond"]);
  });

  it("an Inngest outage never turns a dispatched refine into an error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.send.mockRejectedValueOnce(new Error("401 Event key not found"));
    mocks.refineProduct.mockResolvedValueOnce({ conductor_run_id: REFINE, parent_conductor_run_id: null, target: {} });
    const { status, body } = await route({ conductor_run_id: BUILD });
    expect(status).toBe(200);
    expect(body.conductor_run_id).toBe(REFINE);
    warn.mockRestore();
  });

  it("a rejected refine kicks nothing", async () => {
    const { SiteRequired } = await import("@/services/agents/refine-product");
    mocks.refineProduct.mockRejectedValueOnce(new SiteRequired(TENANT, "ambiguous"));
    const { status } = await route({ conductor_run_id: BUILD });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("the confirm step and the inline path kick nothing", async () => {
    await route({ confirm: false });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.refineProduct).not.toHaveBeenCalled();
  });
});
