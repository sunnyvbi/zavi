vi.mock("../growth-workspace-budget", () => ({
  withWorkspaceGrowthBudget: async (
    _t: any,
    _p: any,
    _n: any,
    _o: any,
    write: any,
  ) => write(),
}));
vi.mock("@/services/ads-wallet/accounts", () => ({
  assertAccountAvailableForNewCampaign: m.available,
}));
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  available: vi.fn(),
  find: vi.fn(),
  getBinding: vi.fn(),
  legacy: vi.fn(),
  getAccount: vi.fn(),
  claim: vi.fn(),
  resolve: vi.fn(),
  bind: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock("@/services/ads-wallet/bindings", () => ({
  findCampaignBinding: m.find,
  getCampaignBinding: m.getBinding,
  legacyChatgptAccount: m.legacy,
  getAccountBinding: m.getAccount,
  claimCampaignAccount: m.claim,
  bindCampaign: m.bind,
}));
vi.mock("../account-binding", () => ({ resolveChatgptAccount: m.resolve }));
vi.mock("../tenant-scope", async (original) => ({
  ...(await original<typeof import("../tenant-scope")>()),
  resolveTenantCampaignPrefix: async () => "zv-acme--",
}));
vi.mock("../http", () => ({ chatgptAdsGet: m.get, chatgptAdsPost: m.post }));
vi.mock("../campaign-settings", async (original) => ({
  ...(await original<typeof import("../campaign-settings")>()),
  checkResources: async () => {},
}));
import { ownedCampaign, createCampaign, updateCampaign } from "../workspace";
const campaign = {
  id: "raw",
  name: "zv-acme--Launch",
  status: "paused",
  budget: { lifetime_spend_limit_micros: 10000000 },
};
const bound = {
  id: "internal",
  tenant_id: "t",
  platform: "chatgpt",
  provider_campaign_id: "raw",
  account_binding_id: "original",
};
beforeEach(() => {
  vi.resetAllMocks();
  m.find.mockResolvedValue(bound);
  m.getBinding.mockResolvedValue(bound);
  m.getAccount.mockResolvedValue({ id: "original" });
  m.legacy.mockResolvedValue({ id: "legacy" });
  m.claim.mockResolvedValue({ id: "pinned-create" });
  m.resolve.mockResolvedValue({ key: "bound-key" });
  m.bind.mockResolvedValue(bound);
  m.get.mockResolvedValue(campaign);
  m.post.mockResolvedValue(campaign);
});
it("resolves existing campaign credentials from its original binding, without consulting defaults", async () => {
  const result = await ownedCampaign("t", "raw");
  expect(result.binding).toEqual(bound);
  expect(m.getAccount).toHaveBeenCalledWith("t", "original");
  expect(m.resolve).toHaveBeenCalledWith("t", { id: "original" });
  expect(m.claim).not.toHaveBeenCalled();
  expect(m.legacy).not.toHaveBeenCalled();
  expect(m.bind).not.toHaveBeenCalled();
});
it("supports imported customer campaigns without weakening shared-account name ownership", async () => {
  m.find.mockResolvedValue({ ...bound, funding_source: "provider" });
  m.get.mockResolvedValue({ ...campaign, name: "Existing customer campaign" });
  expect((await ownedCampaign("t", "raw")).campaign.name).toBe(
    "Existing customer campaign",
  );
  m.find.mockResolvedValue({ ...bound, funding_source: "wallet" });
  await expect(ownedCampaign("t", "raw")).rejects.toMatchObject({
    code: "chatgpt_ads_not_found",
  });
});
it("lets the worker address an exact binding when raw IDs repeat", async () => {
  await ownedCampaign("t", "raw", "internal");
  expect(m.getBinding).toHaveBeenCalledWith("t", "internal");
  expect(m.find).not.toHaveBeenCalled();
});
it("refuses an internal binding for a different provider or campaign", async () => {
  m.getBinding.mockResolvedValue({ ...bound, platform: "linkedin" });
  await expect(ownedCampaign("t", "raw", "internal")).rejects.toMatchObject({
    code: "chatgpt_ads_not_found",
  });
  expect(m.get).not.toHaveBeenCalled();
});
it("imports a historic campaign only from the original account and after ownership proof", async () => {
  m.find.mockResolvedValue(null);
  await ownedCampaign("t", "raw");
  expect(m.resolve).toHaveBeenCalledWith("t", { id: "legacy" });
  expect(m.bind).toHaveBeenCalledWith("t", { id: "legacy" }, "raw");
  m.bind.mockClear();
  m.get.mockResolvedValue({ ...campaign, name: "zv-other--Launch" });
  await expect(ownedCampaign("t", "raw")).rejects.toMatchObject({
    code: "chatgpt_ads_not_found",
  });
  expect(m.bind).not.toHaveBeenCalled();
});
it("pins creation before sending the provider write and persists the returned campaign identity", async () => {
  const request = "10000000-0000-4000-8000-000000000001";
  await createCampaign(
    "t",
    {
      name: "Launch",
      bidding_type: "clicks",
      lifetime_budget_micros: 10000000,
    },
    request,
  );
  expect(m.claim).toHaveBeenCalledWith("t", "chatgpt", request);
  expect(m.claim.mock.invocationCallOrder[0]).toBeLessThan(
    m.post.mock.invocationCallOrder[0],
  );
  expect(m.resolve).toHaveBeenCalledWith("t", { id: "pinned-create" });
  expect(m.bind).toHaveBeenCalledWith("t", { id: "pinned-create" }, "raw");
});
it("blocks creation on a disabled selection while retaining access to its existing campaigns", async () => {
  m.available.mockRejectedValue(new Error("Selected account disabled"));
  await expect(
    createCampaign(
      "t",
      {
        name: "Launch",
        bidding_type: "clicks",
        lifetime_budget_micros: 10000000,
      },
      "10000000-0000-4000-8000-000000000001",
    ),
  ).rejects.toThrow("Selected account disabled");
  expect(m.resolve).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
  expect((await ownedCampaign("t", "raw")).binding).toEqual(bound);
});
it("sends no campaign read or create when credential verification fails", async () => {
  m.resolve.mockRejectedValue(new Error("account changed"));
  await expect(ownedCampaign("t", "raw")).rejects.toThrow("account changed");
  await expect(
    createCampaign(
      "t",
      {
        name: "Launch",
        bidding_type: "clicks",
        lifetime_budget_micros: 10000000,
      },
      "10000000-0000-4000-8000-000000000001",
    ),
  ).rejects.toThrow("account changed");
  expect(m.get).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});

it("reports a successful edit for an imported provider-funded campaign without a Zavi prefix", async () => {
  m.find.mockResolvedValue({ ...bound, funding_source: "provider" });
  m.resolve.mockResolvedValue({
    key: "own-key",
    account: { currency_code: "EUR" },
  });
  const previous = {
    ...campaign,
    name: "Imported customer campaign",
    updated_at: 1,
  };
  m.get.mockResolvedValue(previous);
  m.post.mockResolvedValue({
    ...previous,
    name: "Updated customer campaign",
    updated_at: 2,
  });
  expect(
    (
      await updateCampaign("t", "raw", {
        name: "Updated customer campaign",
        expected_updated_at: 1,
      })
    ).name,
  ).toBe("Updated customer campaign");
  expect(m.post).toHaveBeenCalled();
});
