import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  refineProduct: vi.fn(),
  requireTenantRole: vi.fn(async () => true),
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
const db = vi.hoisted(() => ({
  product_url: {} as Record<string, unknown>,
  buildRuns: new Set<string>(),
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
                data: [{ resource_kind: "hosting", status: "ready", external_ref: { url: "https://mohit-93bd8436.onrender.com" } }],
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
const SITE_BUILD = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const PHOTO_URL = `http://localhost:3011/api/public/workspace-files/${TENANT}/cd9ec0c2-1c87-483f-9930-4a18bc701015/wallpaper-musashi-vagabond-colored-instagram-aesthetic.jpeg`;
const SCREENSHOT_MESSAGE = `Can you use this image on our website?\n\nUse this photo on the site:\n#wallpaper #musashi #vagabond #colored #instagram #aesthetic.jpeg: ${PHOTO_URL}`;
const COLLECTION_MESSAGE = `Use the "landing page" photos on the site:\n#wallpaper #musashi #vagabond #colored #instagram #aesthetic.jpeg: ${PHOTO_URL}`;

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
  await postWebsiteChat({ body: { message, confirm, conductor_run_id: SITE_BUILD, ...extra }, headers: {} } as unknown as Request, res);
  return { status, body };
}

beforeEach(() => {
  mocks.refineProduct.mockReset();
  mocks.requireTenantRole.mockClear();
  db.product_url = {};
  db.buildRuns = new Set([SITE_BUILD]);
});

describe("postWebsiteChat — a Files-pane photo request is an app change, never an operator relay", () => {
  it("routes the exact message from the duplicate-session report to app_edit so the build tab refines the viewed session", async () => {
    const { status, body } = await route(SCREENSHOT_MESSAGE);
    expect(status).toBe(200);
    expect(body.route).toBe("app_edit");
    expect(body.stage).toBe("confirm");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    expect(mocks.requireTenantRole).toHaveBeenCalledTimes(1);
  });

  it("routes a bare collection send (no typed words, no edit verb) to app_edit", async () => {
    const { body } = await route(COLLECTION_MESSAGE);
    expect(body.route).toBe("app_edit");
  });

  it("never takes the https-only inline path even though the text says image and photo", async () => {
    const { body } = await route(`change the hero image\n\nUse this photo on the site:\nhero.jpg: ${PHOTO_URL}`);
    expect(body.route).not.toBe("app_edit_inline");
    expect(body.route).toBe("app_edit");
  });

  it("still answers a plain question with the operator route", async () => {
    const { body } = await route("Can you use this image on our website?");
    expect(body.route).toBe("operator");
    expect(mocks.requireTenantRole).not.toHaveBeenCalled();
  });

  it("does not treat a pasted non-workspace link as a Files-pane photo", async () => {
    const { body } = await route("Use this photo on the site:\nhero.jpg: https://images.unsplash.com/photo-1.jpg", false, {
      conductor_run_id: undefined,
    });
    expect(body.route).toBe("operator");
  });

  it("with confirm dispatches exactly one refine carrying the photo link", async () => {
    mocks.refineProduct.mockResolvedValue({ conductor_run_id: "run-1", parent_conductor_run_id: null, target: null });
    const { body } = await route(SCREENSHOT_MESSAGE, true);
    expect(body.stage).toBe("dispatched");
    expect(mocks.refineProduct).toHaveBeenCalledTimes(1);
    const sent = mocks.refineProduct.mock.calls[0]![0] as { message: string; tenant_id: string };
    expect(sent.tenant_id).toBe(TENANT);
    expect(sent.message).toContain(PHOTO_URL);
  });
});
