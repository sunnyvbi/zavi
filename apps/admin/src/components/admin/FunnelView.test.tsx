import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/api-admin",()=>({adminApiFetch:vi.fn()}));
import { FunnelView, type FunnelData } from "./FunnelView";
const data: FunnelData={windowDays:30,since:"2026-10-05T00:00:00Z",until:"2026-11-04T00:00:00Z",includeInternal:false,excluded:2,
 totals:{signed_up:4,ran:1,gave_feedback:0},rows:[],sources:[{source:"Unknown",kind:"unknown",signups:2},{source:"filter-coffee",kind:"from",signups:1},{source:"Direct",kind:"direct",signups:1}]};
it("renders source counts with an explicit unknown row and cohort definition",()=>{
 const html=renderToStaticMarkup(<FunnelView initialData={data}/>);
 expect(html).toContain("Signups by source"); expect(html).toContain("filter-coffee");expect(html).toContain("Unknown");expect(html).toContain("Source not captured");
 expect(html).toContain("2 test, internal or unclaimed video workspaces excluded");expect(html).toContain("Include test and internal workspaces");expect(html).toContain("Last 30 days");
});
it("escapes untrusted source labels as text",()=>{
 const html=renderToStaticMarkup(<FunnelView initialData={{...data,sources:[{source:'<img src=x onerror=alert(1)>',kind:'utm_source',signups:4}]}}/>);
 expect(html).not.toContain('<img src=x');expect(html).toContain('&lt;img');
});
it("shows the recorded affiliate on totals and its individual workspace row",()=>{
 const source={source:"Maya",kind:"affiliate",creator_id:"creator-1"};
 const html=renderToStaticMarkup(<FunnelView initialData={{...data,sources:[{...source,signups:1}],rows:[{tenant_id:"tenant-1",signed_up_at:data.since,first_run_at:null,first_feedback_at:null,source}]}}/>);
 expect(html.match(/Maya \(affiliate\)/g)).toHaveLength(2);
 expect(html).toContain('/creator-network/creators/creator-1');
 expect(html).toContain('Recorded creator referral');
 expect(html).toContain('/tenants/tenant-1');
});
it("distinguishes same-named creators and leaves missing creator IDs as plain text",()=>{
 const html=renderToStaticMarkup(<FunnelView initialData={{...data,sources:[
  {source:"Maya",kind:"affiliate",creator_id:"11111111-aaaa",signups:1},
  {source:"Maya",kind:"affiliate",creator_id:"22222222-bbbb",signups:1},
  {source:"Creator",kind:"affiliate",signups:1},
 ]}}/>);
 expect(html).toContain('· 11111111');expect(html).toContain('· 22222222');
 expect(html).not.toContain('/creator-network/creators/undefined');
});
