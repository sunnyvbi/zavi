import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ account: vi.fn(), accounts: vi.fn(), groups: vi.fn(), get: vi.fn(), patch: vi.fn() }));
vi.mock("./composio-read", () => ({ redditAdsAccount: mocks.account, listAdAccounts: mocks.accounts }));
vi.mock("./adapter", () => ({ listObjects: mocks.groups, getObject: mocks.get }));
vi.mock("./writes", () => ({ patchObject: mocks.patch }));
import { pauseRedditBudgetObject } from "./spend-controls";
const account = { tenant_id: "tenant", connected_account_id: "owned" };
beforeEach(() => {
  vi.clearAllMocks(); mocks.account.mockResolvedValue(account); mocks.accounts.mockResolvedValue([{ id: "account" }]);
  mocks.groups.mockResolvedValue([{ id: "group", campaign_id: "campaign" }]);
  mocks.get.mockResolvedValue({ id: "group", configured_status: "PAUSED" }); mocks.patch.mockResolvedValue(undefined);
});
describe("Reddit budget expiry and emergency pauses", () => {
  it("checks ownership before pausing and confirms the group afterward", async () => {
    await pauseRedditBudgetObject("tenant", "group");
    expect(mocks.account).toHaveBeenCalledWith("tenant");
    expect(mocks.get).toHaveBeenCalledWith(account, "account", "ad_group", "group");
    expect(mocks.get.mock.invocationCallOrder[0]).toBeLessThan(mocks.patch.mock.invocationCallOrder[0]);
    expect(mocks.patch).toHaveBeenCalledWith(account, "ad_group", "group", { configured_status: "PAUSED" });
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it("pauses a held campaign through its verified child relationship", async () => {
    await pauseRedditBudgetObject("tenant", "campaign");
    expect(mocks.get).toHaveBeenCalledWith(account, "account", "campaign", "campaign");
    expect(mocks.patch).toHaveBeenCalledWith(account, "campaign", "campaign", { configured_status: "PAUSED" });
  });
  it("refuses an object outside the workspace accounts without writing", async () => {
    await expect(pauseRedditBudgetObject("tenant", "foreign")).rejects.toMatchObject({ code: "reddit_ads_object_not_owned" });
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it("refuses to confirm a pause while Reddit still reports the group active", async () => {
    mocks.get.mockResolvedValue({ id: "group", configured_status: "ACTIVE" });
    await expect(pauseRedditBudgetObject("tenant", "group")).rejects.toThrow("reservation is retained");
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });
});
