vi.mock("@/services/ads-wallet/chatgpt-account-preview",()=>({previewChatgptAccount:async()=>({key:"test",account:await m.currency()})}));
vi.mock("@/services/ads-wallet/bindings",()=>({claimCampaignAccount:async()=>({id:"pinned-account"})}));
vi.mock("../account-binding",()=>({resolveChatgptAccount:async()=>({key:"test",account:await m.currency()})}));
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ row: {} as any, profile: null as any, storageError: null as any, member: { role: "owner" } as any, read: vi.fn(), checkUpload: vi.fn(), imageReady: vi.fn(), imageCost: vi.fn(), rpc: vi.fn(), currency: vi.fn(), campaign: vi.fn(), group: vi.fn(), ad: vi.fn(), tier: vi.fn(), locked: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (v: string) => v, tenantRpc: m.rpc, tenantClient: (tenant: string) => ({ from: (table: string) => {
  m.read(tenant, table);
  let missing: string | null = null;
  const q: any = { select: (cols: string) => { if (table === "channel_actions") missing = m.row ? cols.split(",").map(c => c.trim()).find(c => !(c in m.row)) ?? null : null; return q; }, eq: () => q, limit: () => q, maybeSingle: async () => missing
    ? { data: null, error: { code: "42703", message: `column ${table}.${missing} does not exist` } }
    : ({ data: table === "tenant_users" ? m.member : table === "company_profiles" ? m.profile : m.row, error: table === "ads_creative_uploads" ? m.storageError : null }) }; return q;
} }) }));
vi.mock("@/services/chat-images/sign-own-image", async original => ({ ...await original<typeof import("@/services/chat-images/sign-own-image")>(), checkOwnImageForVendor: m.checkUpload }));
vi.mock("../key-provider", () => ({ getChatgptAdsApiKey: async () => "test" }));
vi.mock("../http", () => ({ chatgptAdsGet: m.currency }));
vi.mock("../workspace", async original => ({ ...await original<typeof import("../workspace")>(), createCampaign: m.campaign, createAdGroup: m.group, saveAdCreative: m.ad }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({ isChannelLocked: m.locked }));
vi.mock("@/services/media-router/router", () => ({ isTaskConfigured: m.imageReady, estimateCost: m.imageCost }));
vi.mock("@/services/company/facts", () => ({ getCompanyFacts: async () => m.profile ?? { name: null, nameIsWorkspaceLabel: false, website: null, competitors: [], facts: {} } }));
import { ExpectedToolError } from "@/services/tools/types";
import { PARTIAL_RISK_EXEC_CODES } from "@zavi/shared";
import { prepareCampaignAction, reviewCampaignAction, executeCampaignAction, campaignActionRequestId, STARTER } from "../action-execution";
const id = "10000000-0000-4000-8000-000000000001";
const draft = { type: "campaign_draft", name: "Launch test", bidding_type: "clicks", group: { name: "Buyer intent", context_hints: ["Which product fits?"] }, ads: [
  { name: "Card one", title: "A useful product", body: "Browse the collection", target_url: "https://client.example/offer", tracking: "utm_source=chatgpt" },
  { name: "Card two", title: "Choose a product", body: "Explore the range", target_url: "https://client.example/offer", tracking: "utm_source=chatgpt" },
] };
const input = { currency: "USD", lifetime_budget_micros: 100_000_000, max_bid_micros: 500_000, countries: ["US"], image_urls: ["https://cdn.example/one.png", "https://cdn.example/two.png"] };
beforeEach(() => {
  vi.clearAllMocks();
  m.checkUpload.mockReset().mockResolvedValue(undefined);
  m.row = { id, channel_slug: "chatgpt_ads", body: { step: { responsibility: "client", deliverable: { presentation: structuredClone(draft) } } }, status: "pending", exec_class: null, exec_status: null, exec_payload: null, approved_by: "owner", run_id: "20000000-0000-4000-8000-000000000002" };
  m.profile = null; m.imageReady.mockResolvedValue(true); m.imageCost.mockReturnValue(0.1);
  m.storageError = null; m.member = { role: "owner" }; m.currency.mockResolvedValue({ currency_code: "USD" }); m.rpc.mockResolvedValue({ data: { ok: true } });
  m.campaign.mockResolvedValue({ id: "c1" }); m.group.mockResolvedValue({ id: "g1" }); m.ad.mockResolvedValue({ id: "a1" }); m.tier.mockResolvedValue({ allowed: true }); m.locked.mockResolvedValue(false);
});
async function ready() {
  await prepareCampaignAction("tenant", id, "owner", input);
  m.row.exec_payload = m.rpc.mock.calls[0][2].p_payload;
  m.row.exec_class = "chatgpt_ads.create_campaign_bundle"; m.row.exec_status = "dispatching";
}
it("reviews the server-owned draft and verified currency without writing", async () => {
  expect(await reviewCampaignAction("tenant", id)).toEqual({
    draft, currency: "USD",
    suggested: { lifetime_budget_micros: 100_000_000, max_bid_micros: 2_000_000, countries: ["US"], budget_source: "starter", countries_source: "default" },
    ai_image: { available: true, credits: 40 },
  });
  expect(m.rpc).not.toHaveBeenCalled(); expect(m.campaign).not.toHaveBeenCalled();
  expect(m.read).toHaveBeenCalledWith("tenant", "channel_actions");
});
it("prepares the original card, with server-derived names and reviewed money, without approval or provider writes", async () => {
  await ready();
  expect(m.rpc).toHaveBeenCalledWith("tenant", "prepare_channel_campaign_action", expect.objectContaining({ p_action_id: id, p_actor_user_id: "owner", p_payload: expect.objectContaining({ campaign: expect.objectContaining({ name: draft.name, lifetime_budget_micros: input.lifetime_budget_micros }) }) }));
  expect(m.campaign).not.toHaveBeenCalled(); expect(m.ad).not.toHaveBeenCalled();
});
it.each([
  { ...input, status: "active" }, { ...input, tenant_id: "other" }, { ...input, image_urls: [input.image_urls[0]] },
  { ...input, image_urls: ["http://127.0.0.1/private", input.image_urls[1]] }, { ...input, lifetime_budget_micros: 0 },
])("rejects unsafe or incomplete inputs before preparing: %j", async value => {
  await expect(prepareCampaignAction("tenant", id, "owner", value)).rejects.toThrow(); expect(m.rpc).not.toHaveBeenCalled();
});
it("refuses a different currency before preparing or executing", async () => {
  m.currency.mockResolvedValue({ currency_code: "EUR" });
  await expect(prepareCampaignAction("tenant", id, "owner", input)).rejects.toThrow(/currency changed/);
  expect(m.rpc).not.toHaveBeenCalled();
});
it("never treats another tenant's missing row as a usable draft", async () => {
  m.row = null; await expect(reviewCampaignAction("other", id)).rejects.toThrow(/not found/); expect(m.currency).not.toHaveBeenCalled();
});
it("executes the stored bundle, with distinct stable request IDs for each entity", async () => {
  await ready();
  await expect(executeCampaignAction(id, "tenant", "owner")).resolves.toMatchObject({ ok: true });
  expect(m.campaign).toHaveBeenCalledWith("tenant", m.row.exec_payload.campaign, campaignActionRequestId(id, "campaign"));
  expect(m.group).toHaveBeenCalledWith("tenant", "c1", m.row.exec_payload.group, campaignActionRequestId(id, "group"));
  expect(m.ad.mock.calls.map(c => c[4])).toEqual([campaignActionRequestId(id, "ad:0"), campaignActionRequestId(id, "ad:1")]);
  expect(m.ad.mock.calls.every(c => c[2].ad_group_id === "g1" && c[5] === "g1")).toBe(true);
});
it("reuses the same keys after partial provider failure, rather than inventing a new bundle", async () => {
  await ready(); m.ad.mockRejectedValueOnce(new Error("timeout"));
  await expect(executeCampaignAction(id, "tenant", "owner")).resolves.toMatchObject({ ok: false, code: "exec_partial" });
  await executeCampaignAction(id, "tenant", "owner");
  expect(m.campaign.mock.calls[0]).toEqual(m.campaign.mock.calls[1]);
  expect(m.group.mock.calls[0]).toEqual(m.group.mock.calls[1]); expect(m.ad.mock.calls[0]).toEqual(m.ad.mock.calls[1]);
});
it.each(["no approval", "different approver", "member", "downgrade", "lock", "currency", "malformed second ad", "creative storage"])("checks %s again before any provider write", async reason => {
  await ready();
  if (reason === "creative storage") m.storageError = { code: "42P01" };
  if (reason === "no approval") m.row.exec_status = null;
  if (reason === "different approver") m.row.approved_by = "different";
  if (reason === "member") m.member.role = "member";
  if (reason === "downgrade") m.tier.mockResolvedValue({ allowed: false });
  if (reason === "lock") m.locked.mockResolvedValue(true);
  if (reason === "currency") m.currency.mockResolvedValue({ currency_code: "EUR" });
  if (reason === "malformed second ad") m.row.exec_payload.ads[1].tracking = "bad=value";
  await expect(executeCampaignAction(id, "tenant", "owner")).rejects.toThrow(); expect(m.campaign).not.toHaveBeenCalled(); expect(m.ad).not.toHaveBeenCalled();
});

it("reports missing setup before asking for money inputs", async () => {
  m.storageError = { code: "42P01" };
  await expect(reviewCampaignAction("tenant", id)).rejects.toThrow(/finishing campaign setup/);
  expect(m.currency).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
});

it.each([
  ["group", "the campaign (paused)"],
  ["first ad", "the campaign and ad group (paused)"],
  ["second ad", "the campaign, ad group and 1 of 2 ads (paused)"],
])("a failure on the %s after the campaign exists is exec_partial and names what was created", async (step, created) => {
  await ready();
  if (step === "group") m.group.mockRejectedValueOnce(new ExpectedToolError("chatgpt_ads_http_error", "HTTP 400", { status: 400 }));
  if (step === "first ad") m.ad.mockRejectedValueOnce(new Error("socket hang up"));
  if (step === "second ad") m.ad.mockResolvedValueOnce({ id: "a1" }).mockRejectedValueOnce(new Error("socket hang up"));
  const out = await executeCampaignAction(id, "tenant", "owner");
  expect(out).toMatchObject({ ok: false, code: "exec_partial" });
  expect((out as { error: string }).error).toContain(`Created ${created}`);
  expect((out as { error: string }).error).toMatch(/Open the campaign list/);
  expect(PARTIAL_RISK_EXEC_CODES).toContain((out as { code: string }).code);
});

it.each([
  ["a timeout", new Error("timeout")],
  ["a 5xx", new ExpectedToolError("chatgpt_ads_http_error", "HTTP 503", { status: 503 })],
  ["an unverifiable response", new ExpectedToolError("chatgpt_ads_bad_response", "could not be verified")],
])("an unclear first create (%s) is exec_outcome_unknown, and nothing else is attempted", async (_label, err) => {
  await ready(); m.campaign.mockRejectedValueOnce(err);
  await expect(executeCampaignAction(id, "tenant", "owner")).resolves.toMatchObject({ ok: false, code: "exec_outcome_unknown" });
  expect(m.group).not.toHaveBeenCalled(); expect(m.ad).not.toHaveBeenCalled();
});

it("a clean refusal of the first create still throws: nothing exists, so it may be approved again", async () => {
  await ready(); m.campaign.mockRejectedValueOnce(new ExpectedToolError("chatgpt_ads_http_error", "HTTP 400", { status: 400 }));
  await expect(executeCampaignAction(id, "tenant", "owner")).rejects.toThrow("HTTP 400");
  expect(m.group).not.toHaveBeenCalled();
});

const tenant = "11111111-1111-4111-8111-111111111111";
const ownPath = `${tenant}/33333333-3333-4333-8333-333333333333.jpg`;
const record = (facts: Record<string, string>, website: string | null = null) => ({ name: "Acme", nameIsWorkspaceLabel: false, website, competitors: [], facts: Object.fromEntries(Object.entries(facts).map(([k, value]) => [k, { value, source: "founder", verified_at: null }])) });
it("prefills the company's own country, labelled as from its profile", async () => {
  m.profile = record({ location: "Toronto, Ontario, Canada" });
  expect((await reviewCampaignAction(tenant, id)).suggested).toMatchObject({ countries: ["CA"], countries_source: "company_profile" });
});
it("a single-country markets fact counts; a list does not", async () => {
  m.profile = record({ markets: "Germany" });
  expect((await reviewCampaignAction(tenant, id)).suggested).toMatchObject({ countries: ["DE"], countries_source: "company_profile" });
  m.profile = record({ markets: "UK and Canada" });
  expect((await reviewCampaignAction(tenant, id)).suggested).toMatchObject({ countries: [STARTER.country], countries_source: "default" });
});
it("falls back to the website's country domain, labelled as from the website", async () => {
  m.profile = record({}, "https://shop.example.co.uk");
  expect((await reviewCampaignAction(tenant, id)).suggested).toMatchObject({ countries: ["GB"], countries_source: "website" });
  m.profile = record({}, "https://example.io");
  expect((await reviewCampaignAction(tenant, id)).suggested).toMatchObject({ countries: [STARTER.country], countries_source: "default" });
});
it.each(["San Francisco, CA", "Remote", "", null])("never guesses a country from an ambiguous location (%j): US, labelled a default", async location => {
  m.profile = location === null ? null : record({ location }, "https://example.com");
  expect((await reviewCampaignAction(tenant, id)).suggested).toMatchObject({ countries: [STARTER.country], countries_source: "default" });
});
it("gives no starter money for a non-USD account and no starter bid for a non-click objective", async () => {
  m.currency.mockResolvedValue({ currency_code: "EUR" });
  expect((await reviewCampaignAction(tenant, id)).suggested).toMatchObject({ lifetime_budget_micros: null, max_bid_micros: null });
  m.currency.mockResolvedValue({ currency_code: "USD" });
  m.row.body.step.deliverable.presentation.bidding_type = "impressions";
  expect((await reviewCampaignAction(tenant, id)).suggested).toMatchObject({ lifetime_budget_micros: 100_000_000, max_bid_micros: null });
});
it("offers no AI image when the draft has no run or the image service is off", async () => {
  m.row.run_id = null;
  expect((await reviewCampaignAction(tenant, id)).ai_image).toEqual({ available: false, credits: null });
  m.row.run_id = "20000000-0000-4000-8000-000000000002"; m.imageReady.mockResolvedValue(false);
  expect((await reviewCampaignAction(tenant, id)).ai_image).toEqual({ available: false, credits: null });
});
it("stores a private image as a path (one image shared by both ads) and a link as a link", async () => {
  await prepareCampaignAction(tenant, id, "owner", { ...input, image_urls: [ownPath, ownPath] });
  const ads = m.rpc.mock.calls[0][2].p_payload.ads;
  expect(ads.map((a: any) => [a.image_path, a.image_url])).toEqual([[ownPath, undefined], [ownPath, undefined]]);
  expect(m.rpc.mock.calls[0][2].p_exact_change.rows).toContainEqual({ item: "Ad image", before: "Not chosen", after: "One image shared by both ads" });
  m.rpc.mockClear();
  await prepareCampaignAction(tenant, id, "owner", { ...input, image_urls: [ownPath, "https://cdn.example/two.png"] });
  expect(m.rpc.mock.calls[0][2].p_payload.ads[1]).toMatchObject({ image_url: "https://cdn.example/two.png" });
});
it("refuses another workspace's image path before preparing (cross-tenant)", async () => {
  const theirs = `22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.jpg`;
  await expect(prepareCampaignAction(tenant, id, "owner", { ...input, image_urls: [theirs, theirs] })).rejects.toThrow(/not in this workspace/);
  expect(m.rpc).not.toHaveBeenCalled();
});
it.each(["../etc/passwd", `${tenant}/x.png`, `${tenant}/../other.jpg`, "agent-chat-images/" + ownPath])("refuses a malformed image reference %j", async bad => {
  await expect(prepareCampaignAction(tenant, id, "owner", { ...input, image_urls: [bad, bad] })).rejects.toThrow();
  expect(m.rpc).not.toHaveBeenCalled();
});
it("refuses to prepare a draft that is no longer waiting for review", async () => {
  m.row.status = "acted";
  await expect(prepareCampaignAction(tenant, id, "owner", input)).rejects.toThrow(/changed/);
  expect(m.rpc).not.toHaveBeenCalled();
});
it("tells the founder the ads are paused and where to launch them", async () => {
  await ready();
  await expect(executeCampaignAction(id, "tenant", "owner")).resolves.toEqual({ ok: true, notice: "Created 2 ads, paused. Launch the campaign from your campaign list when you are ready." });
});

it("refuses a deleted upload before preparing the review card", async () => {
  m.checkUpload.mockRejectedValue(new ExpectedToolError("image_unavailable", "Saved image missing"));
  await expect(prepareCampaignAction(tenant, id, "owner", { ...input, image_urls: [ownPath, ownPath] })).rejects.toMatchObject({ code: "image_unavailable" });
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.campaign).not.toHaveBeenCalled();
});
it("rechecks an uploaded image after approval before creating a paused campaign", async () => {
  await prepareCampaignAction(tenant, id, "owner", { ...input, image_urls: [ownPath, ownPath] });
  m.row.exec_payload = m.rpc.mock.calls[0][2].p_payload;
  m.row.exec_class = "chatgpt_ads.create_campaign_bundle";
  m.row.exec_status = "dispatching";
  m.checkUpload.mockRejectedValue(new ExpectedToolError("image_unavailable", "Saved image missing"));
  await expect(executeCampaignAction(id, tenant, "owner")).rejects.toMatchObject({ code: "image_unavailable" });
  expect(m.campaign).not.toHaveBeenCalled();
  expect(m.group).not.toHaveBeenCalled();
  expect(m.ad).not.toHaveBeenCalled();
});
