import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const m = vi.hoisted(() => ({ auth:vi.fn(), role:vi.fn(), eligibility:vi.fn(), read:vi.fn(), pay:vi.fn(), fund:vi.fn(), cards:vi.fn() }));
vi.mock("@/services/auth/middleware",()=>({requireAuth:m.auth}));
vi.mock("@/services/auth/tenant-role",()=>({requireTenantRole:m.role}));
vi.mock("@/services/ads-wallet/providers",()=>({refillEligibility:m.eligibility}));
vi.mock("@/services/ads-wallet/wallet",()=>({readWallet:m.read,payWithCard:m.pay,startFunding:m.fund,listCards:m.cards,REFILL_PAUSED_MESSAGE:"refill paused notice",REFILL_PLAN_MESSAGE:"refill plan notice"}));
vi.mock("@/services/logging/logEvent",()=>({logEvent:vi.fn()}));
import * as shared from "../wallet";
import * as legacy from "../../channels/chatgpt-ads-wallet";
import { walletError } from "../wallet-auth";
import { ExpectedToolError } from "@/services/tools/types";
const response = () => {const r={status:vi.fn(),json:vi.fn()};r.status.mockReturnValue(r);return r as unknown as Response;};
const req = {body:{request_id:"10000000-0000-4000-8000-000000000001",amount_cents:10000,payment_method_id:"pm_saved"}} as Request;
it("preserves the confirmed no-write launch refusal for client retries", () => {
  const res = response();
  walletError(res, new ExpectedToolError("ads_launch_not_sent", "Set a monthly ad budget."));
  expect(res.status).toHaveBeenCalledWith(409);
  expect(res.json).toHaveBeenCalledWith({ error: { code: "ads_launch_not_sent", message: "Set a monthly ad budget." } });
});
beforeEach(()=>{vi.resetAllMocks();m.auth.mockResolvedValue({tenant_id:"verified-tenant",user_id:"user"});m.role.mockResolvedValue(true);m.eligibility.mockResolvedValue("allowed");m.read.mockResolvedValue({balance_cents:10000,reserved_cents:6000,available_cents:4000,funding_enabled:true});m.pay.mockResolvedValue({order_id:req.body.request_id,status:"pending"});});
it("preserves every legacy route as the exact shared handler",()=>{
 for(const name of ["Wallet","Fund","DisableRefill","Cards","CardSetup","CardSetupComplete","CardSelect","CardPay","OrderStatus"] as const)
  expect(legacy[`chatgpt${name}`]).toBe(shared[`ads${name}`]);
});
it("reads the common balance using authenticated tenant identity",async()=>{
 const res=response();await shared.adsWallet(req,res);
 expect(m.read).toHaveBeenCalledWith("verified-tenant");
 expect(res.json).toHaveBeenCalledWith({balance_cents:10000,reserved_cents:6000,available_cents:4000,funding_enabled:true});
});
it("keeps balance readable while entitlement is unknown, without allowing new funding",async()=>{
 m.eligibility.mockResolvedValue("unknown");const res=response();await shared.adsWallet(req,res);
 expect(res.json).toHaveBeenCalledWith(expect.objectContaining({funding_enabled:false}));
 await shared.adsCardPay(req,res);expect(res.status).toHaveBeenCalledWith(403);expect(m.pay).not.toHaveBeenCalled();
});
it("tells the founder auto-refill is paused, not off, while a global lock or rollout flag holds it",async()=>{
 m.read.mockResolvedValue({balance_cents:100,auto_refill_enabled:true,last_error:null,funding_enabled:true});
 m.eligibility.mockResolvedValue("paused");let res=response();await shared.adsWallet(req,res);
 expect(res.json).toHaveBeenCalledWith(expect.objectContaining({auto_refill_enabled:true,last_error:"refill paused notice",funding_enabled:false}));
 m.read.mockResolvedValue({balance_cents:100,auto_refill_enabled:true,last_error:"refill paused notice",funding_enabled:true});
 m.eligibility.mockResolvedValue("allowed");res=response();await shared.adsWallet(req,res);
 expect(res.json).toHaveBeenCalledWith(expect.objectContaining({last_error:null,funding_enabled:true}));
});
it("requires authentication before any wallet read",async()=>{
 m.auth.mockResolvedValue(null);await shared.adsWallet(req,response());expect(m.read).not.toHaveBeenCalled();
});
it.each(["member","override"])("refuses %s charges",async mode=>{
 if(mode==="member")m.role.mockResolvedValue(false);else m.auth.mockResolvedValue({tenant_id:"other",tenant_overridden:true});
 await shared.adsCardPay(req,response());expect(m.pay).not.toHaveBeenCalled();
});
it("preserves the original payment request ID through the common API",async()=>{
 await shared.adsCardPay(req,response());expect(m.pay).toHaveBeenCalledWith("verified-tenant",10000,req.body.request_id,"pm_saved");
});
it("rejects caller-supplied tenant or account routing fields",async()=>{
 const res=response();await shared.adsCardPay({...req,body:{...req.body,tenant_id:"other",account_id:"other-account"}} as Request,res);
 expect(res.status).toHaveBeenCalledWith(400);expect(m.pay).not.toHaveBeenCalled();
});
const fundBody = {amount_cents:10000,mode:"topup",request_id:"10000000-0000-4000-8000-000000000002"};
it.each([[undefined,undefined],["chatgpt","chatgpt"],["linkedin","linkedin"]])("starts checkout for the %s channel's balance page",async(platform,expected)=>{
 m.fund.mockResolvedValue({url:"https://checkout.example"});const res=response();
 await shared.adsFund({body:platform?{...fundBody,platform}:fundBody} as Request,res);
 expect(m.fund).toHaveBeenCalledWith("verified-tenant","user",10000,"topup",fundBody.request_id,false,...(expected?[expected]:[]));
 expect(res.json).toHaveBeenCalledWith({url:"https://checkout.example"});
});
it("refuses checkout for a channel that has no Zavi-paid balance",async()=>{
 const res=response();await shared.adsFund({body:{...fundBody,platform:"meta"}} as Request,res);
 expect(res.status).toHaveBeenCalledWith(400);expect(m.fund).not.toHaveBeenCalled();
});
it("refuses a member's LinkedIn checkout before Stripe is reached",async()=>{
 m.role.mockResolvedValue(false);await shared.adsFund({body:{...fundBody,platform:"linkedin"}} as Request,response());
 expect(m.fund).not.toHaveBeenCalled();
});
it.each([[{platform:"linkedin"},"linkedin"],[{platform:"chatgpt"},"chatgpt"],[{},"chatgpt"],[{platform:"meta"},"chatgpt"],[{platform:["linkedin","x"]},"chatgpt"]])("lists saved cards with the consent wording for %j",async(query,expected)=>{
 m.cards.mockResolvedValue({cards:[]});const res=response();
 await shared.adsCards({query} as unknown as Request,res);
 expect(m.cards).toHaveBeenCalledWith("verified-tenant",expected);
 expect(res.json).toHaveBeenCalledWith({cards:[]});
});
