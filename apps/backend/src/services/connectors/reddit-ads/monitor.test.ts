import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ autorun: vi.fn(), wake: vi.fn(), budget: vi.fn(), connection: vi.fn(), accounts: vi.fn(), owned: vi.fn(), list: vi.fn(), tracking: vi.fn(), read: vi.fn(), save: vi.fn() }));
vi.mock("@/services/growth/unattended-policy", () => ({ readChannelAutorun: mocks.autorun }));
vi.mock("@/services/growth/goal-owner", () => ({ enqueueGoalOwnerRun: mocks.wake }));
vi.mock("@/services/growth/cgo-ads", () => ({ cgoAdBudget: mocks.budget }));
vi.mock("./composio-read", () => ({ redditAdsAccount: mocks.connection, listAdAccounts: mocks.accounts }));
vi.mock("./adapter", () => ({ listObjects: mocks.list, ownedAccount: mocks.owned }));
vi.mock("./readiness", () => ({ tracking: mocks.tracking }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantClient: () => ({ from: (table: string) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { slug: "composio.reddit_ads" }, error: null }) }), maybeSingle: mocks.read }), upsert: mocks.save }) }) }));
import { monitorRedditAds, wakeRedditChange } from "./monitor";
let state: { fingerprint: string } | null;
beforeEach(() => {
  vi.clearAllMocks(); state = null; mocks.autorun.mockResolvedValue(true); mocks.wake.mockResolvedValue({ enqueued: true, run_id: "cgo_run" });
  mocks.read.mockImplementation(async () => ({ data: state, error: null })); mocks.save.mockImplementation(async (row: { fingerprint: string }) => { state = row; return { error: null }; });
  mocks.connection.mockResolvedValue({}); mocks.accounts.mockResolvedValue([{ id: "account" }]); mocks.owned.mockResolvedValue({ account: {}, details: { currency: "USD", admin_approval: "VALID" } });
  mocks.list.mockImplementation(async (_a: unknown, _id: string, level: string) => level === "ad" ? [{ id: "ad", configured_status: "ACTIVE", effective_status: "REJECTED" }] : [{ id: "group", configured_status: "ACTIVE", optimization_goal: "SIGN_UP", conversion_pixel_id: "pixel" }]);
  mocks.tracking.mockResolvedValue({ event_fresh: false }); mocks.budget.mockResolvedValue(null);
});
describe("scheduled Reddit monitoring", () => {
  it("wakes CGO once for changed delivery, tracking and budget issues", async () => {
    const first = await monitorRedditAds("tenant");
    expect(first.changed).toBe(true); expect(first.issues).toHaveLength(3);
    expect(mocks.wake).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant", reason: "reddit_ads_change", reddit: expect.objectContaining({ issues: first.issues }) }));
    expect((await monitorRedditAds("tenant")).changed).toBe(false); expect(mocks.wake).toHaveBeenCalledTimes(1);
  });
  it("does nothing when the channel setting is off", async () => {
    mocks.autorun.mockResolvedValue(false);
    expect(await monitorRedditAds("tenant")).toEqual({ issues: [], changed: false });
    await wakeRedditChange("tenant", "action:complete", ["completed"]);
    expect(mocks.connection).not.toHaveBeenCalled(); expect(mocks.wake).not.toHaveBeenCalled();
  });
  it("retains an incident for retry if the existing wake cap defers it", async () => {
    mocks.wake.mockResolvedValue({ enqueued: false, skipped: "daily_cap" });
    await monitorRedditAds("tenant"); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("reports disconnection as a recovery requirement", async () => {
    mocks.connection.mockRejectedValue(new Error("Reddit Ads is not connected. Reconnect it."));
    expect((await monitorRedditAds("tenant")).issues[0]).toContain("Reconnect");
    expect(mocks.wake).toHaveBeenCalledTimes(1);
  });
});
describe("paused parents", () => {
  it("raises nothing for ad groups and ads under a paused campaign", async () => {
    mocks.list.mockImplementation(async (_a: unknown, _id: string, level: string) =>
      level === "campaign" ? [{ id: "c1", configured_status: "PAUSED" }]
        : level === "ad_group" ? [{ id: "group", campaign_id: "c1", configured_status: "ACTIVE", optimization_goal: "SIGN_UP", conversion_pixel_id: "pixel" }]
          : [{ id: "ad", ad_group_id: "group", configured_status: "ACTIVE", effective_status: "REJECTED" }]);
    expect((await monitorRedditAds("tenant")).issues).toEqual([]);
  });
  it("still raises them under a campaign that is on", async () => {
    mocks.list.mockImplementation(async (_a: unknown, _id: string, level: string) =>
      level === "campaign" ? [{ id: "c1", configured_status: "ACTIVE" }]
        : level === "ad_group" ? [{ id: "group", campaign_id: "c1", configured_status: "ACTIVE", optimization_goal: "SIGN_UP", conversion_pixel_id: "pixel" }]
          : [{ id: "ad", ad_group_id: "group", configured_status: "ACTIVE", effective_status: "REJECTED" }]);
    expect((await monitorRedditAds("tenant")).issues).toHaveLength(3);
  });
});
