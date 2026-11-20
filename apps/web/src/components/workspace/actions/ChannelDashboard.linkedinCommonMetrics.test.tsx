// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
const h = vi.hoisted(() => ({ data: null as unknown, loading:false, error:null as string|null }));
vi.mock("@/lib/api", async orig => ({...(await orig<typeof import("@/lib/api")>()),apiFetch:vi.fn()}));
vi.mock("../WorkspaceShell", () => ({useWorkspaceOptional:()=>({role:"owner"})}));
vi.mock("../agent/dashboard-ui", async orig => ({...(await orig<typeof import("../agent/dashboard-ui")>()),useAgentDashboard:()=>({data:h.data,cachedAt:null,loading:h.loading,refreshing:false,error:h.error,refresh:()=>{},refreshSilent:()=>{}})}));
import { ChannelMetricsRow } from "./ChannelMetricsRow";
import { linkedin_organic } from "./platforms/linkedin_organic";
const keys = ["followers","total_posts","engagement_rate","reactions","comments","reposts","days_since_last_post"];
const metric = (key: string, value: number): ChannelMetric => ({key,value,unit:key==="engagement_rate"?"pct":null,window_kind:null,day:"2026-11-18",grounded:true,prev_value:null,prev_day:null});
const payload = (metrics: ChannelMetric[], page: string|null="https://www.linkedin.com/company/example/") => ({page_url:page,metrics,top_posts:[],drafts:[],drafts_ok:true,publishing_connected:false,refresh:{used:0,remaining:3,cap:3}});
const view = (metrics: ChannelMetric[]=[]) => <ChannelMetricsRow slug="linkedin_organic" metrics={metrics} platform={linkedin_organic} loading={false} connected hasConnectors />;
const displayed = () => screen.getAllByTestId(/^kpi-/).map(x=>x.getAttribute("data-metric"));
afterEach(cleanup);
beforeEach(()=>{h.loading=false;h.error=null;h.data=payload([metric("followers",1200)]);});
it("keeps the same seven cards for a follower-only tenant and a fully measured tenant", () => {
 const page=render(view());expect(displayed()).toEqual(keys);
 expect(screen.getByTestId("value-followers").textContent).toBe("1,200");
 expect(screen.getByTestId("value-reactions").textContent).toBe("–");
 expect(screen.getByTestId("kpi-reactions").textContent).toContain("Reaction counts unavailable");
 h.data=payload(keys.map((k,i)=>metric(k,i+1)));page.rerender(view());
 expect(displayed()).toEqual(keys);expect(screen.getByTestId("value-reactions").textContent).toBe("4");
});
it("preserves measured zeros while explaining unknown values", () => {
 h.data=payload([metric("followers",1200),metric("comments",0),metric("reposts",NaN)]);
 render(view());expect(displayed()).toEqual(keys);
 expect(screen.getByTestId("value-comments").textContent).toBe("0");
 expect(screen.getByTestId("value-reposts").textContent).toBe("–");
});
it("uses the same public snapshot source instead of mixing an agent's differently scoped numbers", () => {
 render(view([metric("followers",9999),metric("impressions",1234)]));
 expect(displayed()).toEqual(keys);expect(screen.getByTestId("value-followers").textContent).toBe("1,200");
 expect(screen.queryByTestId("kpi-impressions")).toBeNull();
});
it("clears prior numbers when a tenant's payload has no measurements", () => {
 h.data=payload(keys.map(k=>metric(k,10)));const page=render(view());
 h.data=payload([]);page.rerender(view());expect(displayed()).toEqual(keys);
 for(const k of keys) expect(screen.getByTestId(`value-${k}`).textContent).toBe("–");
});
it("shows all cards with a settings instruction when no reference page is saved", () => {
 h.data=payload([],null);render(view());expect(displayed()).toEqual(keys);
 expect(screen.getByTestId("kpi-followers").textContent).toContain("Add your LinkedIn page in Settings");
});
it("shows an unavailable reason when the dashboard payload cannot be read", () => {
 h.data={generic:true};render(view());expect(displayed()).toEqual(keys);
 expect(screen.getByTestId("kpi-followers").textContent).toContain("LinkedIn data is unavailable");
});

it("keeps the initial loading skeleton instead of showing missing-data cards", () => {
 h.data=null;h.loading=true;render(view());
 expect(screen.getByTestId("channel-numbers-loading")).toBeTruthy();
 expect(screen.queryAllByTestId(/^kpi-/)).toHaveLength(0);
});
it("hides old metric values while the dashboard is loading a different window", () => {
 h.loading=true;render(view());expect(screen.queryAllByTestId(/^kpi-/)).toHaveLength(0);
});
it("keeps the common layout after a failed read without claiming measured zeroes", () => {
 h.data=null;h.error="Read failed";render(view());expect(displayed()).toEqual(keys);
 for(const k of keys) expect(screen.getByTestId(`value-${k}`).textContent).toBe("–");
});
