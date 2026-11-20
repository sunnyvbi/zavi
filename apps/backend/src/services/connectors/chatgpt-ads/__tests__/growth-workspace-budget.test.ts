import { beforeEach, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({read:vi.fn(),reserve:vi.fn(),commit:vi.fn(),drop:vi.fn(),release:vi.fn(),rebase:vi.fn(),record:vi.fn(),error:vi.fn()}));
vi.mock("@/services/decisions/ad-budget",()=>({readActiveAdBudget:m.read,reserveAdSpend:m.reserve,commitAdSpend:m.commit,dropAdSpendHold:m.drop,releaseAdSpendForObject:m.release,rebaseAdSpendForObject:m.rebase,settleAdSpendAfterError:m.error}));
vi.mock("@/services/decisions/ad-changes",()=>({recordAdObjectChanges:m.record}));
import { withApprovedChatgptDispatch, withWorkspaceGrowthBudget } from "../growth-workspace-budget";
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantRpc: async () => ({ data: true, error: null }) }));
import { noteChatgptWriteAttempt } from "../write-tracking";
import { ExpectedToolError } from "@/services/tools/types";
const paused={id:"cmpn_test",status:"paused",updated_at:1,budget:{daily_spend_limit_micros:25e6}};
const active={...paused,status:"active"};
beforeEach(()=>{vi.resetAllMocks();m.read.mockResolvedValue({id:"budget",days_left:20});m.reserve.mockResolvedValue({status:"held",fresh:true});});
it("holds the full UI activation against Growth before writing",async()=>{const write=vi.fn().mockResolvedValue("done");await expect(withWorkspaceGrowthBudget("t",paused,active,"campaign",write)).resolves.toBe("done");expect(m.reserve).toHaveBeenCalledWith(expect.objectContaining({tenant_id:"t",exec_source:"workspace"}),{platform:"chatgpt",op:"resume",object_id:"cmpn_test",daily_delta_usd:25});expect(m.reserve.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);});
it("a Growth refusal prevents the UI provider call",async()=>{m.reserve.mockResolvedValue({status:"refused",error:"cap exceeded"});const write=vi.fn();await expect(withWorkspaceGrowthBudget("t",paused,active,"campaign",write)).rejects.toThrow("cap exceeded");expect(write).not.toHaveBeenCalled();});
it("a budget stopped during reservation prevents the UI provider call",async()=>{m.reserve.mockResolvedValue({status:"no_budget"});const write=vi.fn();await expect(withWorkspaceGrowthBudget("t",paused,active,"campaign",write)).rejects.toThrow("Growth budget changed");expect(write).not.toHaveBeenCalled();});
it("allows protective pauses and records founder intent even when budget reads are broken",async()=>{m.read.mockRejectedValue(new Error("offline"));const write=vi.fn();await withWorkspaceGrowthBudget("t",active,paused,"campaign",write);expect(write).toHaveBeenCalled();expect(m.read).not.toHaveBeenCalled();expect(m.release).toHaveBeenCalled();expect(m.record.mock.calls[0][1][0]).toMatchObject({source:"outside",change_kind:"status",after_status:"PAUSED"});});
it("a child pause never frees the campaign's money",async()=>{await withWorkspaceGrowthBudget("t",active,paused,"ad",vi.fn());expect(m.release).not.toHaveBeenCalled();});
it("a cut cannot be blocked by an unavailable cap",async()=>{m.read.mockRejectedValue(new Error("offline"));await withWorkspaceGrowthBudget("t",{...active,budget:{daily_spend_limit_micros:50e6}},active,"campaign",vi.fn());expect(m.read).not.toHaveBeenCalled();expect(m.rebase).toHaveBeenCalled();});
it("preserves unknown writes but releases a known wallet preflight refusal",async()=>{await expect(withWorkspaceGrowthBudget("t",paused,active,"campaign",async()=>{throw new ExpectedToolError("ads_balance_insufficient","add funds");})).rejects.toThrow("add funds");expect(m.drop).toHaveBeenCalled();m.drop.mockClear();await expect(withWorkspaceGrowthBudget("t",paused,active,"campaign",async()=>{noteChatgptWriteAttempt();throw new Error("timeout");})).rejects.toThrow();expect(m.drop).not.toHaveBeenCalled();expect(m.error).toHaveBeenCalled();});
it("approved actions reuse their hold only within the same tenant context",async()=>{await withApprovedChatgptDispatch("t",()=>withWorkspaceGrowthBudget("t",paused,active,"campaign",vi.fn()));expect(m.reserve).not.toHaveBeenCalled();await withApprovedChatgptDispatch("other",()=>withWorkspaceGrowthBudget("t",paused,active,"campaign",vi.fn()));expect(m.reserve).toHaveBeenCalled();});
it("retains manual lifetime support with conservative full-cap coverage",async()=>{await withWorkspaceGrowthBudget("t",paused,{...active,budget:{lifetime_spend_limit_micros:100e6}},"campaign",vi.fn());expect(m.reserve.mock.calls[0][1].daily_delta_usd*2*20).toBeGreaterThanOrEqual(100);});
it("a UI daily raise on an active campaign holds the increase; a UI cut lowers the hold by the cut",async()=>{await withWorkspaceGrowthBudget("t",active,{...active,budget:{daily_spend_limit_micros:40e6}},"campaign",vi.fn());expect(m.reserve.mock.calls[0][1]).toEqual({platform:"chatgpt",op:"raise",object_id:"cmpn_test",daily_delta_usd:15});await withWorkspaceGrowthBudget("t",{...active,budget:{daily_spend_limit_micros:50e6}},active,"campaign",vi.fn());expect(m.rebase.mock.calls[0].slice(3)).toEqual([25,expect.stringMatching(/:rebase$/),25]);});

it.each(["setup pending", "version conflict", "resource unavailable"])("releases a fresh UI hold on preflight failure: %s", async reason => {
  await expect(withWorkspaceGrowthBudget("t", paused, active, "campaign", async () => { throw new Error(reason); })).rejects.toThrow(reason);
  expect(m.drop).toHaveBeenCalledTimes(1);
  expect(m.error).not.toHaveBeenCalled();
});

it("uses the internal identity for a raw-ID customer edit so monthly coverage is not counted twice",async()=>{
 const binding={id:"internal",tenant_id:"t",platform:"chatgpt",provider_campaign_id:"cmpn_test",funding_source:"provider"} as any;
 await withWorkspaceGrowthBudget("t",active,{...active,budget:{daily_spend_limit_micros:40e6}},"campaign",vi.fn(),{binding,currency:"USD"});
 expect(m.reserve).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({object_id:"internal",daily_delta_usd:15}));
 expect(m.commit).toHaveBeenCalledWith(expect.anything(),"internal");expect(m.record.mock.calls[0][1][0]).toMatchObject({object_id:"internal",campaign_id:"internal"});
});
