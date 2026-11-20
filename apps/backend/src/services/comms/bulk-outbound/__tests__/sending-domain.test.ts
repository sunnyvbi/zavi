import { createHash } from "node:crypto";
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

import { addSendingDomain, DNS_CHECK_FAILED_ERROR, normalizeSendingDomain, recheckSendingDomainIfStale, removeSendingDomain, resolveBulkSender, verifySendingDomain } from "../sending-domain";

const KEYS = ["BULK_SENDGRID_API_KEY", "SYSTEM_SENDGRID_API_KEY", "PROVISION_EMAIL_SENDGRID_API_KEY", "SUPABASE_URL"] as const;
const ORIGIN = { origin: createHash("sha256").update("https://here.supabase.co").digest("hex").slice(0, 32) };
const OWNED_77 = { domain: "acme.com", from_address: null, from_name: null, verification_status: "verified", verification_error: null, dns_records: [ORIGIN], provider_domain_id: "77", verified_at: "2026-10-01T00:00:00Z" };
const saved: Record<string, string | undefined> = {};

function fetchReturning(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

describe("sending domain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.row = null;
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.BULK_SENDGRID_API_KEY = "bulk-key";
    process.env.SYSTEM_SENDGRID_API_KEY = "system-key";
    process.env.PROVISION_EMAIL_SENDGRID_API_KEY = "provision-key";
    process.env.SUPABASE_URL = "https://here.supabase.co/";
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("accepts a bare hostname and refuses junk and free mailbox domains", () => {
    expect(normalizeSendingDomain(" HTTPS://Mail.Acme.com/ ")).toBe("mail.acme.com");
    expect(() => normalizeSendingDomain("acme")).toThrow("Enter a domain like example.com.");
    expect(() => normalizeSendingDomain("gmail.com")).toThrow(/domain your business owns/);
  });

  it("with the bulk key unset it refuses, and never uses another SendGrid key", async () => {
    delete process.env.BULK_SENDGRID_API_KEY;
    const fetch = fetchReturning(200, { id: 1 });
    await expect(addSendingDomain({ tenantId: "t", userId: "u", domain: "acme.com" }, { fetch })).rejects.toMatchObject({
      code: "bulk_sender_not_configured",
      message: "Bulk email is not set up yet.",
    });
    await expect(verifySendingDomain({ tenantId: "t" }, { fetch })).rejects.toMatchObject({ code: "bulk_sender_not_configured" });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("checks the name, asks the provider, THEN writes the new row in one step, then removes the old record", async () => {
    const order: string[] = [];
    mocks.row = { domain: "old.com", from_address: null, from_name: null, verification_status: "verified", verification_error: null, dns_records: [ORIGIN], provider_domain_id: "11", verified_at: "2026-10-01T00:00:00Z" };
    mocks.rpc.mockImplementation(async (_t: string, name: string) => {
      order.push(name);
      if (name === "tenant_sending_domain_upsert_pending") {
        mocks.row = { domain: "acme.com", from_address: null, from_name: null, verification_status: "pending", verification_error: null, dns_records: [{ type: "cname", host: "em1.acme.com", data: "u1.wl.sendgrid.net" }], provider_domain_id: "77", verified_at: null };
      }
      return { data: { ok: true }, error: null };
    });
    const fetch = vi.fn(async (url: string, init: { method: string; headers: Record<string, string> }) => {
      order.push(`${init.method} ${url.replace("https://api.sendgrid.com/v3", "")}`);
      expect(init.headers.Authorization).toBe("Bearer bulk-key");
      return { ok: true, status: 201, json: async () => ({ id: 77, dns: { mail_cname: { type: "cname", host: "em1.acme.com", data: "u1.wl.sendgrid.net" } } }) };
    });
    const out = await addSendingDomain({ tenantId: "tenant-a", userId: "user-a", domain: "Acme.com" }, { fetch });
    expect(order).toEqual([
      "tenant_sending_domain_check",
      "POST /whitelabel/domains",
      "tenant_sending_domain_upsert_pending",
      "set_channel_settings",
      "DELETE /whitelabel/domains/11",
    ]);
    expect(mocks.rpc).toHaveBeenCalledWith("tenant-a", "tenant_sending_domain_upsert_pending", {
      p_user_id: "user-a",
      p_domain: "acme.com",
      p_provider_domain_id: "77",
      p_dns_records: [{ type: "CNAME", host: "em1.acme.com", data: "u1.wl.sendgrid.net" }, ORIGIN],
    });
    expect(out).toMatchObject({ domain: "acme.com", status: "pending", from_address: "hello@acme.com" });
  });

  it("a provider failure leaves the current, working domain untouched", async () => {
    mocks.row = { domain: "old.com", from_address: null, from_name: null, verification_status: "verified", verification_error: null, dns_records: [], provider_domain_id: "11", verified_at: "2026-10-01T00:00:00Z" };
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    const fetch = fetchReturning(500, { errors: [{ message: "boom" }] });
    await expect(addSendingDomain({ tenantId: "tenant-a", userId: "user-a", domain: "acme.com" }, { fetch })).rejects.toMatchObject({ status: 502 });
    const written = mocks.rpc.mock.calls.map((c) => c[1]);
    expect(written).toEqual(["tenant_sending_domain_check"]);
    expect(fetch.mock.calls.some((c) => (c as unknown as [string, { method: string }])[1].method === "DELETE")).toBe(false);
  });

  it("losing the name in a race removes the new provider record and keeps the old row", async () => {
    mocks.rpc.mockImplementation(async (_t: string, name: string) =>
      name === "tenant_sending_domain_upsert_pending" ? { data: { ok: false, reason: "domain_taken" }, error: null } : { data: { ok: true }, error: null },
    );
    const fetch = vi.fn(async (_url: string, init: { method: string }) => ({ ok: true, status: init.method === "DELETE" ? 204 : 201, json: async () => ({ id: 88, dns: { mail_cname: { type: "cname", host: "em1.acme.com", data: "u1.wl.sendgrid.net" } } }) }));
    await expect(addSendingDomain({ tenantId: "tenant-b", userId: "u", domain: "acme.com" }, { fetch })).rejects.toMatchObject({ code: "domain_taken" });
    expect(fetch.mock.calls.map((c) => `${(c[1] as { method: string }).method} ${String(c[0]).split("/v3")[1]}`)).toEqual([
      "POST /whitelabel/domains",
      "DELETE /whitelabel/domains/88",
    ]);
  });

  it("a stale claim released in the same transaction as the new one is logged, never deleted at the provider", async () => {
    mocks.rpc.mockImplementation(async (_t: string, name: string) => {
      if (name === "tenant_sending_domain_upsert_pending") {
        mocks.row = { domain: "acme.com", from_address: null, from_name: null, verification_status: "pending", verification_error: null, dns_records: [ORIGIN], provider_domain_id: "77", verified_at: null };
        return { data: { ok: true, released_provider_domain_id: "55" }, error: null };
      }
      return { data: { ok: true }, error: null };
    });
    const fetch = vi.fn(async (_url: string, init: { method: string }) => ({ ok: true, status: init.method === "DELETE" ? 204 : 201, json: async () => ({ id: 77, dns: { mail_cname: { type: "cname", host: "em1.acme.com", data: "u1.wl.sendgrid.net" } } }) }));
    const out = await addSendingDomain({ tenantId: "tenant-a", userId: "u", domain: "acme.com" }, { fetch });
    const calls = fetch.mock.calls.map((c) => `${(c[1] as { method: string }).method} ${String(c[0]).split("/v3")[1]}`);
    expect(calls).toEqual(["POST /whitelabel/domains"]);
    expect(mocks.log).toHaveBeenCalledTimes(1);
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ code: "bulk_email.provider_record_not_ours", meta: { provider_domain_id: "55" } }));
    expect(out).toMatchObject({ domain: "acme.com", status: "pending" });
  });

  it("a record that cannot be deleted at the provider is logged for staff by id", async () => {
    mocks.row = { domain: "old.com", from_address: null, from_name: null, verification_status: "verified", verification_error: null, dns_records: [ORIGIN], provider_domain_id: "11", verified_at: "2026-10-01T00:00:00Z" };
    mocks.rpc.mockImplementation(async (_t: string, name: string) => {
      if (name === "tenant_sending_domain_upsert_pending") {
        mocks.row = { domain: "acme.com", from_address: null, from_name: null, verification_status: "pending", verification_error: null, dns_records: [], provider_domain_id: "77", verified_at: null };
      }
      return { data: { ok: true }, error: null };
    });
    const fetch = vi.fn(async (_url: string, init: { method: string }) => ({ ok: init.method !== "DELETE", status: init.method === "DELETE" ? 500 : 201, json: async () => ({ id: 77, dns: { mail_cname: { type: "cname", host: "em1.acme.com", data: "u1.wl.sendgrid.net" } } }) }));
    await addSendingDomain({ tenantId: "tenant-a", userId: "u", domain: "acme.com" }, { fetch });
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ code: "bulk_email.provider_record_orphaned", meta: { provider_domain_id: "11" } }));
  });

  it("removing the domain with the bulk key unset still logs the leftover provider record by id", async () => {
    delete process.env.BULK_SENDGRID_API_KEY;
    mocks.row = OWNED_77;
    mocks.rpc.mockResolvedValue({ data: { ok: true, released: true, provider_domain_id: "77" }, error: null });
    const fetch = vi.fn();
    expect(await removeSendingDomain({ tenantId: "tenant-a", userId: "u" }, { fetch })).toEqual({ released: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ code: "bulk_email.provider_record_orphaned", meta: { provider_domain_id: "77" } }));
  });

  it("removing the domain releases the row first, then deletes the provider record", async () => {
    const order: string[] = [];
    mocks.row = OWNED_77;
    mocks.rpc.mockImplementation(async (_t: string, name: string, a: Record<string, unknown>) => {
      order.push(`${name}:${String(a.p_only_stale)}`);
      return { data: { ok: true, released: true, provider_domain_id: "77" }, error: null };
    });
    const fetch = vi.fn(async (url: string, init: { method: string }) => {
      order.push(`${init.method} ${url.split("/v3")[1]}`);
      return { ok: true, status: 204, json: async () => null };
    });
    expect(await removeSendingDomain({ tenantId: "tenant-a", userId: "u" }, { fetch })).toEqual({ released: true });
    expect(order).toEqual(["tenant_sending_domain_release:false", "DELETE /whitelabel/domains/77", "set_channel_settings:undefined"]);
    mocks.rpc.mockClear();
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: "forbidden" }, error: null });
    await expect(removeSendingDomain({ tenantId: "tenant-a", userId: "member" }, { fetch })).rejects.toMatchObject({ status: 403 });
    expect(mocks.rpc.mock.calls.map((c) => c[1])).toEqual(["tenant_sending_domain_release"]);
  });

  it("removing the domain clears the typed sending_domain setting too, so the page cannot offer the removed domain back", async () => {
    mocks.rpc.mockImplementation(async (_t: string, name: string) =>
      name === "tenant_sending_domain_release"
        ? { data: { ok: true, released: true, provider_domain_id: "77" }, error: null }
        : { data: { ok: true }, error: null },
    );
    const fetch = fetchReturning(204, null);
    expect(await removeSendingDomain({ tenantId: "tenant-a", userId: "user-a" }, { fetch })).toEqual({ released: true });
    const writes = mocks.rpc.mock.calls.filter((c) => c[1] === "set_channel_settings");
    expect(writes).toEqual([
      ["tenant-a", "set_channel_settings", { p_channel_slug: "email_marketing", p_field_id: "sending_domain", p_items: [], p_actor_user_id: "user-a" }],
    ]);
  });

  it("a removal retried after the row is already gone still clears the setting", async () => {
    mocks.rpc.mockImplementation(async (_t: string, name: string) =>
      name === "tenant_sending_domain_release" ? { data: { ok: true, released: false }, error: null } : { data: { ok: true }, error: null },
    );
    const fetch = vi.fn();
    expect(await removeSendingDomain({ tenantId: "tenant-a", userId: "user-a" }, { fetch })).toEqual({ released: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.filter((c) => c[1] === "set_channel_settings")).toHaveLength(1);
  });

  it("a removal whose setting clear fails still reports success once the row and the provider record are gone", async () => {
    const failures: Array<() => Promise<unknown>> = [
      async () => ({ data: { ok: false, code: "unknown_channel" }, error: null }),
      async () => ({ data: null, error: { message: "boom" } }),
      async () => {
        throw new Error("network");
      },
    ];
    for (const fail of failures) {
      mocks.rpc.mockReset();
      mocks.row = OWNED_77;
      mocks.rpc.mockImplementation(async (_t: string, name: string) =>
        name === "tenant_sending_domain_release" ? { data: { ok: true, released: true, provider_domain_id: "77" }, error: null } : fail(),
      );
      const fetch = fetchReturning(204, null);
      await expect(removeSendingDomain({ tenantId: "tenant-a", userId: "user-a" }, { fetch })).resolves.toEqual({ released: true });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ method: "DELETE" });
      expect(mocks.rpc.mock.calls.map((c) => c[1])).toEqual(["tenant_sending_domain_release", "set_channel_settings"]);
    }
  });

  it("the stale-pending release on page open leaves the typed setting alone", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true, released: true, provider_domain_id: "77" }, error: null });
    const fetch = fetchReturning(204, null);
    expect(await removeSendingDomain({ tenantId: "tenant-a", userId: "user-a", onlyIfStale: true }, { fetch })).toEqual({ released: true });
    expect(mocks.rpc.mock.calls.map((c) => c[1])).toEqual(["tenant_sending_domain_release"]);
  });

  it("a domain another workspace holds (verified, or pending under 7 days) is refused before the provider is asked", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: false, reason: "domain_taken" }, error: null });
    const fetch = fetchReturning(201, { id: 1 });
    await expect(addSendingDomain({ tenantId: "tenant-b", userId: "u", domain: "acme.com" }, { fetch })).rejects.toMatchObject({
      status: 409,
      message: "This domain is already connected to another workspace.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  function provider(record: { status: number; body: unknown }, validate: { status: number; body: unknown }) {
    return vi.fn(async (url: string, init: { method: string }) => {
      const r = init.method === "GET" ? record : validate;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    });
  }
  const PENDING_ROW = { domain: "acme.com", from_address: null, from_name: null, verification_status: "pending", verification_error: null, dns_records: [], provider_domain_id: "77", verified_at: null };

  it("is marked verified only when the provider says valid, matched on the id AND the current domain", async () => {
    mocks.row = PENDING_ROW;
    const rec = { status: 200, body: { id: 77, domain: "acme.com" } };
    await verifySendingDomain({ tenantId: "tenant-a" }, { fetch: provider(rec, { status: 200, body: { valid: false } }) });
    expect(mocks.rpc).toHaveBeenLastCalledWith("tenant-a", "tenant_sending_domain_set_status", expect.objectContaining({ p_provider_domain_id: "77", p_domain: "acme.com", p_status: "pending" }));
    await verifySendingDomain({ tenantId: "tenant-a" }, { fetch: provider(rec, { status: 200, body: { valid: true } }) });
    expect(mocks.rpc).toHaveBeenLastCalledWith("tenant-a", "tenant_sending_domain_set_status", { p_provider_domain_id: "77", p_domain: "acme.com", p_status: "verified", p_error: null });
    await expect(verifySendingDomain({ tenantId: "tenant-a" }, { fetch: provider(rec, { status: 500, body: null }) })).rejects.toMatchObject({ status: 502 });
  });

  it("a provider record for a different domain never verifies this one", async () => {
    mocks.row = PENDING_ROW;
    const fetch = provider({ status: 200, body: { id: 77, domain: "old-domain.com" } }, { status: 200, body: { valid: true } });
    await verifySendingDomain({ tenantId: "tenant-a" }, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenLastCalledWith("tenant-a", "tenant_sending_domain_set_status", expect.objectContaining({ p_status: "pending" }));
  });

  it("re-checks a verified domain once it is a day old, and un-verifies it when the provider no longer has it", async () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    mocks.row = { ...PENDING_ROW, verification_status: "verified", verified_at: "2026-10-01T00:00:00Z", last_checked_at: "2026-10-08T00:00:00Z" };
    const fresh = provider({ status: 404, body: null }, { status: 200, body: { valid: true } });
    await recheckSendingDomainIfStale("tenant-a", { fetch: fresh, now: () => now });
    expect(fresh).not.toHaveBeenCalled();

    mocks.row = { ...mocks.row, last_checked_at: "2026-10-07T00:00:00Z" };
    const gone = provider({ status: 404, body: null }, { status: 200, body: { valid: true } });
    await recheckSendingDomainIfStale("tenant-a", { fetch: gone, now: () => now });
    expect(mocks.rpc).toHaveBeenLastCalledWith("tenant-a", "tenant_sending_domain_set_status", expect.objectContaining({ p_status: "pending" }));

    mocks.rpc.mockClear();
    const down = vi.fn(async () => {
      throw new Error("network");
    });
    await recheckSendingDomainIfStale("tenant-a", { fetch: down as never, now: () => now });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("a verified domain that fails the daily re-check is marked failed with its own wording, never first-setup pending", async () => {
    const now = Date.parse("2026-10-08T12:00:00Z");
    const rec = { status: 200, body: { id: 77, domain: "acme.com" } };
    mocks.row = { ...PENDING_ROW, verification_status: "verified", verified_at: "2026-10-01T00:00:00Z", last_checked_at: "2026-10-07T00:00:00Z" };
    await recheckSendingDomainIfStale("tenant-a", { fetch: provider(rec, { status: 200, body: { valid: false } }), now: () => now });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenLastCalledWith("tenant-a", "tenant_sending_domain_set_status", {
      p_provider_domain_id: "77",
      p_domain: "acme.com",
      p_status: "failed",
      p_error: DNS_CHECK_FAILED_ERROR,
    });
    expect(DNS_CHECK_FAILED_ERROR).toMatch(/failed its DNS check/);
    expect(DNS_CHECK_FAILED_ERROR).not.toMatch(/up to a day|yet/);

    mocks.row = { ...mocks.row, verification_status: "failed", verified_at: null };
    await verifySendingDomain({ tenantId: "tenant-a" }, { fetch: provider(rec, { status: 200, body: { valid: false } }) });
    expect(mocks.rpc).toHaveBeenLastCalledWith("tenant-a", "tenant_sending_domain_set_status", expect.objectContaining({ p_status: "failed", p_error: DNS_CHECK_FAILED_ERROR }));

    mocks.row = PENDING_ROW;
    await verifySendingDomain({ tenantId: "tenant-a" }, { fetch: provider(rec, { status: 200, body: { valid: false } }) });
    expect(mocks.rpc).toHaveBeenLastCalledWith("tenant-a", "tenant_sending_domain_set_status", expect.objectContaining({ p_status: "pending", p_error: expect.stringMatching(/DNS changes can take up to a day/) }));

    mocks.row = { ...PENDING_ROW, verification_status: "failed" };
    await verifySendingDomain({ tenantId: "tenant-a" }, { fetch: provider(rec, { status: 200, body: { valid: true } }) });
    expect(mocks.rpc).toHaveBeenLastCalledWith("tenant-a", "tenant_sending_domain_set_status", expect.objectContaining({ p_status: "verified", p_error: null }));
  });

  it("refuses Zavi's own domains and their subdomains", () => {
    expect(() => normalizeSendingDomain("zaviagent.com")).toThrow(/Zavi's own domains/);
    expect(() => normalizeSendingDomain("inbox.zaviagent.com")).toThrow(/Zavi's own domains/);
    expect(normalizeSendingDomain("notzaviagent.com")).toBe("notzaviagent.com");
  });

  it("bulk sends only From a verified domain, and the From is always on that domain", async () => {
    mocks.row = { domain: "acme.com", from_address: null, verification_status: "pending" };
    expect(await resolveBulkSender("t")).toBeNull();
    mocks.row = { domain: "acme.com", from_address: null, from_name: "Acme", verification_status: "verified", provider_domain_id: "77" };
    expect(await resolveBulkSender("t")).toEqual({ domain: "acme.com", from_address: "hello@acme.com", from_name: "Acme" });
    mocks.row = { domain: "acme.com", from_address: "news@other.com", from_name: null, verification_status: "verified", provider_domain_id: "77" };
    expect((await resolveBulkSender("t"))?.from_address).toBe("hello@acme.com");
    mocks.row = null;
    expect(await resolveBulkSender("t")).toBeNull();
  });
});
