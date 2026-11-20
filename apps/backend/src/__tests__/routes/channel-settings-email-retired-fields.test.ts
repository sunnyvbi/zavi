import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const USER = "22222222-2222-4222-8222-222222222222";
  const store: Record<string, Record<string, Array<Record<string, unknown>>>> = {};
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const domain: { value: { domain: string } | null; throws: boolean } = { value: null, throws: false };
  const tenantRpc = vi.fn(async (_t: string, fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    const slug = String(args.p_channel_slug);
    if (fn === "get_channel_settings") return { data: { fields: store[slug] ?? {} }, error: null };
    if (fn === "set_channel_settings") {
      const items = (args.p_items as Array<Record<string, unknown>>).map((it, i) => ({ id: `r${i}`, ...it }));
      store[slug] = { ...(store[slug] ?? {}), [String(args.p_field_id)]: items };
      return { data: { ok: true, written: items.length, deleted: 0, dropped: 0, fields: store[slug] }, error: null };
    }
    throw new Error(`unexpected rpc ${fn}`);
  });
  const getSendingDomain = vi.fn(async () => {
    if (domain.throws) throw new Error("tenant_sending_domains read failed");
    return domain.value;
  });
  return { TENANT, USER, store, calls, domain, tenantRpc, getSendingDomain };
});

vi.mock("@/services/tenant-client", () => ({ tenantRpc: h.tenantRpc, asTenantId: (s: string) => s }));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn().mockResolvedValue({ user_id: h.USER, tenant_id: h.TENANT, access_token: "fake-jwt" }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn().mockResolvedValue(true) }));
vi.mock("@/services/comms/bulk-outbound/sending-domain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/comms/bulk-outbound/sending-domain")>()),
  getSendingDomain: h.getSendingDomain,
}));

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
  return { res, status: () => code, body: () => payload as { error?: { code?: string } } };
}

const put = async (slug: string, fieldId: string, items: unknown[]) => {
  const r = mkRes();
  await channelSettingsPut({ params: { slug, fieldId }, query: {}, body: { items } } as unknown as Request, r.res);
  return r;
};
const writes = () => h.calls.filter((c) => c.fn === "set_channel_settings");

beforeEach(() => {
  for (const k of Object.keys(h.store)) delete h.store[k];
  h.calls.length = 0;
  h.domain.value = null;
  h.domain.throws = false;
  h.getSendingDomain.mockClear();
});

describe("PUT of the email settings web retired", () => {
  it("refuses esp on email_marketing and writes nothing, whatever shape the items take", async () => {
    for (const items of [["klaviyo"], [{ item: "mailchimp" }], []]) {
      const r = await put("email_marketing", "esp", items);
      expect(r.status()).toBe(409);
      expect(r.body().error?.code).toBe("field_retired");
    }
    expect(writes()).toHaveLength(0);
    expect(h.store.email_marketing).toBeUndefined();
  });

  it("refuses the other retired key too, and only on its own channel", async () => {
    expect((await put("ugc", "production_route", ["ai_presenter"])).status()).toBe(409);
    expect(writes()).toHaveLength(0);
    expect((await put("tiktok_organic", "production_route", ["x"])).status()).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it("refuses sending_domain once a sending domain is registered, so the setting keeps equalling it", async () => {
    h.store.email_marketing = { sending_domain: [{ id: "m", item: "mail.verified.com" }] };
    h.domain.value = { domain: "mail.verified.com" };
    for (const items of [["typed-on-mobile.com"], []]) {
      const r = await put("email_marketing", "sending_domain", items);
      expect(r.status()).toBe(409);
      expect(r.body().error?.code).toBe("field_writes_elsewhere");
    }
    expect(writes()).toHaveLength(0);
    expect(h.store.email_marketing.sending_domain).toEqual([{ id: "m", item: "mail.verified.com" }]);
    expect(h.getSendingDomain).toHaveBeenCalledWith(h.TENANT);
  });

  it("fails closed when the domain record cannot be read", async () => {
    h.domain.throws = true;
    const r = await put("email_marketing", "sending_domain", ["typed.com"]);
    expect(r.status()).toBe(500);
    expect(writes()).toHaveLength(0);
  });

  it("still takes sending_domain with no domain record: web's fallback while verifying is unavailable", async () => {
    const r = await put("email_marketing", "sending_domain", ["example.com"]);
    expect(r.status()).toBe(200);
    expect(writes()).toHaveLength(1);
  });

  it("does not look up the domain record for any other field or channel", async () => {
    h.domain.value = { domain: "mail.verified.com" };
    expect((await put("email_marketing", "postal_address", ["1 Main St, Austin TX"])).status()).toBe(200);
    expect((await put("google_ads", "sending_domain", ["x.com"])).status()).toBe(200);
    expect(h.getSendingDomain).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(2);
  });
});
