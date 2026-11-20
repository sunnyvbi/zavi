vi.mock("@/services/ads-wallet/chatgpt-account-preview",()=>({previewChatgptAccount:async()=>({key:"key"})}));
import { beforeEach, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({get:vi.fn(),client:vi.fn(),rows:[] as any[],error:null as unknown}));
vi.mock("../http",()=>({chatgptAdsGet:m.get}));
vi.mock("../key-provider",()=>({getChatgptAdsApiKey:async()=>"key"}));
vi.mock("@/services/tenant-client",()=>({asTenantId:(x:string)=>x,tenantClient:m.client}));
import {resourceOptions,requireOption} from "../resources";
beforeEach(()=>{vi.resetAllMocks();m.error=null;m.rows=[{resource_id:"event1",kind:"conversion_event",source_id:"source1"}];m.client.mockImplementation(()=>({from:()=>{const q:any={select:()=>q,eq:()=>q,then:(resolve:any)=>resolve({data:m.rows,error:m.error})};return q;}}));});
it("filters unbound account resources and rejects a rebound source",async()=>{
  m.get.mockResolvedValue({data:[{id:"foreign",name:"Other tenant",event_type:"lead_created",archived:false,source_ids:["source1"]},{id:"event1",name:"Our leads",event_type:"lead_created",archived:false,source_ids:["source1"]}]});
  const options=await resourceOptions("tenant1");
  expect(m.client).toHaveBeenCalledWith("tenant1");
  expect(options.conversion_events).toEqual([{id:"event1",name:"Our leads"}]);
  expect(JSON.stringify(options)).not.toContain("Other tenant");
  m.get.mockResolvedValue({data:[{id:"event1",name:"Our leads",event_type:"lead_created",archived:false,source_ids:["source2"]}]});
  expect((await resourceOptions("tenant1")).conversion_events).toEqual([]);
});
it("never offers custom or archived conversion goals",async()=>{
  for(const extra of [{event_type:"custom",archived:false},{event_type:"lead_created",archived:true}]){
    m.get.mockResolvedValue({data:[{id:"event1",source_ids:["source1"],...extra}]});
    expect((await resourceOptions("tenant1")).conversion_events).toEqual([]);
  }
});
it("fails closed on missing storage and reports provider failures without leaking data",async()=>{
  m.error={message:"private database failure"};await expect(resourceOptions("tenant1")).rejects.toThrow("could not be checked");
  m.error=null;m.get.mockRejectedValue(new Error("Other tenant’s secret"));
  const r=await resourceOptions("tenant1");expect(r.conversion_events).toEqual([]);expect(r.warnings).toHaveLength(1);expect(JSON.stringify(r)).not.toContain("secret");
  expect(()=>requireOption(r.conversion_events,"event1")).toThrow("not verified");
});
it("uses provider inclusion eligibility rather than assuming every ready audience is usable",async()=>{
  m.rows=[{resource_id:"aud1",kind:"audience",source_id:null}];
  m.get.mockImplementation(async(_k,_p,q)=>({data:q.intended_use==="exclusion"?[{id:"aud1",name:"Small audience",status:"ready"}]:[]}));
  const r=await resourceOptions("tenant1");expect(r.inclusion_audiences).toEqual([]);expect(r.exclusion_audiences).toHaveLength(1);
});
