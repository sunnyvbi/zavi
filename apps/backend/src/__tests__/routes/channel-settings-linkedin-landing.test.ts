import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/services/tenant-client", () => ({
  tenantRpc: vi.fn(async (_tenant: string, fn: string, args: Record<string, unknown>) => {
    h.calls.push({ fn, args });
    return { data: { ok: true, written: 0, deleted: 0, dropped: 0, fields: {} }, error: null };
  }),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn().mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "jwt" }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn().mockResolvedValue(true) }));

import { channelSettingsPut } from "../../routes/channels/settings";

function mkRes() {
  let code = 200;
  let payload: unknown = null;
  const res = {
    status(c: number) {
      code = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => code, body: () => payload as { error?: { code?: string; message?: string } } };
}

async function put(slug: string, fieldId: string, items: unknown[]) {
  const r = mkRes();
  await channelSettingsPut({ params: { slug, fieldId }, body: { items } } as unknown as Request, r.res);
  return r;
}

const writes = () => h.calls.filter((c) => c.fn === "set_channel_settings");

describe("linkedin_ads landing page setting", () => {
  beforeEach(() => {
    h.calls.length = 0;
  });

  it.each([
    "not a url \u{1F697}",
    "example.com/demo",
    "javascript:alert(1)",
    "ftp://example.com/file",
    "https://",
    "http://localhost",
  ])("refuses %j and writes nothing", async (bad) => {
    const r = await put("linkedin_ads", "landing_page", [bad]);
    expect(r.status()).toBe(400);
    expect(r.body().error?.code).toBe("invalid_url");
    expect(r.body().error?.message).toContain("Nothing was saved");
    expect(writes()).toHaveLength(0);
  });

  it("refuses an http:// page the run's page reader cannot open, and names the https fix", async () => {
    const r = await put("linkedin_ads", "landing_page", ["http://example.com/demo"]);
    expect(r.status()).toBe(400);
    expect(r.body().error?.code).toBe("invalid_url");
    expect(r.body().error?.message).toContain("https://");
    expect(r.body().error?.message).toContain("Nothing was saved");
    expect(writes()).toHaveLength(0);
  });

  it("saves a good https URL", async () => {
    const r = await put("linkedin_ads", "landing_page", ["https://example.com/demo"]);
    expect(r.status()).toBe(200);
    expect(writes()).toHaveLength(1);
    expect((writes()[0].args.p_items as Array<{ item: string }>)[0].item).toBe("https://example.com/demo");
  });

  it("an empty value still clears the setting", async () => {
    const r = await put("linkedin_ads", "landing_page", []);
    expect(r.status()).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].args.p_items).toEqual([]);
  });

  it("does not change other fields on the same channel", async () => {
    const r = await put("linkedin_ads", "channel_note", ["not a url"]);
    expect(r.status()).toBe(200);
    expect(writes()).toHaveLength(1);
  });
});

describe("linkedin_ads deal value setting", () => {
  beforeEach(() => {
    h.calls.length = 0;
  });

  it.each(["-50", "-0.01", "Infinity", "-Infinity", "NaN", "abc", "1e999", "12,000"])(
    "refuses %j and writes nothing",
    async (bad) => {
      const r = await put("linkedin_ads", "deal_value", [bad]);
      expect(r.status()).toBe(400);
      expect(r.body().error?.code).toBe("invalid_number");
      expect(r.body().error?.message).toContain("Nothing was saved");
      expect(writes()).toHaveLength(0);
    },
  );

  it.each(["0", "12000", "99.5"])("saves %j", async (good) => {
    const r = await put("linkedin_ads", "deal_value", [good]);
    expect(r.status()).toBe(200);
    expect((writes()[0].args.p_items as Array<{ item: string }>)[0].item).toBe(good);
  });

  it("an empty value still clears it", async () => {
    const r = await put("linkedin_ads", "deal_value", []);
    expect(r.status()).toBe(200);
    expect(writes()[0].args.p_items).toEqual([]);
  });
});
