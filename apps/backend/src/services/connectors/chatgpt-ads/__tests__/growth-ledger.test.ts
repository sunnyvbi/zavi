import { describe, expect, it, vi } from "vitest";
vi.mock("@/services/tenant-client", () => ({ asTenantId: (s:string)=>s, tenantClient: vi.fn() }));
import { accountDay, verifiedDailySpend } from "../growth-ledger";
const id="cmpn_test", zone="America/Los_Angeles";
const row={campaign_id:id,start_time:1790838000,end_time:1790924400,spend:12.34};
describe("ChatGPT ledger evidence",()=>{
 it("records exact account-day spend and marks today's row provisional",()=>{expect(verifiedDailySpend(id,[row],"2026-10-01","2026-10-01",zone)).toEqual([{object_id:id,spend_date:"2026-10-01",amount_usd:12.34,provisional:true}]);});
 it("does not silently count a missing day as zero",()=>{expect(()=>verifiedDailySpend(id,[row],"2026-10-01","2026-10-02",zone)).toThrow("Missing");});
 it.each([{...row,campaign_id:"cmpn_other"},{...row,spend:undefined},{...row,spend:-1},{...row,start_time:undefined},{...row,end_time:row.end_time+1},{...row,timezone:"UTC"}])("rejects foreign, incomplete or unverified rows",r=>{expect(()=>verifiedDailySpend(id,[r],"2026-10-01","2026-10-01",zone)).toThrow();});
 it("rejects duplicate days rather than doubling spend",()=>{expect(()=>verifiedDailySpend(id,[row,row],"2026-10-01","2026-10-01",zone)).toThrow();});
 it("accepts a real 25-hour DST day",()=>{const r={campaign_id:id,start_time:Date.parse("2026-11-01T07:00:00Z")/1000,end_time:Date.parse("2026-11-02T08:00:00Z")/1000,spend:0};expect(verifiedDailySpend(id,[r],"2026-11-01","2026-11-01",zone)[0].amount_usd).toBe(0);});
 it("maps the UTC month boundary into the provider's account day",()=>{expect(accountDay(new Date("2026-10-01T00:00:00Z"),zone)).toBe("2026-09-30");});
});
describe("ChatGPT ledger participation",()=>{
 it("a tenant that never funded a campaign is not read, even with a wallet and the seeded channel row",async()=>{
  const tc=await import("@/services/tenant-client");
  const q=(data:unknown):any=>{const b:any={select:()=>b,eq:()=>b,limit:()=>b,maybeSingle:async()=>({data,error:null})};return b;};
  vi.mocked(tc.tenantClient).mockReturnValue({from:(t:string)=>q(t==="ads_campaign_funding"?null:{tenant_id:"t",channel_slug:"chatgpt_ads"})} as never);
  const { readChatgptAccount }=await import("../growth-ledger");
  await expect(readChatgptAccount("t",new Date("2026-10-01T00:00:00Z"))).resolves.toBeNull();
 });
});
