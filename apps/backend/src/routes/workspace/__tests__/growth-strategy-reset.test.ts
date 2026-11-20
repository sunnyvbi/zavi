import {beforeEach,describe,it,expect,vi} from "vitest";
import type {Request,Response} from "express";
const h=vi.hoisted(()=>({rpc:vi.fn(),release:vi.fn(async()=>true)}));
vi.mock("@/services/auth/middleware",()=>({requireAuth:async()=>({tenant_id:"tenant-1",user_id:"u1",access_token:"tok"})}));
vi.mock("@/services/tenant-client",()=>({asTenantId:(s:string)=>s,tenantRpc:h.rpc}));
vi.mock("../growth-strategy-draft",()=>({releaseTodaysDraftSlot:h.release}));
import {postGrowthStrategyReset} from "../growth-interview";
function response(){const out={statusCode:200,body:null as any};const res={status(n:number){out.statusCode=n;return this},json(b:unknown){out.body=b;return this}} as Response;return {out,res}}
beforeEach(()=>{h.rpc.mockReset();h.release.mockClear();h.rpc.mockResolvedValue({data:{ok:true,plan_retired:1},error:null})});
describe("atomic strategy reset",()=>{
 it("reports the transaction receipt and frees the old daily slot",async()=>{
  const {out,res}=response();await postGrowthStrategyReset({body:{tenant_id:"foreign"}} as Request,res);
  expect(h.rpc).toHaveBeenCalledWith("tenant-1","reset_growth_strategy_delivery",{});
  expect(out.body).toMatchObject({ok:true,plan_retired:1,draft_slot_freed:true});
 });
 it.each([{data:null,error:{message:"private database detail"}},{data:null,error:null},{data:{ok:false},error:null}])("fails closed without retiring a separate plan on bad receipt %j",async(answer)=>{
  h.rpc.mockResolvedValue(answer);const {out,res}=response();await postGrowthStrategyReset({} as Request,res);
  expect(out.statusCode).toBe(500);expect(h.release).not.toHaveBeenCalled();expect(JSON.stringify(out.body)).not.toContain("private database detail");
 });
});
