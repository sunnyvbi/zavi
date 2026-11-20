vi.mock("@/services/ads-wallet/accounts",()=>({assertAccountAvailableForNewCampaign:async()=>{}}));
vi.mock("@/services/ads-wallet/bindings", () => ({
  findCampaignBinding: async () => null,
  legacyChatgptAccount: async () => ({ id: "account-binding" }),
  claimCampaignAccount: async () => ({ id: "account-binding" }),
  bindCampaign: async () => ({ id: "campaign-binding" }),
}));
vi.mock("../account-binding", () => ({ resolveChatgptAccount: async () => ({ key: "test" }) }));
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), reserve: vi.fn(), options: vi.fn() }));
vi.mock("../resources", () => ({ resourceOptions: m.options, requireOption: (rows: Array<{ id: string }>, id: string) => { if (!rows.some(r => r.id === id)) throw new Error("Unassigned resource"); } }));
vi.mock("../http", () => ({ chatgptAdsGet: m.get, chatgptAdsPost: m.post }));
vi.mock("../key-provider", () => ({ getChatgptAdsApiKey: async () => "test" }));
vi.mock("../tenant-scope", () => ({ resolveTenantCampaignPrefix: async () => "zv-acme--", ownsCampaignName: (name: string) => name.startsWith("zv-acme--") }));
vi.mock("../serving", () => ({ assertServingReady: async () => {} }));
vi.mock("@/services/channels/chatgpt-ads/wallet", () => ({ reserveCampaign: m.reserve, reserveIfFunded: m.reserve }));
import { campaignCreate, createCampaign, createAdGroup, updateCampaign, editAdGroup } from "../workspace";
import { fundingLimit, tracking } from "../campaign-settings";
const request = "11111111-1111-4111-8111-111111111111";
const start = Math.floor(Date.now()/1000)+3600, end=start+86400;
const campaign = { id:"c1",name:"zv-acme--Launch",status:"paused",bidding_type:"conversions",budget:{daily_spend_limit_micros:25000000},start_time:start,end_time:end };
beforeEach(() => {
  vi.resetAllMocks();
  m.get.mockResolvedValue(campaign);
  m.post.mockImplementation(async (_k,_p,body) => ({ ...campaign,...body }));
  m.options.mockResolvedValue({conversion_events:[{id:"ours"}],inclusion_audiences:[],exclusion_audiences:[],product_feeds:[]});
});
it("requires exactly one conversion event and one budget type", () => {
  const base={name:"Launch",bidding_type:"conversions",lifetime_budget_micros:100000000};
  expect(campaignCreate.safeParse(base).success).toBe(false);
  expect(campaignCreate.safeParse({...base,conversion_event_setting_ids:["ours"]}).success).toBe(true);
  expect(campaignCreate.safeParse({...base,conversion_event_setting_ids:["ours"],daily_budget_micros:25000000}).success).toBe(false);
  expect(campaignCreate.safeParse({...base,bidding_type:"clicks",conversion_event_setting_ids:["ours"]}).success).toBe(false);
});
it("rejects another workspace’s event before creating anything", async () => {
  await expect(createCampaign("t",{name:"Launch",bidding_type:"conversions",lifetime_budget_micros:100000000,conversion_event_setting_ids:["foreign"]},request)).rejects.toThrow("Unassigned");
  expect(m.post).not.toHaveBeenCalled();
});
it("creates a paused conversion campaign with verified event, schedule and daily budget", async () => {
  await createCampaign("t",{name:"Launch",bidding_type:"conversions",daily_budget_micros:25000000,conversion_event_setting_ids:["ours"],start_time:start,end_time:end,targeting:{locations:{countries:["US"]}}},request);
  expect(m.post).toHaveBeenCalledWith("test","/campaigns",expect.objectContaining({status:"paused",bidding_type:"conversions",conversion_event_setting_ids:["ours"],budget:{daily_spend_limit_micros:25000000},start_time:start,end_time:end}),expect.any(String));
});
it("rejects open-ended daily campaigns and reversed schedules", async () => {
  await expect(createCampaign("t",{name:"Launch",bidding_type:"clicks",daily_budget_micros:25000000},request)).rejects.toThrow("end times");
  await expect(createCampaign("t",{name:"Launch",bidding_type:"clicks",daily_budget_micros:25000000,start_time:start,end_time:start-1},request)).rejects.toThrow("end time");
  expect(m.post).not.toHaveBeenCalled();
});
it("sends a CPA bid with click billing for conversion groups",async()=>{
  await createAdGroup("t","c1",{name:"Buyer intent",context_hints:[],max_bid_micros:100000000},request);
  expect(m.post.mock.calls[0][2].bidding_config).toEqual({billing_event_type:"click",strategy:"fixed_bid",max_bid_micros:100000000});
});
it.each(["clicks", "conversions"] as const)("maximizes %s only with a daily budget and without a fixed bid",async(objective)=>{
  const strategy = `maximize_${objective}` as const;
  m.get.mockResolvedValue({...campaign,bidding_type:objective});
  await createAdGroup("t","c1",{name:"Buyer intent",context_hints:[],strategy},request);
  expect(m.post.mock.calls[0][2]).toMatchObject({status:"paused",bidding_config:{billing_event_type:"click",strategy}});
  expect(m.post.mock.calls[0][2].bidding_config).not.toHaveProperty("max_bid_micros");
  await expect(createAdGroup("t","c1",{name:"Buyer intent",context_hints:[],strategy,max_bid_micros:1000},request)).rejects.toThrow("omit");
  m.get.mockResolvedValue({...campaign,bidding_type:objective,budget:{lifetime_spend_limit_micros:100000000}});
  await expect(createAdGroup("t","c1",{name:"Buyer intent",context_hints:[],strategy},request)).rejects.toThrow("daily budget");
  expect(m.post).toHaveBeenCalledOnce();
});
it("preserves existing group config but removes incompatible fixed-bid fields on strategy change", async()=>{
  m.get.mockImplementation(async (_k,p)=>p==="/campaigns/c1"?campaign:{data:[{id:"g1",campaign_id:"c1",bidding_config:{max_bid_micros:1000,custom_audience_bid_multipliers:[{}]}}]});
  m.post.mockResolvedValue({id:"g1",status:"paused"});
  await editAdGroup("t","c1","g1",{name:"New name",context_hints:[],strategy:"maximize_conversions"});
  expect(m.post.mock.calls[0][2]).toMatchObject({status:"paused",bidding_config:{strategy:"maximize_conversions"}});
  expect(m.post.mock.calls[0][2].bidding_config).not.toHaveProperty("max_bid_micros");
  expect(m.post.mock.calls[0][2].bidding_config).not.toHaveProperty("custom_audience_bid_multipliers");
});
it("checks existing funded coverage before editing a paused campaign schedule", async()=>{
  await updateCampaign("t","c1",{end_time:end+86400});
  expect(m.reserve).toHaveBeenCalledWith("t","c1",{daily_micros:25000000,start,end:end+86400});
  expect(m.reserve.mock.invocationCallOrder[0]).toBeLessThan(m.post.mock.invocationCallOrder[0]);
});
it("cannot clear daily end dates or change budget type",async()=>{
  await expect(updateCampaign("t","c1",{end_time:null})).rejects.toThrow("end times");
  await expect(updateCampaign("t","c1",{lifetime_budget_micros:100000000})).rejects.toThrow("budget type");
  expect(m.post).not.toHaveBeenCalled();
});
it("keeps pause available even after a daily campaign schedule ends",async()=>{
  m.get.mockResolvedValue({...campaign,status:"active",end_time:1});
  await updateCampaign("t","c1",{status:"paused"});
  expect(m.reserve).not.toHaveBeenCalled();
  expect(m.post.mock.calls[0][2]).toEqual({status:"paused"});
});
it("reserves twice the daily average for the bounded period plus boundary buffer",()=>{
  expect(fundingLimit(campaign)).toBe(150000000);
  expect(()=>fundingLimit({...campaign,end_time:undefined})).toThrow("bounded");
});
it("allows documented tracking placeholders but rejects redirect parameters",()=>{
  expect(tracking.safeParse("utm_campaign={campaign_id}&click_id={oppref}").success).toBe(true);
  expect(tracking.safeParse("redirect=https://evil.example").success).toBe(false);
  expect(tracking.safeParse("utm_source={invented_macro}").success).toBe(false);
});
it("creates product templates only for an assigned feed and never uploads an image", async()=>{
  const {saveAdCreative}=await import("../workspace");
  m.options.mockResolvedValue({conversion_events:[],inclusion_audiences:[],exclusion_audiences:[],product_feeds:[{id:"feed1"}]});
  m.get.mockImplementation(async(_k,p)=>p==="/campaigns/c1"?{...campaign,mode:"product_feed",product_feed_id:"feed1"}:p==="/ad_groups"?{data:[{id:"g1",campaign_id:"c1"}]}:{data:[]});
  m.post.mockResolvedValue({id:"ad1",status:"paused"});
  await saveAdCreative("t","c1",{ad_group_id:"g1",name:"Catalog ad",title:"Find a product",body:"Explore our products",creative_type:"product_ad_template",tracking:""},undefined,request);
  expect(m.post).toHaveBeenCalledTimes(1);
  expect(m.post.mock.calls[0][2].creative).toEqual({type:"product_ad_template",title:"Find a product",body:"Explore our products"});
  m.options.mockResolvedValue({conversion_events:[],inclusion_audiences:[],exclusion_audiences:[],product_feeds:[]});
  await expect(saveAdCreative("t","c1",{ad_group_id:"g1",name:"Catalog ad",title:"Find a product",body:"Explore our products",creative_type:"product_ad_template",tracking:""},undefined,request)).rejects.toThrow("Unassigned");
});
it("replaces legacy URL tracking when the explicit template is edited",async()=>{
  const {saveAdCreative}=await import("../workspace");
  m.get.mockImplementation(async(_k,p)=>p==="/campaigns/c1"?campaign:p==="/ad_groups"?{data:[{id:"g1",campaign_id:"c1"}]}:{data:[{id:"ad1",ad_group_id:"g1",creative:{type:"chat_card",file_id:"file1"}}]});
  m.post.mockResolvedValue({id:"ad1",status:"paused"});
  await saveAdCreative("t","c1",{ad_group_id:"g1",name:"Our ad",title:"Find a product",body:"Explore our products",target_url:"https://example.com/?utm_source=old&offer=car",tracking:"",landing_page_configuration:{query_string_template:"utm_source=new&click_id={oppref}"}},"ad1");
  expect(m.post.mock.calls[0][2].creative.target_url).toBe("https://example.com/?offer=car");
  expect(m.post.mock.calls[0][2].landing_page_configuration.query_string_template).toBe("utm_source=new&click_id={oppref}");
});
