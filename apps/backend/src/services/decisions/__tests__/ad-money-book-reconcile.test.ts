import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const reads = vi.hoisted(() => ({ chatgpt: vi.fn(), reddit: vi.fn(), x: vi.fn() }));
vi.mock("@/services/ads-wallet/chatgpt-ledger", () => ({ readChatgptAccountsForBudget: reads.chatgpt }));
vi.mock("@/services/connectors/reddit-ads/budget-ledger", () => ({ readRedditAccounts: reads.reddit }));
vi.mock("@/services/connectors/x-ads/budget-ledger", () => ({ readXAccountsForBudget: reads.x }));
vi.mock("@/services/decisions/ad-ledger-platforms", () => ({ LEDGER_ONLY_READERS: [], LEDGER_ONLY_PLATFORMS: [], isLedgerOnlyPlatform: () => false }));
class NotConnected extends Error {
  constructor(public code: string) {
    super(code);
  }
}
vi.mock("@/services/tools/meta-ads/_client", () => ({
  metaAdsCreds: async () => {
    throw new NotConnected("meta_ads_not_connected");
  },
  fbGet: vi.fn(),
  fbGetAllPages: vi.fn(),
}));
vi.mock("@/services/tools/meta-ads/list_ad_sets", () => ({ enumerateAccountAdSets: vi.fn() }));
vi.mock("@/services/tools/meta-ads/daily_series", () => ({ fetchMetaDailySeries: vi.fn() }));
vi.mock("@/services/tools/google-ads/_client", () => ({
  gadsCustomerId: async () => {
    throw new NotConnected("google_ads_not_connected");
  },
  gadsGetBudgetGuardFacts: vi.fn(),
  gadsSearch: vi.fn(),
}));
vi.mock("@/services/tools/google-ads/_read-window", () => ({ accountClock: vi.fn() }));
vi.mock("@/services/secrets/vault", () => ({ getSecret: async () => null }));
vi.mock("@/services/decisions/ad-changes", () => ({ logOutsideChanges: async () => undefined }));
vi.mock("@/services/decisions/ad-hold-resolve", () => ({
  resolveUnknownAdHolds: async () => ({ checked: 0 }),
  resolveInflightAdHolds: async () => ({ checked: 0 }),
}));
vi.mock("@/services/decisions/ad-budget-brake", () => ({ runBudgetBrake: async () => ({ status: "on_track", projected_usd: 0, cap_usd: 0 }) }));
vi.mock("@/services/growth/cgo-blockers", () => ({ alertFounderSafely: async () => undefined, adReadFailedBlocker: () => ({}), adReadSlowBlocker: () => ({}), adDisconnectedBlocker: () => ({}), overspendBlocker: () => ({}) }));

const rpcCalls = vi.hoisted(() => [] as string[]);
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  fleetSweepClient: () => {
    throw new Error("not used");
  },
  tenantClient: () => ({
    from: (t: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "gt", "lt", "order", "in"]) q[m] = () => q;
      q.range = async () => ({ data: [], error: null });
      q.maybeSingle = async () => ({ data: t === "ad_budgets" ? { read_failed: {} } : null, error: null });
      return q;
    },
  }),
  tenantRpc: async (_tid: string, name: string, args: Record<string, unknown>) => {
    rpcCalls.push(name);
    if (name === "start_ad_budget_month") return { data: { status: "active", rolled: false, month_start: "2026-10-01" }, error: null };
    if (name === "record_ad_budget_actual" || name === "record_ad_budget_partial_actual_v2")
      return { data: { status: "active", spent_usd: Number(args.p_actual_usd ?? 0), month_cap_usd: 1000, alarm: false }, error: null };
    if (name === "record_ad_ledger_read" || name === "clear_ad_budget_read_failed_platforms") return { data: { status: "recorded" }, error: null };
    throw new Error(`unexpected rpc ${name}`);
  },
}));

const store = vi.hoisted(() => vi.fn());
vi.mock("@/services/decisions/ad-money-book-store", () => ({ storeMonthSnapshot: store }));

import { reconcileBudget } from "../ad-budget-reconcile";

const T = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-05T12:00:00Z");
const B = { id: "b1", tenant_id: T, created_at: "2026-09-20T18:00:00Z" };
const chatgptAccount = () => ({
  platform: "chatgpt",
  account_id: "chatgpt:acct",
  campaigns: [{ object_id: "c1", level: "campaign", campaign_id: "c1", name: "One", budget_kind: "daily", budget_usd: 25, status: "ACTIVE", currency: "USD" }],
  spend: [{ object_id: "c1", spend_date: "2026-10-04", amount_usd: 12.5, provisional: false }],
  window: { since: "2026-10-01", until: "2026-10-05" },
});

beforeEach(() => {
  rpcCalls.length = 0;
  store.mockReset();
  reads.chatgpt.mockReset().mockImplementation(async () => chatgptAccount());
  reads.reddit.mockReset().mockResolvedValue([]);
  reads.x.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  delete process.env.AD_MONEY_BOOK_SHADOW;
  vi.restoreAllMocks();
});

describe("the month snapshot after the hourly reconcile (shadow)", () => {
  it("the reconcile's outcome and its database calls are the same with the snapshot off, stored, or throwing", async () => {
    const off = await reconcileBudget(B, NOW);
    const offCalls = [...rpcCalls];
    expect(off).toMatchObject({ outcome: "recorded", actual_usd: 12.5, status: "active", ledger_failed: [] });
    expect(store).not.toHaveBeenCalled();

    process.env.AD_MONEY_BOOK_SHADOW = "1";
    rpcCalls.length = 0;
    store.mockResolvedValue({ status: "stored", generation: 1, snapshot: {} });
    const stored = await reconcileBudget(B, NOW);
    expect(stored).toEqual(off);
    expect(rpcCalls).toEqual(offCalls);
    expect(store).toHaveBeenCalledTimes(1);

    rpcCalls.length = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    store.mockRejectedValue(new Error("ad_campaigns read failed: ledger down"));
    const threw = await reconcileBudget(B, NOW);
    expect(threw).toEqual(off);
    expect(rpcCalls).toEqual(offCalls);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/budget b1: snapshot not stored: ad_campaigns read failed/));
  });

  it("a whole read passes the accounts read, each with its own date today, and a read start no later than now", async () => {
    process.env.AD_MONEY_BOOK_SHADOW = "1";
    store.mockResolvedValue({ status: "stored", generation: 1, snapshot: {} });
    const before = Date.now();
    await reconcileBudget(B, NOW);
    const arg = store.mock.calls[0][0];
    expect(arg).toMatchObject({ tenant_id: T, budget_id: "b1", accounts: [{ platform: "chatgpt", account_id: "chatgpt:acct", today: "2026-10-05" }], unread_platforms: [], now: NOW });
    expect(arg.read_started_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(arg.read_started_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("a partial read still stores a snapshot, with the failed platform marked unread", async () => {
    process.env.AD_MONEY_BOOK_SHADOW = "1";
    store.mockResolvedValue({ status: "stored", generation: 2, snapshot: {} });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    reads.reddit.mockRejectedValue(new Error("Reddit is down"));
    const out = await reconcileBudget(B, NOW);
    expect(out).toMatchObject({ outcome: "read_failed" });
    expect(store.mock.calls[0][0]).toMatchObject({ accounts: [{ platform: "chatgpt" }], unread_platforms: ["reddit"] });
  });

  it("a platform whose ledger write failed is unread for the snapshot, not complete", async () => {
    process.env.AD_MONEY_BOOK_SHADOW = "1";
    store.mockResolvedValue({ status: "stored", generation: 3, snapshot: {} });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tc = await import("@/services/tenant-client");
    const real = tc.tenantRpc;
    vi.spyOn(tc, "tenantRpc").mockImplementation(((tid: never, name: string, args: never) =>
      name === "record_ad_ledger_read" ? Promise.resolve({ data: null, error: { message: "boom" } }) : real(tid, name, args)) as never);
    const out = await reconcileBudget(B, NOW);
    expect(out).toMatchObject({ outcome: "recorded", ledger_failed: ["chatgpt"] });
    expect(store.mock.calls[0][0]).toMatchObject({ accounts: [], unread_platforms: ["chatgpt"] });
  });
});
