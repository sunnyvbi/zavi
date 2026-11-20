import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), accounts: vi.fn(), owned: vi.fn(), list: vi.fn(), report: vi.fn(), lost: vi.fn(), row: null as unknown, ledgerRows: [] as unknown[] }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.row, error: null }), eq: () => ({ limit: async (n: number) => ({ data: mocks.ledgerRows.slice(0, n), error: null }) }) }) }) }) }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: mocks.resolve, composioConnectionStoppedError: mocks.lost }));
vi.mock("./composio-read", () => ({ listAdAccounts: mocks.accounts }));
vi.mock("./adapter", async (original) => ({ ...await original<typeof import("./adapter")>(), ownedAccount: mocks.owned, listObjects: mocks.list }));
vi.mock("./reporting", async (original) => ({ ...await original<typeof import("./reporting")>(), reportRows: mocks.report }));
import { readRedditAccounts, redditCapacity } from "./budget-ledger";
import { ExpectedToolError } from "@/services/tools/types";
import { classifyAdReadError } from "@/services/connectors/core/read-error-kind";
const now = new Date("2026-10-09T01:00:00Z");
beforeEach(() => {
  vi.clearAllMocks(); mocks.row = null; mocks.resolve.mockResolvedValue({ tenant_id: "tenant" }); mocks.accounts.mockResolvedValue([{ id: "west" }, { id: "east" }]);
  mocks.owned.mockImplementation(async (_tenant: string, id: string) => ({ account: {}, details: { currency: "USD", time_zone_id: id === "west" ? "America/Los_Angeles" : "Asia/Tokyo" } }));
  mocks.list.mockImplementation(async (_a: unknown, id: string) => [{ id: `${id}_group`, campaign_id: `${id}_campaign`, effective_status: "ACTIVE", goal_type: "DAILY_SPEND", goal_value: 10000000, is_campaign_budget_optimization: false }]);
  mocks.report.mockImplementation(async (_a: unknown, id: string) => [{ ad_group_id: `${id}_group`, date: id === "west" ? "2026-10-08" : "2026-10-09", spend: 1250000 }]);
});
describe("fresh account-wide Reddit budget reads", () => {
  it("includes every owned account, each account clock and actual micros", async () => {
    const reads = await readRedditAccounts("tenant", new Date("2026-10-01T00:00:00Z"), now);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ platform: "reddit", account_id: "west", window: { since: "2026-09-30", until: "2026-10-08" }, campaigns: [{ level: "ad_group", budget_usd: 10, currency: "USD" }], spend: [{ amount_usd: 1.25, provisional: true }] });
    expect(reads[1].window).toEqual({ since: "2026-10-01", until: "2026-10-09" });
    expect(mocks.owned).toHaveBeenCalledWith("tenant", "west");
    expect(mocks.owned).toHaveBeenCalledWith("tenant", "east");
  });
  it("fails the whole read on unsupported currency or missing spend", async () => {
    mocks.owned.mockResolvedValueOnce({ account: {}, details: { currency: "EUR", time_zone_id: "Europe/Amsterdam" } });
    await expect(readRedditAccounts("tenant", now, now)).rejects.toThrow("unsupported currency EUR");
    mocks.report.mockResolvedValue([{ ad_group_id: "west_group", date: "2026-10-08" }]);
    await expect(readRedditAccounts("tenant", now, now)).rejects.toThrow("incomplete");
  });
});

describe("a Reddit Ads Composio account that is no longer ACTIVE", () => {
  it("throws Composio's reason (a login error with the date) when it can be read", async () => {
    mocks.resolve.mockResolvedValue(null); mocks.row = { slug: "composio.reddit_ads" };
    mocks.lost.mockResolvedValue(new ExpectedToolError("reddit_ads_connection_stopped", "Reddit Ads connection stopped working on Oct 15. Reconnect it.", { founder_reason: "Reddit Ads connection stopped working on Oct 15" }));
    const e = await readRedditAccounts("tenant", now, now).catch((x: unknown) => x);
    expect(mocks.lost).toHaveBeenCalledWith("tenant", "reddit_ads", "Reddit Ads");
    expect((e as ExpectedToolError).meta?.founder_reason).toBe("Reddit Ads connection stopped working on Oct 15");
    expect(classifyAdReadError(e)).toBe("auth");
  });
  it("falls back to the generic login error when Composio cannot say", async () => {
    mocks.resolve.mockResolvedValue(null); mocks.row = { slug: "composio.reddit_ads" }; mocks.lost.mockResolvedValue(null);
    const e = await readRedditAccounts("tenant", now, now).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/cannot be verified/);
    expect(classifyAdReadError(e)).toBe("auth");
  });
  it("no row: not connected, nothing asked of Composio", async () => {
    mocks.resolve.mockResolvedValue(null);
    expect(await readRedditAccounts("tenant", now, now)).toEqual([]);
    expect(mocks.lost).not.toHaveBeenCalled();
  });
});

describe("a campaign budget (CBO) counts once per campaign", () => {
  const cboGroups = [
    { id: "g_morning", campaign_id: "c_studio", effective_status: "ACTIVE", goal_type: "DAILY_SPEND", goal_value: 5000000, is_campaign_budget_optimization: true },
    { id: "g_evening", campaign_id: "c_studio", effective_status: "ACTIVE", goal_type: "DAILY_SPEND", goal_value: 5000000, is_campaign_budget_optimization: true },
  ];
  const campaign = (over: Record<string, unknown> = {}) => [{ id: "c_studio", effective_status: "ACTIVE", goal_type: "DAILY_SPEND", goal_value: 50000000, ...over }];

  it("the ledger read carries the campaign's daily budget on each ad group under it", async () => {
    mocks.accounts.mockResolvedValue([{ id: "west" }]);
    mocks.list.mockImplementation(async (_a: unknown, _id: string, level: string) => (level === "campaign" ? campaign() : cboGroups));
    mocks.report.mockResolvedValue([]);
    const [read] = await readRedditAccounts("tenant", now, now);
    expect(read.campaigns).toEqual([
      expect.objectContaining({ object_id: "g_morning", budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd: 50 }),
      expect.objectContaining({ object_id: "g_evening", budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd: 50 }),
    ]);
    mocks.list.mockImplementation(async (_a: unknown, _id: string, level: string) => (level === "campaign" ? campaign({ goal_type: "LIFETIME_SPEND" }) : cboGroups));
    expect((await readRedditAccounts("tenant", now, now))[0].campaigns[0]).toMatchObject({ campaign_budget_usd: null });
    mocks.list.mockImplementation(async (_a: unknown, _id: string, level: string) => (level === "campaign" ? [] : cboGroups));
    expect((await readRedditAccounts("tenant", now, now))[0].campaigns[0]).toMatchObject({ campaign_budget_usd: null });
  });

  const row = (over: Record<string, unknown> = {}) => ({ status: "ACTIVE", campaign_id: "c_studio", budget_kind: "campaign_level", budget_usd: null, campaign_budget_usd: 50, as_of: now.toISOString(), ...over });

  it("capacity is the campaign budget once: 50, not null and not 100", async () => {
    mocks.accounts.mockResolvedValue([{ id: "west" }]);
    mocks.ledgerRows = [row(), row(), row({ campaign_id: "c_other", budget_kind: "daily", budget_usd: 12, campaign_budget_usd: null })];
    expect(await redditCapacity("tenant", now)).toEqual({ connected: true, capacity_usd: 62 });
  });

  it("a lifetime or unreadable campaign budget stays unknown (fail closed)", async () => {
    mocks.accounts.mockResolvedValue([{ id: "west" }]);
    mocks.ledgerRows = [row({ campaign_budget_usd: null })];
    expect((await redditCapacity("tenant", now)).capacity_usd).toBeNull();
    mocks.ledgerRows = [row({ campaign_id: null })];
    expect((await redditCapacity("tenant", now)).capacity_usd).toBeNull();
    mocks.ledgerRows = [row({ budget_kind: "lifetime", budget_usd: 300, campaign_budget_usd: null })];
    expect((await redditCapacity("tenant", now)).capacity_usd).toBeNull();
    mocks.ledgerRows = [row({ as_of: new Date(now.getTime() - 80 * 60000).toISOString() })];
    expect((await redditCapacity("tenant", now)).capacity_usd).toBeNull();
    mocks.ledgerRows = [row({ as_of: new Date(now.getTime() - 40 * 60000).toISOString() })];
    expect((await redditCapacity("tenant", now)).capacity_usd).toBe(50);
    mocks.ledgerRows = [row(), row({ status: "removed", as_of: new Date(now.getTime() - 3 * 86400000).toISOString() })];
    expect((await redditCapacity("tenant", now)).capacity_usd).toBe(50);
    mocks.ledgerRows = Array.from({ length: 1000 }, () => row());
    expect((await redditCapacity("tenant", now)).capacity_usd).toBeNull();
    mocks.ledgerRows = [];
    mocks.accounts.mockRejectedValue(new Error("reddit down"));
    expect((await redditCapacity("tenant", now)).capacity_usd).toBeNull();
  });
});
