import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const h = vi.hoisted(() => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const USER = "22222222-2222-4222-8222-222222222222";
  const store: Record<string, Record<string, Array<Record<string, unknown>>>> = {};
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const tenantRpc = vi.fn(async (_t: string, fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    const slug = String(args.p_channel_slug);
    if (fn === "set_channel_settings") {
      const items = (args.p_items as Array<Record<string, unknown>>).map((it, i) => ({ id: `r${i}`, ...it }));
      store[slug] = { ...(store[slug] ?? {}), [String(args.p_field_id)]: items };
      return { data: { ok: true, written: items.length, deleted: 0, dropped: 0, fields: store[slug] }, error: null };
    }
    if (fn === "get_channel_settings") return { data: { fields: store[slug] ?? {} }, error: null };
    throw new Error(`unexpected rpc ${fn}`);
  });
  const tenantClient = () => ({
    from: () => ({
      select: () => ({
        maybeSingle: async () => ({ data: null, error: null }),
      }),
    }),
  });
  return { TENANT, USER, store, calls, tenantRpc, tenantClient };
});

vi.mock("@/services/tenant-client", () => ({
  tenantRpc: h.tenantRpc,
  tenantClient: h.tenantClient,
  asTenantId: (s: string) => s,
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn().mockResolvedValue({ user_id: h.USER, tenant_id: h.TENANT, access_token: "fake-jwt" }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn().mockResolvedValue(true) }));

import { channelSettingsPut } from "../../routes/channels/settings";
import { normalizeSendingDomain } from "@/services/comms/bulk-outbound/sending-domain";
import { BulkEmailError } from "@/services/comms/bulk-outbound/errors";

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
  return {
    res,
    status: () => code,
    body: () => payload as { error?: { code?: string; message?: string }; written?: number },
  };
}

const put = async (slug: string, fieldId: string, items: unknown[]) => {
  const r = mkRes();
  await channelSettingsPut({ params: { slug, fieldId }, query: {}, body: { items } } as unknown as Request, r.res);
  return r;
};
const writes = () => h.calls.filter((c) => c.fn === "set_channel_settings");
const refusalOf = (raw: unknown): BulkEmailError => {
  try {
    normalizeSendingDomain(raw);
  } catch (e) {
    return e as BulkEmailError;
  }
  throw new Error(`expected ${String(raw)} to be refused`);
};

beforeEach(() => {
  for (const k of Object.keys(h.store)) delete h.store[k];
  h.calls.length = 0;
});

describe("PUT email_marketing/sending_domain through the generic settings route", () => {
  const refused: Array<[string, unknown, string]> = [
    ["Zavi apex", "zaviagent.com", "zavi_domain"],
    ["Zavi www subdomain", "www.zaviagent.com", "zavi_domain"],
    ["Zavi domain inside a URL", "https://ZavIAgent.com/pricing", "zavi_domain"],
    ["Zavi domain inside an address", "founder@zaviagent.com", "zavi_domain"],
    ["old Zavi domain", "thepraxis.ai", "zavi_domain"],
    ["free mailbox", "gmail.com", "free_mailbox_domain"],
    ["free mailbox as an address", "me@outlook.com", "free_mailbox_domain"],
    ["junk", "not a domain", "invalid_domain"],
    ["no dot", "localhost", "invalid_domain"],
    ["object item carrying a Zavi domain", { item: "mail.zaviagent.com" }, "zavi_domain"],
    ["object item carrying junk", { item: "???", note: "x" }, "invalid_domain"],
  ];

  it.each(refused)("refuses %s with the add-domain error and writes nothing", async (_label, item, code) => {
    h.store.email_marketing = { sending_domain: [{ id: "keep", item: "acme.com" }] };
    const raw = typeof item === "string" ? item : (item as { item: string }).item;
    const expected = refusalOf(raw);

    const r = await put("email_marketing", "sending_domain", [item]);

    expect(r.status()).toBe(expected.status);
    expect(r.status()).toBe(400);
    expect(r.body().error).toEqual({ code, message: expected.message });
    expect(writes()).toHaveLength(0);
    expect(h.store.email_marketing.sending_domain).toEqual([{ id: "keep", item: "acme.com" }]);
  });

  it("refuses the whole save when a good item comes before a bad one", async () => {
    const r = await put("email_marketing", "sending_domain", ["acme.com", "zaviagent.com"]);
    expect(r.status()).toBe(400);
    expect(r.body().error?.code).toBe("zavi_domain");
    expect(writes()).toHaveLength(0);
  });

  it("saves a normal domain as sent", async () => {
    const r = await put("email_marketing", "sending_domain", ["acme.com"]);
    expect(r.status()).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].args).toMatchObject({ p_channel_slug: "email_marketing", p_field_id: "sending_domain", p_actor_user_id: h.USER });
    expect(writes()[0].args.p_items).toEqual([
      { item: "acme.com", item_type: null, status: null, position: 0, note: null, origin: null, detail: null },
    ]);
  });

  it("stores the bare host the add-domain path would store, not the text typed", async () => {
    const r = await put("email_marketing", "sending_domain", ["https://Mail.Acme.com/path?x=1"]);
    expect(r.status()).toBe(200);
    expect((writes()[0].args.p_items as Array<{ item: string }>)[0].item).toBe("mail.acme.com");
  });

  it("keeps the other fields of an object item while normalising its domain", async () => {
    const r = await put("email_marketing", "sending_domain", [{ item: "ACME.com.", note: "main", position: 3 }]);
    expect(r.status()).toBe(200);
    expect((writes()[0].args.p_items as Array<Record<string, unknown>>)[0]).toMatchObject({
      item: "acme.com",
      note: "main",
      position: 3,
    });
  });

  it("an empty list still clears the field", async () => {
    h.store.email_marketing = { sending_domain: [{ id: "old", item: "acme.com" }] };
    const r = await put("email_marketing", "sending_domain", []);
    expect(r.status()).toBe(200);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].args.p_items).toEqual([]);
    expect(h.store.email_marketing.sending_domain).toEqual([]);
  });

  it("leaves another email field alone even with a value the domain rule refuses", async () => {
    const r = await put("email_marketing", "postal_address", ["zaviagent.com"]);
    expect(r.status()).toBe(200);
    expect((writes()[0].args.p_items as Array<{ item: string }>)[0].item).toBe("zaviagent.com");
  });

  it("leaves the same field id on another channel alone", async () => {
    const r = await put("google_ads", "sending_domain", ["not a domain"]);
    expect(r.status()).toBe(200);
    expect((writes()[0].args.p_items as Array<{ item: string }>)[0].item).toBe("not a domain");
  });
});
