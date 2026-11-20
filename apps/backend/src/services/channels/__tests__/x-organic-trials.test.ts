import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => Object.fromEntries(["rpc","card","existing","posts","disabled","locked","plan","budget","accounts","token","funding","own","country","place","access","file"].map(k => [k, vi.fn()])));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (x: string) => x, tenantRpc: m.rpc, tenantClient: () => ({ from: () => { const q = { select: (columns: string) => { q.maybeSingle = columns === "id" ? m.existing : m.card; return q; }, eq: () => q, maybeSingle: m.card }; return q; } }) }));
vi.mock("@/services/tenants/disabled", () => ({ isTenantDisabled: m.disabled }));
vi.mock("@/services/x-social/owned-posts", () => ({ readOwnedPostsShared: m.posts }));
vi.mock("@/services/growth/preview-plan", () => ({ refuseIfChannelPlanLocked: m.plan }));
vi.mock("../lock", () => ({ isChannelLockedStrict: m.locked }));
vi.mock("@/services/decisions/ad-month-counter", () => ({ readMonthCount: m.budget }));
vi.mock("@/services/connectors/x-ads/client", () => ({ xCampaignsUrl: () => "https://ads.x.com", listXAdAccounts: m.accounts, xAdsTenantToken: m.token, listXFundingInstruments: m.funding, listXOwnPosts: m.own, findXCountryPlace: m.place }));
vi.mock("@/services/connectors/x-ads/resources", () => ({ assertXWriteAccess: m.access }));
vi.mock("@/services/ad-locations/country", () => ({ businessCountry: m.country }));
vi.mock("../exec-actions", () => ({ recordChannelExecAction: m.file }));
import { matchTrialReceipts, processXOrganicTrial, trialBudget, type TrialCard, type XOrganicTrial } from "../x-organic-trials";
import type { XOwnedPost } from "@/services/x-social/owned-posts";
import { isPersonOnlyOrigin } from "@/services/growth/person-only";
const texts = ["Which part of booking a trip takes longest?", "What makes you try a new travel service?", "What travel problem should be easier?"];
const card: TrialCard = { status: "pending", body: { step: { deliverable: { kind: "post", parts: texts.map(content => ({ content })) } } } };
const base: XOrganicTrial = { action_id: "11111111-1111-4111-8111-111111111111", tenant_id: "22222222-2222-4222-8222-222222222222", run_id: "33333333-3333-4333-8333-333333333333", created_at: "2026-11-01T00:00:00Z", phase: "awaiting_posts", receipts: [], proposal: null };
const now = Date.parse("2026-11-05T00:00:00Z");
const posts = (): XOwnedPost[] => texts.map((text, i) => ({ id: String(100+i), text, created_at: "2026-11-01T01:00:00Z", is_reply:false, is_repost:false, public_metrics:{reply_count:i}, url:`https://x.com/i/web/status/${100+i}`,has_link:false,has_media:false,non_public_metrics:null,organic_metrics:null,thumb_url:null,media_type:null,video_views:null }));
let saved: XOrganicTrial;
beforeEach(() => {
  vi.clearAllMocks(); m.existing.mockResolvedValue({data:null,error:null}); saved=structuredClone(base);
  m.disabled.mockResolvedValue(false); m.locked.mockResolvedValue(false); m.plan.mockResolvedValue(null);
  m.card.mockResolvedValue({data:structuredClone(card),error:null}); m.posts.mockResolvedValue({items:posts(),fetched_at:new Date(now).toISOString(),partial_errors:[]});
  m.budget.mockResolvedValue({count:{monthly_usd:300,month_cap_usd:300,projection_usd:0,days_left:14}});
  m.accounts.mockResolvedValue([{id:"account1",currency:"USD"}]); m.token.mockResolvedValue({}); m.funding.mockResolvedValue([{id:"fund1",able_to_fund:true,currency:"USD"}]);
  m.own.mockResolvedValue(new Map([["102",{}]])); m.country.mockResolvedValue("US"); m.place.mockResolvedValue({id:"country1",name:"United States"}); m.access.mockResolvedValue(undefined); m.file.mockResolvedValue({id:"44444444-4444-4444-8444-444444444444"});
  m.rpc.mockImplementation(async (_t,_r,a) => { saved={...saved,phase:a.p_phase,proposal:saved.proposal??a.p_proposal,receipts:a.p_receipts??saved.receipts}; return {data:structuredClone(saved),error:null}; });
});
describe("publication binding",()=>{
  it("matches three own posts",()=>expect(matchTrialReceipts(card,posts(),base.created_at)).toHaveLength(3));
  it("matches X's HTML-escaped text against the plain saved post",()=>{
    const amp: TrialCard = { status: "pending", body: { step: { deliverable: { kind: "post", parts: ["Pick-up & drop-off, done for you", ...texts.slice(1)].map(content => ({ content })) } } } };
    const p=posts(); p[0]={...p[0],text:"Pick-up &amp; drop-off, done for you"};
    expect(matchTrialReceipts(amp,p,base.created_at)).toHaveLength(3);
  });
  it.each(["reply","repost","old","duplicate","missing"])("refuses %s",mode=>{
    const p=posts(); if(mode==="reply")p[0].is_reply=true; if(mode==="repost")p[0].is_repost=true; if(mode==="old")p[0].created_at="2026-10-01T00:00:00Z"; if(mode==="duplicate")p.push({...p[0],id:"999"}); if(mode==="missing")p.pop();
    expect(matchTrialReceipts(card,p,base.created_at)).toEqual([]);
  });
  it("uses saved variant edits",()=>{
    const c={...card,edited_body:{variants:{"0":{text:"Changed question?"}}}};
    expect(matchTrialReceipts(c,posts(),base.created_at)).toEqual([]);
    const p=posts();p[0].text="Changed question?";expect(matchTrialReceipts(c,p,base.created_at)).toHaveLength(3);
  });
});
describe("suggested budget",()=>{
  it("uses saved pace and 2x exposure",()=>{expect(trialBudget(300,300,14)).toEqual({daily:10,total:140,days:14});expect(trialBudget(300,28,14)).toEqual({daily:1,total:14,days:14});});
  it.each([[0,30,14],[300,0,14],[300,20,14],[NaN,300,14]])("does not invent %s/%s/%s",(a,b,c)=>expect(trialBudget(a,b,c)).toBeNull());
});
describe("delayed promotion",()=>{
  it("no budget or ad inputs before publication",async()=>{m.posts.mockResolvedValue({items:[],fetched_at:new Date(now).toISOString(),partial_errors:[]});await processXOrganicTrial(base,now);expect(saved.phase).toBe("awaiting_posts");expect(m.budget).not.toHaveBeenCalled();expect(m.file).not.toHaveBeenCalled();});
  it("waits 72 hours",async()=>{await processXOrganicTrial(base,Date.parse("2026-11-03T00:00:00Z"));expect(saved.phase).toBe("observing");expect(m.budget).not.toHaveBeenCalled();expect(m.file).not.toHaveBeenCalled();});
  it("zero replies produce no ad",async()=>{const p=posts();p.forEach(x=>{x.public_metrics!.reply_count=0;});m.posts.mockResolvedValue({items:p,fetched_at:new Date(now).toISOString(),partial_errors:[]});await processXOrganicTrial(base,now);expect(saved.phase).toBe("no_replies");expect(m.file).not.toHaveBeenCalled();expect(m.budget).not.toHaveBeenCalled();});
  it("unknown replies are not zero",async()=>{const p=posts();p[0].public_metrics=null;m.posts.mockResolvedValue({items:p,fetched_at:new Date(now).toISOString(),partial_errors:[]});await processXOrganicTrial(base,now);expect(saved.phase).toBe("waiting_metrics");expect(m.file).not.toHaveBeenCalled();});
  it("asks missing budget only after winner",async()=>{m.budget.mockResolvedValue(null);await processXOrganicTrial(base,now);expect(saved.phase).toBe("waiting_budget");expect(m.accounts).not.toHaveBeenCalled();expect(m.file).not.toHaveBeenCalled();});
  it("files paused human-only winning proposal",async()=>{await processXOrganicTrial(base,now);expect(m.file).toHaveBeenCalledOnce();const input=m.file.mock.calls[0][0];expect(input).toMatchObject({tenantId:base.tenant_id,runId:base.run_id,execPayload:{origin:"x_organic_trial",tweet_ids:["102"],daily_budget:10,total_budget:140,launch:"PAUSED"}});expect(isPersonOnlyOrigin(input.execPayload.origin)).toBe(true);expect(saved.phase).toBe("proposed");});
  it("uses authoritative competing proposal",async()=>{const p={origin:"x_organic_trial",tweet_ids:["101"],daily_budget:5};m.rpc.mockImplementation(async(_t,_r,a)=>({data:{...base,phase:a.p_phase,proposal:p},error:null}));await processXOrganicTrial(base,now);expect(m.file.mock.calls[0][0].execPayload).toEqual(p);});
  it("replays saved proposal without new metrics",async()=>{await processXOrganicTrial(base,now);const p=structuredClone(saved.proposal);m.file.mockClear();m.posts.mockClear();await processXOrganicTrial({...base,proposal:p},now);expect(m.file.mock.calls[0][0].execPayload).toEqual(p);expect(m.posts).not.toHaveBeenCalled();});
  it("shows an account-review step when the winning post is missing from the ad account", async () => {
    m.own.mockResolvedValue(new Map());
    await processXOrganicTrial(base, now);
    expect(saved.phase).toBe("waiting_connection");
    expect(m.own).toHaveBeenCalledWith({}, "account1", ["102"]);
    expect(m.rpc.mock.calls.at(-1)?.[2]).toMatchObject({
      p_phase: "waiting_connection",
      p_note: expect.stringContaining("https://x.com/i/web/status/102"),
    });
    expect(m.rpc.mock.calls.at(-1)?.[2].p_note).toMatch(/check.*connected X Ads account/i);
    expect(m.funding).not.toHaveBeenCalled();
    expect(m.file).not.toHaveBeenCalled();
  });
  it("retries a failed promotable-post read without asking the founder to change accounts", async () => {
    m.own.mockRejectedValueOnce(new Error("X read unavailable"));
    await expect(processXOrganicTrial(base, now)).rejects.toThrow("X read unavailable");
    expect(m.rpc.mock.calls.some(call => call[2].p_phase === "waiting_connection")).toBe(false);
    expect(m.file).not.toHaveBeenCalled();
  });
  it("can propose the same winner after account availability is corrected", async () => {
    m.own.mockResolvedValueOnce(new Map());
    await processXOrganicTrial(base, now);
    const waiting = structuredClone(saved);
    m.posts.mockResolvedValue({items:posts(),fetched_at:new Date(now+86400000).toISOString(),partial_errors:[]});
    await processXOrganicTrial(waiting, now+86400000);
    expect(saved.phase).toBe("proposed");
    expect(m.file).toHaveBeenCalledOnce();
    expect(m.file.mock.calls[0][0].execPayload).toMatchObject({tweet_ids:["102"],launch:"PAUSED"});
  });
  it.each(["disabled","locked","plan","closed"])("respects %s",async mode=>{if(mode==="disabled")m.disabled.mockResolvedValue(true);if(mode==="locked")m.locked.mockResolvedValue(true);if(mode==="plan")m.plan.mockResolvedValue({body:{}});if(mode==="closed")m.card.mockResolvedValue({data:{...card,status:"rejected"}});await processXOrganicTrial(base,now);expect(m.posts).not.toHaveBeenCalled();expect(m.file).not.toHaveBeenCalled();});
  it("does not reuse old receipts after edit",async()=>{m.card.mockResolvedValue({data:{...card,edited_body:{variants:{"0":{text:"Changed?"}}}}});await processXOrganicTrial({...base,receipts:posts().map(p=>({id:p.id,publishedAt:p.created_at}))},now);expect(saved.phase).toBe("awaiting_posts");expect(m.file).not.toHaveBeenCalled();});
});


it("recovers a human-edited existing card instead of filing the original again",async()=>{
  m.existing.mockResolvedValue({data:{id:"existing-reviewed-card"},error:null});
  await processXOrganicTrial({...base,proposal:{origin:"x_organic_trial"}},now);
  expect(m.file).not.toHaveBeenCalled();expect(saved.phase).toBe("proposed");
  expect(m.rpc.mock.calls.at(-1)?.[2].p_result_action_id).toBe("existing-reviewed-card");
});
it("recovers a lost insert response under the stable trial key",async()=>{
  m.existing.mockResolvedValueOnce({data:null,error:null}).mockResolvedValueOnce({data:null,error:null}).mockResolvedValueOnce({data:{id:"saved-card"},error:null});
  m.file.mockRejectedValueOnce(new Error("response lost"));
  await processXOrganicTrial({...base,proposal:{origin:"x_organic_trial"}},now);
  expect(saved.phase).toBe("proposed");expect(m.file).toHaveBeenCalledOnce();
});
it("unreadable budget waits without asking founder to set one",async()=>{
  m.budget.mockResolvedValue({unreadable:true});await processXOrganicTrial(base,now);expect(saved.phase).toBe("waiting_metrics");expect(m.file).not.toHaveBeenCalled();
});

it("recovers an existing card after the observation lifetime without creating a new one",async()=>{
  m.existing.mockResolvedValue({data:{id:"old-card"},error:null});
  await processXOrganicTrial({...base,proposal:{origin:"x_organic_trial"}},Date.parse("2026-12-05T00:00:00Z"));
  expect(saved.phase).toBe("proposed");expect(m.file).not.toHaveBeenCalled();
});
it("expires an uncompleted observation and stops provider reads",async()=>{
  await processXOrganicTrial(base,Date.parse("2026-12-05T00:00:00Z"));
  expect(saved.phase).toBe("expired");expect(m.posts).not.toHaveBeenCalled();
});

it("does not confuse literal entity text with a different published post",()=>{
  const c: TrialCard={...card,body:{step:{deliverable:{kind:"post",parts:["Use &amp; in your example",...texts.slice(1)].map(content=>({content}))}}}};
  const p=posts();p[0].text="Use &amp; in your example";
  expect(matchTrialReceipts(c,p,base.created_at)).toEqual([]);
  p[0].text="Use &amp;amp; in your example";
  expect(matchTrialReceipts(c,p,base.created_at)).toHaveLength(3);
});
