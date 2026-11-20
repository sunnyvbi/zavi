vi.mock("@/services/ads-wallet/accounts",()=>({assertAccountAvailableForNewCampaign:async()=>{}}));
vi.mock("@/services/ads-wallet/bindings", () => ({
  findCampaignBinding: async () => null,
  legacyChatgptAccount: async () => ({ id: "account-binding" }),
  claimCampaignAccount: async () => ({ id: "account-binding" }),
  bindCampaign: async () => ({ id: "campaign-binding" }),
}));
vi.mock("../account-binding", () => ({ resolveChatgptAccount: async () => ({ key: "test-key" }) }));
vi.mock("../growth-workspace-budget", () => ({ withWorkspaceGrowthBudget: async (_t: unknown, _p: unknown, _n: unknown, _op: unknown, write: () => Promise<unknown>) => write() }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), prefix: vi.fn(), reserve: vi.fn(), reserveIfFunded: vi.fn(), upload: vi.fn(), serving: vi.fn(), sign: vi.fn(), signArtifact: vi.fn() }));
vi.mock("@/services/chat-images/sign-own-image", () => ({ signOwnImageForVendor: mocks.sign }));
vi.mock("../generated-image", () => ({ signGeneratedAdImage: mocks.signArtifact }));
vi.mock("../creative-upload", () => ({ stableCreativeUpload: mocks.upload }));
vi.mock("../serving", () => ({ assertServingReady: mocks.serving }));
vi.mock("../http", () => ({ chatgptAdsGet: mocks.get, chatgptAdsPost: mocks.post }));
vi.mock("../key-provider", () => ({ getChatgptAdsApiKey: async () => "test-key" }));
vi.mock("../tenant-scope", async importOriginal => ({ ...await importOriginal<typeof import("../tenant-scope")>(), resolveTenantCampaignPrefix: mocks.prefix }));
vi.mock("@/services/channels/chatgpt-ads/wallet", () => ({ reserveCampaign: mocks.reserve, reserveIfFunded: mocks.reserveIfFunded }));
import { campaignChange, createCampaign, readCampaignEntities, updateAdStatus, updateCampaign, updateGroupStatus, saveAdCreative, createAdGroup } from "../workspace";
const requestId = "11111111-1111-4111-8111-111111111111";
const campaign = { id: "c1", name: "zv-acme--launch", status: "paused", updated_at: 10, budget: { lifetime_spend_limit_micros: 100000000 } };
beforeEach(() => { vi.resetAllMocks(); mocks.upload.mockResolvedValue({ file_id: "file1" }); mocks.prefix.mockResolvedValue("zv-acme--"); mocks.get.mockResolvedValue(campaign); mocks.post.mockImplementation(async (_k, _p, body) => ({ ...campaign, ...body })); });
afterEach(() => { vi.restoreAllMocks(); });
describe("ChatGPT Ads workspace ownership and money controls", () => {
  it("never reports a status change the provider did not confirm", async () => {
    mocks.post.mockResolvedValue({ ...campaign, status: "paused" });
    await expect(updateCampaign("acme", "c1", { status: "active" })).rejects.toMatchObject({ code: "chatgpt_ads_bad_response" });
  });
  it("refuses a different tenant's campaign before a write", async () => {
    mocks.get.mockResolvedValue({ ...campaign, name: "zv-acme-labs--launch" });
    await expect(updateCampaign("acme", "c1", { status: "paused" })).rejects.toMatchObject({ code: "chatgpt_ads_not_found" });
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("cannot rename into another workspace namespace", async () => {
    await expect(updateCampaign("acme", "c1", { name: "globex--launch" })).rejects.toThrow();
    await updateCampaign("acme", "c1", { name: "new launch" });
    expect(mocks.post).toHaveBeenCalledWith("test-key", "/campaigns/c1", { name: "zv-acme--new launch" });
  });
  it("rejects stale edits before reserving or writing", async () => {
    await expect(updateCampaign("acme", "c1", { status: "active", expected_updated_at: 9 })).rejects.toMatchObject({ code: "chatgpt_ads_conflict" });
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
  it("does not activate when funds cannot be reserved", async () => {
    mocks.reserve.mockRejectedValue(new Error("Insufficient funds"));
    await expect(updateCampaign("acme", "c1", { status: "active" })).rejects.toThrow("Insufficient funds");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("reserves the new lifetime amount before activation", async () => {
    await updateCampaign("acme", "c1", { status: "active", lifetime_budget_micros: 200000000 });
    expect(mocks.reserve).toHaveBeenCalledWith("acme", "c1", 200000000);
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.post.mock.invocationCallOrder[0]);
  });
  it("allows pausing even if funding is unavailable", async () => {
    mocks.get.mockResolvedValue({ ...campaign, status: "active" });
    await updateCampaign("acme", "c1", { status: "paused" });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.post).toHaveBeenCalledWith("test-key", "/campaigns/c1", { status: "paused" });
  });
  it("creates paused campaigns with server-derived ownership", async () => {
    await createCampaign("acme", { name: "launch", lifetime_budget_micros: 100000000, bidding_type: "clicks" }, requestId);
    expect(mocks.post).toHaveBeenCalledWith("test-key", "/campaigns", expect.objectContaining({ name: "zv-acme--launch", status: "paused" }), expect.any(String));
  });
  it("rejects invented daily-budget and tracking fields", () => {
    expect(campaignChange.safeParse({ daily_budget: 50 }).success).toBe(false);
    expect(campaignChange.safeParse({ tracking: "x" }).success).toBe(false);
  });
  it.each([["a stale", 9], ["no", undefined]])("refuses child activation with %s campaign version, before reserving or writing", async (_l, expected) => {
    mocks.get.mockImplementation(async (_k, path) => path === "/campaigns/c1" ? { ...campaign, status: "active" } : path === "/ad_groups" ? { data: [{ id: "g1", campaign_id: "c1" }] } : { data: [{ id: "ad1", ad_group_id: "g1" }] });
    await expect(updateAdStatus("acme", "c1", "g1", "ad1", "active", expected)).rejects.toMatchObject({ code: "chatgpt_ads_conflict" });
    await expect(updateGroupStatus("acme", "c1", "g1", "active", expected)).rejects.toMatchObject({ code: "chatgpt_ads_conflict" });
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
  it("activates a child when the confirmed campaign version is current, and pauses without one", async () => {
    mocks.get.mockImplementation(async (_k, path) => path === "/campaigns/c1" ? campaign : path === "/ad_groups" ? { data: [{ id: "g1", campaign_id: "c1" }] } : { data: [{ id: "ad1", ad_group_id: "g1" }] });
    mocks.post.mockImplementation(async (_k, path, body) => ({ id: String(path).split("/").pop(), ...body }));
    await expect(updateAdStatus("acme", "c1", "g1", "ad1", "active", 10)).resolves.toEqual({ id: "ad1", status: "active" });
    await expect(updateGroupStatus("acme", "c1", "g1", "paused")).resolves.toEqual({ id: "g1", status: "paused" });
  });
  it("refuses ads whose ad group belongs to another campaign", async () => {
    mocks.get.mockImplementation(async (_k, path) => path === "/campaigns/c1" ? campaign : { data: [{ id: "foreign-group", campaign_id: "foreign" }] });
    await expect(updateAdStatus("acme", "c1", "foreign-group", "ad1", "active", 10)).rejects.toMatchObject({ code: "chatgpt_ads_not_found" });
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("drops foreign entities and metrics from a campaign response", async () => {
    mocks.get.mockImplementation(async (_k, path) => path === "/campaigns/c1" ? campaign : path === "/ad_account" ? { timezone: "UTC" } : path === "/ad_groups" ? { data: [{ id: "g1", name: "ours" }, { id: "g2", name: "foreign", campaign_id: "other" }] } : { data: [{ campaign_id: "other", ad_group_id: "g1", spend: 9000 }] });
    const rows = await readCampaignEntities("acme", "c1", "ad_group", 7);
    expect(rows).toHaveLength(1); expect(rows[0]).not.toHaveProperty("spend"); expect(JSON.stringify(rows)).not.toContain("foreign");
  });
  it("validates tracking before uploading an image", async () => {
    await expect(saveAdCreative("acme", "c1", { ad_group_id: "g1", name: "new ad", title: "Try us", body: "A useful offer", target_url: "https://example.com", image_url: "https://example.com/image.png", tracking: "redirect=https://other.com" }, undefined, requestId)).rejects.toThrow("utm_");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("uploads the image and saves a paused card with tracking and the returned file_id", async () => {
    mocks.get.mockImplementation(async (_k, path) => path === "/campaigns/c1" ? campaign : { data: [{ id: "g1", campaign_id: "c1" }] });
    mocks.post.mockImplementation(async (_k, path) => path === "/upload" ? { file_id: "file1" } : { id: "ad1", status: "paused" });
    await saveAdCreative("acme", "c1", { ad_group_id: "g1", name: "new ad", title: "Try us", body: "A useful offer", target_url: "https://example.com?existing=1", image_url: "https://example.com/image.png", tracking: "utm_source=chatgpt" }, undefined, requestId);
    expect(mocks.post).toHaveBeenLastCalledWith("test-key", "/ads", expect.objectContaining({ status: "paused", creative: expect.objectContaining({ file_id: "file1", target_url: "https://example.com/?existing=1&utm_source=chatgpt" }) }), expect.any(String));
  });
  it("a private image is signed only for the upload, and the retry record keeps the path", async () => {
    const tenant = "11111111-1111-4111-8111-111111111111";
    const path = `${tenant}/33333333-3333-4333-8333-333333333333.jpg`;
    mocks.sign.mockResolvedValue("https://storage.example/signed");
    mocks.get.mockImplementation(async (_k, p) => p === "/campaigns/c1" ? campaign : { data: [{ id: "g1", campaign_id: "c1" }] });
    mocks.post.mockResolvedValue({ id: "ad1", status: "paused" });
    await saveAdCreative(tenant, "c1", { ad_group_id: "g1", name: "new ad", title: "Try us", body: "A useful offer", target_url: "https://example.com", image_path: path, tracking: "" }, undefined, requestId);
    expect(mocks.sign).toHaveBeenCalledWith(tenant, path);
    const [, , input, , fetchUrl] = mocks.upload.mock.calls[0];
    expect(input).toMatchObject({ image_path: path }); expect(input).not.toHaveProperty("image_url");
    expect(fetchUrl).toBe("https://storage.example/signed");
    expect(JSON.stringify(mocks.post.mock.calls)).not.toContain("storage.example");
  });
  it("refuses another workspace's image before any upload or ad write", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    mocks.sign.mockRejectedValue(new ExpectedToolError("image_not_owned", "not yours"));
    mocks.get.mockImplementation(async (_k, p) => p === "/campaigns/c1" ? campaign : { data: [{ id: "g1", campaign_id: "c1" }] });
    await expect(saveAdCreative("acme", "c1", { ad_group_id: "g1", name: "new ad", title: "Try us", body: "A useful offer", target_url: "https://example.com", image_path: "22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.jpg", tracking: "" }, undefined, requestId)).rejects.toMatchObject({ code: "image_not_owned" });
    expect(mocks.upload).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });
  it("an ad cannot carry both an image link and a private image", async () => {
    await expect(saveAdCreative("acme", "c1", { ad_group_id: "g1", name: "new ad", title: "Try us", body: "A useful offer", target_url: "https://example.com", image_url: "https://example.com/i.png", image_path: "11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.jpg", tracking: "" }, undefined, requestId)).rejects.toMatchObject({ code: "chatgpt_ads_conflict" });
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("saves an ad into the group it just created even when the group list lags the create", async () => {
    mocks.get.mockImplementation(async (_k, path) => path === "/campaigns/c1" ? campaign : { data: [] });
    mocks.post.mockImplementation(async (_k, path) => path === "/upload" ? { file_id: "file1" } : { id: "ad1", status: "paused" });
    const ad = { ad_group_id: "g1", name: "new ad", title: "Try us", body: "A useful offer", target_url: "https://example.com", image_url: "https://example.com/image.png", tracking: "" };
    await expect(saveAdCreative("acme", "c1", ad, undefined, requestId)).rejects.toMatchObject({ code: "chatgpt_ads_not_found" });
    await expect(saveAdCreative("acme", "c1", ad, undefined, requestId, "g1")).resolves.toEqual({ id: "ad1", status: "paused" });
    await expect(saveAdCreative("acme", "c1", { ...ad, ad_group_id: "g2" }, undefined, requestId, "g1")).rejects.toMatchObject({ code: "chatgpt_ads_not_found" });
  });
  it("rejects an edit to another group's ad without uploading or writing", async () => {
    mocks.get.mockImplementation(async (_k, path) => path === "/campaigns/c1" ? campaign : path === "/ad_groups" ? { data: [{ id: "g1", campaign_id: "c1" }] } : { data: [{ id: "ad1", ad_group_id: "foreign", creative: { type: "chat_card" } }] });
    await expect(saveAdCreative("acme", "c1", { ad_group_id: "g1", name: "new ad", title: "Try us", body: "A useful offer", target_url: "https://example.com", tracking: "" }, "ad1")).rejects.toMatchObject({ code: "chatgpt_ads_not_found" });
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("creates CPC groups paused even when their parent is active", async () => {
    mocks.get.mockResolvedValue({ ...campaign, status: "active", bidding_type: "clicks" });
    await createAdGroup("acme", "c1", { name: "Buyer intent", context_hints: ["Looking for a useful offer"], max_bid_micros: 1000000 }, requestId);
    expect(mocks.post).toHaveBeenCalledWith("test-key", "/ad_groups", expect.objectContaining({ status: "paused", bidding_config: { billing_event_type: "click", strategy: "fixed_bid", max_bid_micros: 1000000 } }), expect.any(String));
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});

it("reuses a campaign create key across a timeout and scopes it to the tenant", async () => {
  const input = { name: "launch", lifetime_budget_micros: 100000000, bidding_type: "clicks" as const };
  mocks.post.mockRejectedValueOnce(new Error("timeout"));
  await expect(createCampaign("acme", input, requestId)).rejects.toThrow("timeout");
  await createCampaign("acme", input, requestId);
  expect(mocks.post.mock.calls[0][3]).toBe(mocks.post.mock.calls[1][3]);
  await createCampaign("other", input, requestId);
  expect(mocks.post.mock.calls[2][3]).not.toBe(mocks.post.mock.calls[1][3]);
});
it("does not activate before Zavi advertiser review is cleared", async () => {
  mocks.serving.mockRejectedValue(new Error("Advertiser not approved"));
  await expect(updateCampaign("acme", "c1", { status: "active" })).rejects.toThrow("not approved");
  expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
});
it("retains group controls when metrics or the reporting timezone cannot be read", async () => {
  mocks.get.mockImplementation(async (_k, path) => {
    if (path === "/campaigns/c1") return campaign;
    if (path === "/ad_groups") return { data: [{ id: "g1", name: "Our group", status: "active" }] };
    throw new Error("reporting unavailable");
  });
  const rows = await readCampaignEntities("acme", "c1", "ad_group", 7);
  expect(rows).toEqual([expect.objectContaining({ id: "g1", status: "active", metrics_unavailable: true })]);
  expect(rows[0].spend).toBeUndefined();
});

it("lists only owned campaign pause controls without reading metrics", async () => {
  const { readCampaignSafety } = await import("../workspace");
  mocks.get.mockResolvedValue({ data: [campaign, { ...campaign, id: "foreign", name: "zv-other--Launch" }], has_more: false });
  expect(await readCampaignSafety("acme")).toEqual({ campaigns: [{ id: "c1", name: "launch", status: "paused", updated_at: 10 }], complete: true });
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(mocks.get).toHaveBeenCalledWith("test-key", "/campaigns", expect.any(Object));
});
it("warns when a namespace collision makes campaign ownership ambiguous", async () => {
  const { readCampaignSafety } = await import("../workspace");
  mocks.get.mockResolvedValue({ data: [{ ...campaign, name: "zv-acme--labs--launch" }], has_more: false });
  expect(await readCampaignSafety("acme")).toEqual({ campaigns: [], complete: false });
});
it("marks the safety list incomplete when a provider row cannot be read", async () => {
  const { readCampaignSafety } = await import("../workspace");
  mocks.get.mockResolvedValue({ data: [{ ...campaign, name: undefined }], has_more: false });
  expect(await readCampaignSafety("acme")).toEqual({ campaigns: [], complete: false });
});

it("exposes only sanitized serving codes, not arbitrary provider diagnostics", async () => {
  mocks.get.mockImplementation(async (_key,path) => path === "/campaigns/c1" ? campaign : path === "/ad_account" ? {timezone:"UTC"} : path === "/ad_groups" ? {data:[{id:"g1",name:"Our group",serving_issues:[{code:"campaign_not_active",message:"private provider detail"},{code:"https://private.example/secret"}]}]} : {data:[]});
  const rows = await readCampaignEntities("acme","c1","ad_group",7);
  expect(rows[0].serving_issues).toEqual(["campaign not active"]);
  expect(JSON.stringify(rows)).not.toMatch(/private|secret/);
});

it("uploads a generated artifact using a fresh signed link while retry identity stays the artifact ID", async () => {
  const artifact = "a51bf6d9-cb5b-4959-97ab-42bb8480319a";
  mocks.signArtifact.mockResolvedValueOnce("https://storage.example/first").mockResolvedValueOnce("https://storage.example/refreshed");
  mocks.get.mockImplementation(async (_k, path) => path === "/campaigns/c1" ? campaign : { data: [{ id: "g1", campaign_id: "c1" }] });
  mocks.post.mockResolvedValue({ id: "ad1", status: "paused" });
  const ad = { ad_group_id: "g1", name: "Renters ad", title: "Rent a car", body: "Compare local cars", target_url: "https://example.com", image_artifact_id: artifact, tracking: "" };
  await saveAdCreative("acme", "c1", ad, undefined, requestId);
  await saveAdCreative("acme", "c1", ad, undefined, requestId);
  expect(mocks.signArtifact).toHaveBeenCalledWith("acme", artifact);
  const first = mocks.upload.mock.calls[0], retry = mocks.upload.mock.calls[1];
  expect(first.slice(0, 4)).toEqual(retry.slice(0, 4));
  expect(first[2]).toMatchObject({ image_artifact_id: artifact });
  expect(first[2]).not.toHaveProperty("image_url");
  expect(first[4]).toBe("https://storage.example/first");
  expect(retry[4]).toBe("https://storage.example/refreshed");
  expect(mocks.post).toHaveBeenCalledWith("test-key", "/ads", expect.objectContaining({ status: "paused", creative: expect.objectContaining({ file_id: "file1" }) }), expect.any(String));
  expect(JSON.stringify(mocks.post.mock.calls)).not.toContain("storage.example");
});
it("does not upload or save when the generated artifact is no longer available", async () => {
  const { ExpectedToolError } = await import("@/services/tools/types");
  mocks.signArtifact.mockRejectedValue(new ExpectedToolError("image_not_owned", "Image unavailable"));
  mocks.get.mockImplementation(async (_k, path) => path === "/campaigns/c1" ? campaign : { data: [{ id: "g1", campaign_id: "c1" }] });
  await expect(saveAdCreative("acme", "c1", { ad_group_id: "g1", name: "Renters ad", title: "Rent a car", body: "Compare local cars", target_url: "https://example.com", image_artifact_id: "a51bf6d9-cb5b-4959-97ab-42bb8480319a", tracking: "" }, undefined, requestId)).rejects.toMatchObject({ code: "image_not_owned" });
  expect(mocks.upload).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});
