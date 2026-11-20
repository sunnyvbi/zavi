import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ wallet: null as any, pages: [] as any[], walletError: null as any, calls: [] as any[] }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (id: string) => id,
  tenantClient: (tenant: string) => ({ from(table: string) {
    const call = { tenant, table, select: "", filter: [] as any[], range: [] as number[] };
    m.calls.push(call);
    const q = {
      select(value: string) { call.select = value; return q; },
      eq(key: string, value: string) { call.filter.push([key, value]); return q; },
      order() { return q; },
      async maybeSingle() { return { data: m.wallet, error: m.walletError }; },
      async range(start: number, end: number) { call.range = [start, end]; return m.pages.shift() ?? { data: [], error: null }; },
    };
    return q;
  } }),
}));
import { readChatgptFundingContext } from "../funding-context";

beforeEach(() => { m.wallet = null; m.pages = []; m.walletError = null; m.calls = []; });
describe("ChatGPT funding evidence", () => {
  it("does not create a wallet for a workspace that has none", async () => {
    expect(await readChatgptFundingContext("tenant-a")).toMatchObject({ status: "read", balance_cents: 0, reserved_cents: 0, available_cents: 0, auto_refill_enabled: false });
    expect(m.calls.every(c => c.tenant === "tenant-a" && c.filter.some(([k, v]: string[]) => k === "tenant_id" && v === "tenant-a"))).toBe(true);
  });
  it("reports fully reserved funds without claiming campaigns must pause", async () => {
    m.wallet = { balance_cents: 10000, auto_refill_enabled: false };
    m.pages = [{ data: [{ campaign_id: "a", reserved_cents: 10000 }], error: null }];
    expect(await readChatgptFundingContext("tenant-a")).toMatchObject({ status: "read", balance_cents: 10000, reserved_cents: 10000, available_cents: 0, activation: "requires_campaign_review_and_reservation" });
  });
  it("does not leak payment identifiers into the context", async () => {
    m.wallet = { balance_cents: 10000, auto_refill_enabled: true, payment_method_id: "private", stripe_customer_id: "private" };
    const result = await readChatgptFundingContext("tenant-a");
    expect(result).toMatchObject({ auto_refill_enabled: true });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(m.calls[0].select).toBe("balance_cents, auto_refill_enabled");
  });
  it("includes all reservation pages", async () => {
    m.wallet = { balance_cents: 2000 };
    m.pages = [
      { data: Array.from({ length: 500 }, (_, i) => ({ campaign_id: String(i), reserved_cents: 1 })), error: null },
      { data: [{ campaign_id: "last", reserved_cents: "1000" }], error: null },
    ];
    expect(await readChatgptFundingContext("tenant-a")).toMatchObject({ reserved_cents: 1500, available_cents: 500 });
    expect(m.calls.at(-1).range).toEqual([500, 999]);
  });
  it("preserves an overcommitted balance instead of hiding it at zero", async () => {
    m.wallet = { balance_cents: -100 };
    expect(await readChatgptFundingContext("tenant-a")).toMatchObject({ available_cents: -100 });
  });
  it.each([null, "", "NaN", -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("refuses invalid reservation %s", async (amount) => {
    m.wallet = { balance_cents: 10000 };
    m.pages = [{ data: [{ reserved_cents: amount }], error: null }];
    expect(await readChatgptFundingContext("tenant-a")).toMatchObject({ status: "unavailable" });
  });
  it("does not report partial reservations as available money", async () => {
    m.wallet = { balance_cents: 1000 };
    m.pages = [{ data: null, error: { message: "private storage error" } }];
    const result = await readChatgptFundingContext("tenant-a");
    expect(result.status).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("private storage error");
  });
  it("distinguishes a failed wallet read from an empty wallet", async () => {
    m.walletError = { message: "down" };
    expect((await readChatgptFundingContext("tenant-a")).status).toBe("unavailable");
  });
});
