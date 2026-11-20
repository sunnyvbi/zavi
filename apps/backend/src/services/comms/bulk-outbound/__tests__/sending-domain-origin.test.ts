import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), log: vi.fn(async (..._a: unknown[]) => {}), row: null as null | Record<string, unknown> }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.log }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => mocks.rpc(...a),
  globalClient: () => ({ from: () => ({}) }),
  tenantClient: () => ({
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: mocks.row, error: null }) }) }),
  }),
}));

import { addSendingDomain, normalizeSendingDomain, removeSendingDomain, resolveBulkSender } from "../sending-domain";

const ENV = ["BULK_SENDGRID_API_KEY", "SUPABASE_URL", "ZAVI_EMAIL_FROM", "AGENT_EMAIL_FROM", "SYSTEM_EMAIL_FROM"] as const;
const saved: Record<string, string | undefined> = {};
const PROD = "https://wmycgyjsenvgtczlupoe.supabase.co";
const LOCAL = "http://127.0.0.1:54321";

let nextId = 0;
const calls: string[] = [];

function provider() {
  return vi.fn(async (url: string, init: { method: string }) => {
    calls.push(`${init.method} ${url.replace("https://api.sendgrid.com/v3", "")}`);
    if (init.method === "POST") return { ok: true, status: 201, json: async () => ({ id: nextId, dns: { mail_cname: { type: "cname", host: "em1.x.com", data: "u1.wl.sendgrid.net" } } }) };
    return { ok: true, status: 204, json: async () => null };
  });
}

async function addAs(url: string, domain: string, id: number) {
  process.env.SUPABASE_URL = url;
  nextId = id;
  return addSendingDomain({ tenantId: "cakely", userId: "founder", domain }, { fetch: provider() });
}

const deletes = () => calls.filter((c) => c.startsWith("DELETE /whitelabel/domains"));

describe("sending domain provider records belong to the environment that created them", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    mocks.row = null;
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    process.env.BULK_SENDGRID_API_KEY = "shared-bulk-key";
    mocks.rpc.mockImplementation(async (_t: string, name: string, a: Record<string, unknown>) => {
      if (name === "tenant_sending_domain_upsert_pending") {
        mocks.row = {
          domain: a.p_domain,
          from_address: null,
          from_name: null,
          verification_status: "verified",
          verification_error: null,
          dns_records: JSON.parse(JSON.stringify(a.p_dns_records)),
          provider_domain_id: a.p_provider_domain_id,
          verified_at: "2026-10-27T00:00:00Z",
        };
      }
      if (name === "tenant_sending_domain_release") {
        const id = (mocks.row?.provider_domain_id as string | undefined) ?? null;
        mocks.row = null;
        return { data: { ok: true, released: !!id, provider_domain_id: id }, error: null };
      }
      return { data: { ok: true }, error: null };
    });
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("Remove on a copied row never deletes the record at the provider, but still releases the row", async () => {
    await addAs(PROD, "private-rents.com", 30211733);
    calls.length = 0;
    process.env.SUPABASE_URL = LOCAL;
    const fetch = provider();
    expect(await removeSendingDomain({ tenantId: "cakely", userId: "founder" }, { fetch })).toEqual({ released: true });
    expect(deletes()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map((c) => c[1])).toContain("tenant_sending_domain_release");
    expect(mocks.row).toBeNull();
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ code: "bulk_email.provider_record_not_ours", meta: { provider_domain_id: "30211733" } }));
    expect(mocks.log).not.toHaveBeenCalledWith(expect.objectContaining({ code: "bulk_email.provider_record_orphaned" }));
  });

  it("Change on a copied row never deletes the old record at the provider, and the new domain is still added", async () => {
    await addAs(PROD, "private-rents.com", 30211733);
    calls.length = 0;
    const out = await addAs(LOCAL, "acme.com", 77);
    expect(calls).toEqual(["POST /whitelabel/domains"]);
    expect(deletes()).toEqual([]);
    expect(out).toMatchObject({ domain: "acme.com" });
    expect(mocks.row?.provider_domain_id).toBe("77");
  });

  it("a row from before this fix, with no origin, is never deleted at the provider", async () => {
    process.env.SUPABASE_URL = PROD;
    mocks.row = { domain: "private-rents.com", from_address: null, from_name: null, verification_status: "verified", verification_error: null, dns_records: [{ type: "CNAME", host: "em1.private-rents.com", data: "u1.wl.sendgrid.net" }], provider_domain_id: "30211733", verified_at: "2026-10-01T00:00:00Z" };
    nextId = 77;
    await addSendingDomain({ tenantId: "cakely", userId: "founder", domain: "acme.com" }, { fetch: provider() });
    expect(deletes()).toEqual([]);
    await removeSendingDomain({ tenantId: "cakely", userId: "founder" }, { fetch: provider() });
    expect(deletes()).toEqual(["DELETE /whitelabel/domains/77"]);
  });

  it("a row this environment created is still deleted on Change and on Remove, and the founder never sees the origin", async () => {
    const first = await addAs(PROD, "old.com", 11);
    expect(first.dns_records).toEqual([{ type: "CNAME", host: "em1.x.com", data: "u1.wl.sendgrid.net" }]);
    calls.length = 0;
    await addAs(PROD, "acme.com", 77);
    expect(calls).toEqual(["POST /whitelabel/domains", "DELETE /whitelabel/domains/11"]);
    calls.length = 0;
    expect(await removeSendingDomain({ tenantId: "cakely", userId: "founder" }, { fetch: provider() })).toEqual({ released: true });
    expect(calls).toEqual(["DELETE /whitelabel/domains/77"]);
  });

  it("Zavi's own domains are refused with every email env var unset", async () => {
    for (const d of ["thepraxis.ai", "mail.thepraxis.ai", "zaviagent.com", "send.zaviagent.com", "HTTPS://Mail.ThePraxis.ai/"]) {
      expect(() => normalizeSendingDomain(d)).toThrow(expect.objectContaining({ code: "zavi_domain" }));
    }
    expect(normalizeSendingDomain("notthepraxis.ai")).toBe("notthepraxis.ai");
    const fetch = provider();
    await expect(addSendingDomain({ tenantId: "cakely", userId: "founder", domain: "mail.thepraxis.ai" }, { fetch })).rejects.toMatchObject({ code: "zavi_domain" });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.row = { domain: "thepraxis.ai", from_address: "hello@thepraxis.ai", from_name: null, verification_status: "verified", verification_error: null, dns_records: [], provider_domain_id: "9", verified_at: "2026-10-01T00:00:00Z" };
    expect(await resolveBulkSender("cakely")).toBeNull();
  });
});
