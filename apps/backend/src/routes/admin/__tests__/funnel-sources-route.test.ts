import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const h = vi.hoisted(() => ({ auth: vi.fn(), from: vi.fn(), calls: [] as Array<{table: string; op: string; args: unknown[]}>, data: {} as Record<string, unknown[]>, failed: "" }));
vi.mock("@/services/auth/staff-middleware", () => ({assertStaff: h.auth}));
vi.mock("@/services/tenant-client", () => ({staffCrossTenantClient: () => ({from: h.from})}));
vi.mock("@/services/tenants/new-tenant-alert", () => ({DOGFOOD_SLUGS: new Set(["upcar-ai", "upcar-private", "apna-tutor-dogfood"])}));
import { staffFunnel } from "../funnel";
const response = () => { const res = {status: vi.fn(), json: vi.fn()}; res.status.mockReturnValue(res); return res; };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
  vi.clearAllMocks(); h.calls = []; h.failed = "";
  h.data = { tenants: [
    {id: "real", kind: "real", slug: "customer", created_at: "2026-11-01T00:00:00Z"},
    {id: "test", kind: "test", slug: "qa", created_at: "2026-11-01T00:00:00Z"},
    {id: "internal", kind: "real", slug: "upcar-ai", created_at: "2026-11-01T00:00:00Z"},
    {id: "shell", kind: "launch_video_shell", slug: "lv-shell", created_at: "2026-11-01T00:00:00Z"},
  ], tenant_app_setting: [{tenant_id: "real", value: {from: "filter-coffee"}}], agent_runs: [], agent_feedback: [] };
  h.from.mockImplementation((table: string) => {
    const filters: Array<(row: Record<string, any>) => boolean> = [];
    const chain: Record<string, (...args: any[]) => any> = {};
    for (const op of ["select", "gte", "lt", "order", "eq", "not", "in"]) chain[op] = (...args: unknown[]) => {
      h.calls.push({table, op, args});
      const column = args[0] as string;
      if(op === "in") filters.push(row => (args[1] as string[]).includes(row[column]));
      if(op === "gte") filters.push(row => row[column] >= (args[1] as string));
      if(op === "lt") filters.push(row => row[column] < (args[1] as string));
      return chain;
    };
    chain.range = async (from: number, to: number) => {
      h.calls.push({table, op: "range", args: [from,to]});
      let rows = h.data[table] ?? [];
      rows = rows.filter(r => filters.every(filter => filter(r as Record<string, any>)));
      return {data: rows.slice(from, to + 1), error: h.failed === table ? {message: "unavailable"} : null};
    };
    return chain;
  });
});
afterEach(() => { vi.useRealTimers(); });
it("keeps the staff gate and reads only the selected cohort's attribution", async () => {
  const res = response(); await staffFunnel({query: {}} as Request, res as unknown as Response);
  expect(h.auth).toHaveBeenCalledOnce();
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({windowDays: 30, excluded: 3, includeInternal: false,
    totals: {signed_up: 1, ran: 0, gave_feedback: 0}, sources: [{source: "filter-coffee", kind: "from", signups: 1}]}));
  expect(h.calls).toContainEqual({table: "tenant_app_setting", op: "eq", args: ["key", "signup_attribution"]});
  for(const table of ["tenant_app_setting", "agent_runs", "agent_feedback"]) expect(h.calls).toContainEqual({table, op: "in", args: ["tenant_id", ["real"]]});
  expect(h.calls.some(c => c.table === "tenants" && c.op === "gte" && c.args[0] === "created_at")).toBe(true);
  expect(h.calls.some(c => c.table === "agent_runs" && c.op === "gte" && c.args[0] === "enqueued_at")).toBe(true);
});
it("allows staff to include test signups for launch-link verification", async () => {
  const res=response(); await staffFunnel({query:{include_internal:"1", days:"7"}} as unknown as Request,res as unknown as Response);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({windowDays:7, excluded:1, totals:{signed_up:3, ran:0, gave_feedback:0}}));
});
it("does not turn a failed attribution read into an Unknown count", async () => {
  h.failed="tenant_app_setting"; const res=response(); await staffFunnel({query:{}} as Request,res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json).toHaveBeenCalledWith({error:{code:"funnel_read_failed",message:"unavailable"}});
});
it("pages beyond the database's response cap instead of silently undercounting", async () => {
  h.data.tenants=Array.from({length:501},(_,i)=>({id:`t${i}`,created_at:"2026-11-01T00:00:00Z",kind:"real"}));
  const res=response(); await staffFunnel({query:{}} as Request,res as unknown as Response);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({totals:{signed_up:501,ran:0,gave_feedback:0},sources:[{source:"Unknown",kind:"unknown",signups:501}]}));
  expect(h.calls).toContainEqual({table:"tenants",op:"range",args:[500,999]});
});
it("does not read across workspaces if the staff check refuses", async () => {
  h.auth.mockImplementationOnce(()=>{throw Error("forbidden")});
  await expect(staffFunnel({query:{}} as Request,response() as unknown as Response)).rejects.toThrow("forbidden");
  expect(h.from).not.toHaveBeenCalled();
});

it("counts an old shell claimed in the window on its claim date and keeps exclusions", async () => {
  h.data.tenants = [
    {id: "old", kind: "real", slug: "old-video", created_at: "2026-09-01T00:00:00Z"},
    {id: "recent", kind: "real", slug: "recent-video", created_at: "2026-11-01T00:00:00Z"},
    {id: "test", kind: "test", slug: "qa", created_at: "2026-09-01T00:00:00Z"},
    {id: "unclaimed", kind: "launch_video_shell", slug: "pending", created_at: "2026-11-01T00:00:00Z"},
  ];
  const claimed_at = "2026-11-03T00:00:00Z";
  h.data.launch_video_public_jobs = [
    {tenant_id: "old", claimed_at}, {tenant_id: "recent", claimed_at}, {tenant_id: "test", claimed_at},
  ];
  h.data.tenant_app_setting = [{tenant_id: "old", value: {from: "filter-coffee"}}];
  const res = response(); await staffFunnel({query:{days:"7"}} as unknown as Request,res as unknown as Response);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({excluded: 2, totals:{signed_up:2,ran:0,gave_feedback:0},
    rows: expect.arrayContaining([
      {tenant_id:"old",source:{source:"filter-coffee",kind:"from"},signed_up_at:claimed_at,first_run_at:null,first_feedback_at:null},
      {tenant_id:"recent",source:{source:"Unknown",kind:"unknown"},signed_up_at:claimed_at,first_run_at:null,first_feedback_at:null},
    ]), sources: expect.arrayContaining([{source:"filter-coffee",kind:"from",signups:1}]),
  }));
  expect(h.calls).toContainEqual({table:"launch_video_public_jobs",op:"select",args:["tenant_id, claimed_at"]});
});
it("does not include claims outside the selected signup window", async () => {
  h.data.tenants = [{id:"old",kind:"real",slug:"old",created_at:"2026-09-01T00:00:00Z"}];
  h.data.launch_video_public_jobs = [{tenant_id:"old",claimed_at:"2026-10-01T00:00:00Z"}];
  const res=response(); await staffFunnel({query:{days:"7"}} as unknown as Request,res as unknown as Response);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({totals:{signed_up:0,ran:0,gave_feedback:0},rows:[],sources:[]}));
});
it("surfaces a claim-date read failure rather than silently omitting signups", async () => {
  h.failed="launch_video_public_jobs"; const res=response();
  await staffFunnel({query:{}} as Request,res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(500);
});

it("shows a verified creator referral as the signup source, on its workspace row too", async () => {
  h.data.affiliate_referrals = [{tenant_id:"real", member_id:"creator-1"}, {tenant_id:"test", member_id:"creator-test"}];
  h.data.human_members = [{id:"creator-1", display_name:"Maya"}, {id:"creator-test", display_name:"Test creator"}];
  const res=response(); await staffFunnel({query:{}} as Request,res as unknown as Response);
  const body=res.json.mock.calls[0][0];
  expect(body.sources).toEqual([{source:"Maya", kind:"affiliate", creator_id:"creator-1", signups:1}]);
  expect(body.rows[0].source).toEqual({source:"Maya", kind:"affiliate", creator_id:"creator-1"});
  expect(h.calls).toContainEqual({table:"affiliate_referrals",op:"in",args:["tenant_id",["real"]]});
  expect(h.calls).toContainEqual({table:"human_members",op:"in",args:["id",["creator-1"]]});
});
it("does not hide a failed affiliate attribution read behind a different source", async () => {
  h.failed="affiliate_referrals"; const res=response(); await staffFunnel({query:{}} as Request,res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(500);
});
it("surfaces a creator-name read failure rather than hiding the referral", async () => {
  h.data.affiliate_referrals = [{tenant_id:"real", member_id:"creator-1"}];
  h.failed="human_members"; const res=response(); await staffFunnel({query:{}} as Request,res as unknown as Response);
  expect(res.status).toHaveBeenCalledWith(500);
});
it("includes test-workspace referrals only when staff explicitly include internal signups", async () => {
  h.data.affiliate_referrals = [{tenant_id:"test", member_id:"creator-test"}];
  h.data.human_members = [{id:"creator-test", display_name:null}];
  const res=response(); await staffFunnel({query:{include_internal:"1"}} as unknown as Request,res as unknown as Response);
  const body=res.json.mock.calls[0][0];
  expect(body.rows.find((r:{tenant_id:string}) => r.tenant_id === "test").source)
    .toEqual({source:"Creator",kind:"affiliate",creator_id:"creator-test"});
  expect(body.sources).toContainEqual({source:"Creator",kind:"affiliate",creator_id:"creator-test",signups:1});
});
it("keeps different creators with identical names separate and retains unnamed referrals", async () => {
  h.data.tenants=["a","b","c"].map(id=>({id,kind:"real",created_at:"2026-11-01T00:00:00Z"}));
  h.data.affiliate_referrals=["a","b","c"].map(tenant_id=>({tenant_id,member_id:`creator-${tenant_id}`}));
  h.data.human_members=[{id:"creator-a",display_name:"Maya"},{id:"creator-b",display_name:"Maya"}];
  const res=response(); await staffFunnel({query:{}} as Request,res as unknown as Response);
  const body=res.json.mock.calls[0][0];
  expect(body.sources).toHaveLength(3);
  expect(body.sources).toContainEqual({source:"Creator",kind:"affiliate",creator_id:"creator-c",signups:1});
  expect(body.sources.reduce((n:number,r:{signups:number})=>n+r.signups,0)).toBe(3);
});
