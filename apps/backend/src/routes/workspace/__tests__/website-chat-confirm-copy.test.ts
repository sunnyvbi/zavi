import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

const TENANT = "b92dcbf1-bac9-457a-af81-0bbe5984339b";

const mocks = vi.hoisted(() => ({
  refineProduct: vi.fn(),
  send: vi.fn(),
  settings: {} as Record<string, boolean | Error>,
  settingReads: [] as Array<[string, string | null | undefined]>,
}));

vi.mock("../../../../workers/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: TENANT, user_id: "u-1" })),
}));
vi.mock("@/services/auth/tenant-role", async (orig) => ({
  ...(await orig<typeof import("@/services/auth/tenant-role")>()),
  requireTenantRole: vi.fn(async () => true),
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: vi.fn(async () => true) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/settings", async (orig) => ({
  ...(await orig<typeof import("@/services/settings")>()),
  getBoolSetting: vi.fn(async (key: string, tenant_id?: string | null) => {
    mocks.settingReads.push([key, tenant_id]);
    const v = mocks.settings[key];
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error(`unexpected setting read ${key}`);
    return v;
  }),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "tenants") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { product_url: {} }, error: null }) }) }) };
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
vi.mock("@/services/agents/refine-product", async (orig) => ({
  ...(await orig<typeof import("@/services/agents/refine-product")>()),
  refineProduct: mocks.refineProduct,
}));

import {
  postWebsiteChat,
  appEditConfirmPrompt,
  APP_EDIT_CONFIRM_PR,
  APP_EDIT_CONFIRM_AUTO_PUBLISH,
} from "../website-chat";

const EDIT_MESSAGE = "Change the hero background to dark blue and add a pricing section";

async function askConfirm() {
  return { body: { prompt: await appEditConfirmPrompt(TENANT) } };
}

async function postUnbound() {
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
  await postWebsiteChat({ body: { message: EDIT_MESSAGE }, headers: {} } as unknown as Request, res);
  return { status, body };
}

beforeEach(() => {
  mocks.refineProduct.mockReset();
  mocks.send.mockReset();
  mocks.settings = {};
  mocks.settingReads = [];
});

describe("website chat: the old-flow app on screen is frozen (2026-10-02)", () => {
  it("an app edit with no site session (the workspace's old-flow app) is refused with the Rebuild action, never confirmed", async () => {
    mocks.settings = { website_chat_confirm_copy_by_path: true, refine_direct_merge_enabled: true };
    const { status, body } = await postUnbound();
    expect(status).toBe(409);
    const error = body.error as { code: string; chat: string; action: { kind: string } };
    expect(error.code).toBe("old_site_frozen");
    expect(error.chat).toMatch(/earlier builder/);
    expect(error.chat).not.toMatch(/\u2014/);
    expect(error.action.kind).toBe("rebuild_old_site");
    expect(body).not.toHaveProperty("stage");
    expect(mocks.refineProduct).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("website chat app-edit confirm prompt names the real refine path", () => {
  it("flag ON + direct merge ON: says the change goes live automatically", async () => {
    mocks.settings = {
      website_chat_confirm_copy_by_path: true,
      refine_direct_merge_enabled: true,
    };
    const { body } = await askConfirm();
    expect(body.prompt).toBe(APP_EDIT_CONFIRM_AUTO_PUBLISH);
    expect(String(body.prompt)).not.toMatch(/pull request/i);
    expect(mocks.settingReads.every(([, t]) => t === TENANT)).toBe(true);
  });

  it("flag ON + direct merge off: keeps the pull request copy, which is then true", async () => {
    mocks.settings = {
      website_chat_confirm_copy_by_path: true,
      refine_direct_merge_enabled: false,
    };
    const { body } = await askConfirm();
    expect(body.prompt).toBe(APP_EDIT_CONFIRM_PR);
  });

  it("flag ON + unreadable direct-merge setting promises the pull request the brake will open", async () => {
    mocks.settings = {
      website_chat_confirm_copy_by_path: true,
      refine_direct_merge_enabled: new Error("settings down"),
    };
    expect((await askConfirm()).body.prompt).toBe(APP_EDIT_CONFIRM_PR);
  });

  it("flag OFF: prompt is unchanged and no path setting is read", async () => {
    mocks.settings = { website_chat_confirm_copy_by_path: false };
    const { body } = await askConfirm();
    expect(body.prompt).toBe("Make this change to your app? This opens a pull request for review.");
    expect(mocks.settingReads.map(([k]) => k)).not.toContain("refine_direct_merge_enabled");
  });

  it("flag unreadable: prompt is unchanged", async () => {
    mocks.settings = { website_chat_confirm_copy_by_path: new Error("settings down") };
    const { body } = await askConfirm();
    expect(body.prompt).toBe(APP_EDIT_CONFIRM_PR);
  });
});
