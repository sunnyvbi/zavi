import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  row: null as null | Record<string, unknown>,
  updates: [] as Array<{ table: string; values: Record<string, unknown>; filters: Array<[string, string, unknown]> }>,
  updateError: null as null | { message: string },
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (...a: unknown[]) => mocks.rpc(...a),
  globalClient: () => ({ from: () => ({}) }),
  tenantClient: (tenantId: string) => ({
    from: (table: string) => ({
      select: () => ({ maybeSingle: async () => ({ data: mocks.row, error: null }) }),
      update: (values: Record<string, unknown>) => {
        const entry = { table, values, filters: [["eq", "tenant_id", tenantId]] as Array<[string, string, unknown]> };
        mocks.updates.push(entry);
        const chain = {
          eq: (col: string, v: unknown) => (entry.filters.push(["eq", col, v]), chain),
          is: (col: string, v: unknown) => (entry.filters.push(["is", col, v]), chain),
          then: (resolve: (r: { error: unknown }) => unknown) => {
            if (!mocks.updateError && mocks.row && entry.filters.every(([op, col, v]) => col === "tenant_id" || (op === "is" ? mocks.row![col] === v : mocks.row![col] === v))) {
              Object.assign(mocks.row, values);
            }
            return Promise.resolve({ error: mocks.updateError }).then(resolve);
          },
        };
        return chain;
      },
    }),
  }),
}));

import { getSendingDomain, markSendingDomainUnverified, recheckSendingDomainIfStale, resolveBulkSender, verifySendingDomain } from "../sending-domain";

const SENTENCE = "This domain is no longer set up with the email provider. Add it again.";
const KEYS = ["BULK_SENDGRID_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function copiedVerifiedRow(): Record<string, unknown> {
  return {
    domain: "acme.com",
    from_address: "hello@acme.com",
    from_name: "Acme",
    verification_status: "verified",
    verification_error: null,
    dns_records: [],
    provider_domain_id: null,
    verified_at: "2026-09-01T00:00:00Z",
    last_checked_at: "2026-09-01T00:00:00Z",
  };
}

describe("a verified row the email provider has never seen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updates = [];
    mocks.updateError = null;
    mocks.row = copiedVerifiedRow();
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.BULK_SENDGRID_API_KEY = "bulk-key";
    mocks.rpc.mockResolvedValue({ data: true, error: null });
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("is never handed to the bulk sender, though the row says verified", async () => {
    expect(await resolveBulkSender("tenant-a")).toBeNull();
    mocks.row = { ...copiedVerifiedRow(), provider_domain_id: "77" };
    expect(await resolveBulkSender("tenant-a")).toEqual({ domain: "acme.com", from_address: "hello@acme.com", from_name: "Acme" });
  });

  it("the provider's 403 path un-verifies it to pending with the add-it-again sentence, without asking the provider", async () => {
    const fetch = vi.fn();
    expect(await markSendingDomainUnverified("tenant-a", { fetch })).toBe("pending");
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0].table).toBe("tenant_sending_domain");
    expect(mocks.updates[0].values).toMatchObject({ verification_status: "pending", verification_error: SENTENCE, verified_at: null });
    expect(mocks.updates[0].filters).toEqual([
      ["eq", "tenant_id", "tenant-a"],
      ["eq", "domain", "acme.com"],
      ["is", "provider_domain_id", null],
    ]);
    expect(mocks.row).toMatchObject({ verification_status: "pending", verification_error: SENTENCE });
    expect(await resolveBulkSender("tenant-a")).toBeNull();
  });

  it("the 403 path un-verifies it even when the bulk key is unset", async () => {
    delete process.env.BULK_SENDGRID_API_KEY;
    expect(await markSendingDomainUnverified("tenant-a")).toBe("pending");
    expect(mocks.row).toMatchObject({ verification_status: "pending", verification_error: SENTENCE });
  });

  it("a failed un-verify write is reported, not swallowed", async () => {
    mocks.updateError = { message: "boom" };
    await expect(markSendingDomainUnverified("tenant-a")).rejects.toMatchObject({ code: "sending_domain_write_failed" });
  });

  it("the stale recheck before a send writes pending with the sentence instead of leaving it verified", async () => {
    const fetch = vi.fn();
    await recheckSendingDomainIfStale("tenant-a", { fetch, now: () => Date.parse("2026-10-23T00:00:00Z") });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.row).toMatchObject({ verification_status: "pending", verification_error: SENTENCE, verified_at: null });
  });

  it("the page shows it as pending with the add-it-again sentence, not Verified", async () => {
    expect(await getSendingDomain("tenant-a")).toMatchObject({ domain: "acme.com", status: "pending", last_error: SENTENCE, verified_at: null });
    expect(mocks.updates).toHaveLength(0);
    mocks.row = { ...copiedVerifiedRow(), provider_domain_id: "77" };
    expect(await getSendingDomain("tenant-a")).toMatchObject({ status: "verified", last_error: null, verified_at: "2026-09-01T00:00:00Z" });
  });

  it("Check now writes pending with the sentence and returns it, instead of 404 add-your-domain-first", async () => {
    const fetch = vi.fn();
    const result = await verifySendingDomain({ tenantId: "tenant-a" }, { fetch });
    expect(result).toMatchObject({ domain: "acme.com", status: "pending", last_error: SENTENCE, verified_at: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.updates).toHaveLength(1);
    expect(mocks.updates[0].filters).toEqual([
      ["eq", "tenant_id", "tenant-a"],
      ["eq", "domain", "acme.com"],
      ["is", "provider_domain_id", null],
    ]);
    expect(mocks.row).toMatchObject({ verification_status: "pending", verification_error: SENTENCE, verified_at: null });
    expect(await resolveBulkSender("tenant-a")).toBeNull();
  });

  it("Check now with no row at all is still 404", async () => {
    mocks.row = null;
    await expect(verifySendingDomain({ tenantId: "tenant-a" }, { fetch: vi.fn() })).rejects.toMatchObject({ status: 404, code: "sending_domain_missing" });
  });

  it("a row with a provider id still goes through the provider, and no direct write happens", async () => {
    mocks.row = { ...copiedVerifiedRow(), provider_domain_id: "77" };
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ valid: false }) }));
    expect(await markSendingDomainUnverified("tenant-a", { fetch })).toBe("failed");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.updates).toHaveLength(0);
    expect(mocks.rpc.mock.calls[0][1]).toBe("tenant_sending_domain_set_status");
  });
});
