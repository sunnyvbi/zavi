import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
const h = vi.hoisted(() => ({ record: vi.fn(), update: vi.fn(), filter: vi.fn(), insert: vi.fn(), db: vi.fn(), launch: vi.fn(), budget: vi.fn(), status: vi.fn(), detail: vi.fn(), settings: vi.fn() }));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (id: string) => id, tenantClient: h.db }));
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: h.record }));
vi.mock("@/services/tools/tiktok-ads/_exec-action", () => ({ describeTiktokAction: () => ({ actionType: "update_ad", title: "Review change", sentence: "Changes wait for approval", rows: [] }) }));
vi.mock("@/services/tools/tiktok-ads/launch", () => ({ tiktokAdsProposeLaunchTool: { execute: h.launch } }));
vi.mock("@/services/tools/tiktok-ads/propose_changes", () => ({ tiktokAdsProposeBudgetChangeTool: { execute: h.budget }, tiktokAdsProposeStatusChangeTool: { execute: h.status } }));
vi.mock("./campaign-settings", () => ({ readSettingsObject: h.detail, proposeSettingsBody: h.settings }));
vi.mock("./composio-read", () => ({ tiktokCampaignsUrl: (id: string) => `https://ads.tiktok.com/${id}` }));

import { requestCampaignCreation, requestCampaignEdit } from "./campaign-requests";
import { serverFounderMarks } from "@/services/growth/founder-marks";
import { CampaignFilingOutcomeUnknown } from "./campaign-request-errors";
import { EmitNoWriteError } from "@/services/agents/emit-no-write";

const current = { id: "789", campaign_id: "456", level: "ad_group", revision: "before", status: "ACTIVE", budget: 30 };
const input = { advertiser_id: "123", campaign_id: "456", level: "ad_group" as const, object_id: "789", revision: "before", changes: { daily_budget_usd: 40 } };
const before = { advertiser_id: "123", campaign_id: "456", object_id: "789", level: "ad_group", name: "Ad group", expected_current_daily_budget_usd: 30, expected_current_status: "ACTIVE", daily_budget_usd: 40 };
type Ctx = { tenant_id: string; emit_decision: (cls: string, body: unknown) => Promise<string> };
beforeEach(() => {
  vi.clearAllMocks();
  h.db.mockReturnValue({ from: () => ({ insert: h.insert, update: h.update }) });
  h.update.mockReturnValue({eq: h.filter});
  h.filter.mockResolvedValue({error: null});
  h.insert.mockReturnValue({ select: async () => ({ data: [{ id: "run" }], error: null }) });
  h.record.mockResolvedValue({ id: "action", replayed: false });
  h.detail.mockResolvedValue({ ...current });
  h.budget.mockImplementation(async (ctx: Ctx) => ({ action_id: await ctx.emit_decision("tiktok_ads.update_budget", before) }));
  h.status.mockImplementation(async (ctx: Ctx) => ({ action_id: await ctx.emit_decision("tiktok_ads.set_status", { ...before, status: "PAUSED", daily_budget_usd: 30 }) }));
  h.settings.mockResolvedValue({ advertiser_id: "123", origin: "specialist", changes: { adgroup_name: "Renamed" } });
  h.launch.mockImplementation(async (ctx: Ctx) => ({ action_id: await ctx.emit_decision("tiktok_ads.create_launch", { advertiser_id: "123", origin: "specialist" }), status: "waiting_for_approval" }));
});

describe("deterministic campaign request filing", () => {
  it("creates a zero-model-cost human request without supplying an approval envelope", async () => {
    expect(await requestCampaignCreation("tenant", "user", { advertiser_id: "123", name: "New campaign", rationale: "untrusted" })).toEqual({ action_id: "action", status: "waiting_for_approval" });
    expect(h.launch).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant", top_action_run: true }), { advertiser_id: "123", name: "New campaign", rationale: "You created this campaign in the TikTok campaign editor." });
    const ctx = h.launch.mock.calls[0][0];
    expect(ctx.run_id).toBeUndefined();
    expect(ctx.approval_envelope).toBeUndefined();
    expect(h.db).toHaveBeenCalledWith("tenant");
    expect(h.insert).toHaveBeenCalledWith(expect.objectContaining({ agent_slug: "tiktok_ads", channel_slug: "tiktok_ads", enqueued_by: "user", trigger: "manual", cost_tokens: 0, cost_usd: 0 }));
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant", runId: "run", execPayload: expect.objectContaining({ origin: "user_initiated_ledger" }) }), undefined, expect.objectContaining({ cgoDoor: false }));
    expect(h.record.mock.calls[0][2].enabled()).toBe(false);
  });

  it("keeps human origin through the real server provenance normalizer", () => {
    for (const cls of ["tiktok_ads.create_launch", "tiktok_ads.update_settings", "tiktok_ads.update_budget", "tiktok_ads.set_status"]) {
      expect(serverFounderMarks(cls, { origin: "user_initiated_ledger", founder_chat_order: true, approval_envelope: null }, null)).toEqual({ origin: "user_initiated_ledger", approval_envelope: null });
    }
  });

  it("files the exact fresh budget change for the explicit advertiser", async () => {
    expect(await requestCampaignEdit("tenant", "user", input)).toEqual({ action_id: "action" });
    expect(h.detail).toHaveBeenCalledWith("tenant", "123", "456", "ad_group", "789");
    expect(h.budget).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant" }), expect.objectContaining({ advertiser_id: "123", object_id: "789", level: "ad_group", daily_budget_usd: 40 }));
    expect(h.record.mock.calls[0][0].execPayload).toMatchObject({ ...before, origin: "user_initiated_ledger" });
  });

  it("refuses a form whose revision has already changed", async () => {
    await expect(requestCampaignEdit("tenant", "user", { ...input, revision: "old" })).rejects.toMatchObject({ code: "tiktok_ads_object_drifted" });
    expect(h.budget).not.toHaveBeenCalled(); expect(h.record).not.toHaveBeenCalled();
  });

  it.each([
    { campaign_id: "other" }, { object_id: "other" }, { expected_current_status: "PAUSED" }, { expected_current_daily_budget_usd: 35 },
  ])("refuses drift between detail and the proposal tool's second read: %j", async (drift) => {
    h.budget.mockImplementation(async (ctx: Ctx) => ctx.emit_decision("tiktok_ads.update_budget", { ...before, ...drift }));
    await expect(requestCampaignEdit("tenant", "user", input)).rejects.toMatchObject({ code: "tiktok_ads_object_drifted" });
    expect(h.record).not.toHaveBeenCalled(); expect(h.insert).not.toHaveBeenCalled();
  });

  it("requires the same budget when a second read would resume spending", async () => {
    h.detail.mockResolvedValue({ ...current, status: "PAUSED" });
    h.status.mockImplementation(async (ctx: Ctx) => ctx.emit_decision("tiktok_ads.set_status", { ...before, status: "ACTIVE", expected_current_status: "PAUSED", daily_budget_usd: 31 }));
    await expect(requestCampaignEdit("tenant", "user", { ...input, changes: { status: "ACTIVE" } })).rejects.toMatchObject({ code: "tiktok_ads_object_drifted" });
    expect(h.record).not.toHaveBeenCalled();
  });

  it("files a pause without adding a spend-up guard", async () => {
    expect(await requestCampaignEdit("tenant", "user", { ...input, changes: { status: "PAUSED" } })).toEqual({ action_id: "action" });
    expect(h.record.mock.calls[0][0].execClass).toBe("tiktok_ads.set_status");
  });
  it("files a reviewed resume backed by parent budgets instead of the ad's absent own budget", async () => {
    h.detail.mockResolvedValue({ ...current, level: "ad", status: "PAUSED", budget: null });
    const plan = { revision: "a".repeat(64), sources: [{ object_id: "777", level: "ad_group", daily_budget_usd: 30, budget_mode: "BUDGET_MODE_DAY" }] };
    h.status.mockImplementation(async (ctx: Ctx) => ctx.emit_decision("tiktok_ads.set_status", { ...before, level: "ad", status: "ACTIVE", expected_current_status: "PAUSED", daily_budget_usd: 30, resume_plan: plan }));
    expect(await requestCampaignEdit("tenant", "user", { ...input, level: "ad", changes: { status: "ACTIVE" } })).toEqual({ action_id: "action" });
    expect(h.record.mock.calls[0][0].execPayload.resume_plan).toEqual(plan);
  });
  it("refuses an object revision change while preparing a parent-funded resume", async () => {
    h.detail.mockResolvedValueOnce({ ...current, status: "PAUSED", budget: null }).mockResolvedValueOnce({ ...current, revision: "changed" });
    h.status.mockImplementation(async (ctx: Ctx) => ctx.emit_decision("tiktok_ads.set_status", { ...before, status: "ACTIVE", expected_current_status: "PAUSED", daily_budget_usd: 30, resume_plan: { revision: "a".repeat(64), sources: [] } }));
    await expect(requestCampaignEdit("tenant", "user", { ...input, changes: { status: "ACTIVE" } })).rejects.toMatchObject({ code: "tiktok_ads_object_drifted" });
    expect(h.record).not.toHaveBeenCalled();
  });

  it("passes full settings through the strict preparation service and stamps human origin", async () => {
    const settings = { ...input, changes: { adgroup_name: "Renamed" } };
    await requestCampaignEdit("tenant", "user", settings);
    expect(h.settings).toHaveBeenCalledWith("tenant", settings);
    expect(h.budget).not.toHaveBeenCalled(); expect(h.status).not.toHaveBeenCalled();
    expect(h.record.mock.calls[0][0]).toMatchObject({ execClass: "tiktok_ads.update_settings", execPayload: { origin: "user_initiated_ledger" } });
  });

  it("does not report a proposal when its audit run cannot be persisted", async () => {
    h.insert.mockReturnValue({ select: async () => ({ data: null, error: { message: "unavailable" } }) });
    await expect(requestCampaignCreation("tenant", "user", {})).rejects.toThrow("Could not record");
    expect(h.record).not.toHaveBeenCalled();
  });

  it("distinguishes a lost card confirmation from an explicit no-write refusal", async () => {
    h.record.mockRejectedValueOnce(new Error("RPC response lost after commit"));
    await expect(requestCampaignEdit("tenant", "user", input)).rejects.toBeInstanceOf(CampaignFilingOutcomeUnknown);
    const refusal = new EmitNoWriteError("Known refusal before write");
    h.record.mockRejectedValueOnce(refusal);
    await expect(requestCampaignEdit("tenant", "user", input)).rejects.toBe(refusal);
  });
});


describe("truthful campaign filing outcome", () => {
  it("does not claim approval is pending before the card exists", async () => {
    h.record.mockImplementationOnce(async () => {
      expect(h.insert.mock.calls[0][0]).toMatchObject({status: "running", finished_at: null});
      expect(h.insert.mock.calls[0][0].output_text).not.toContain("awaits your approval");
      expect(h.update).not.toHaveBeenCalled();
      return {id: "action"};
    });
    await requestCampaignCreation("tenant", "user", {});
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({status: "success", output_text: expect.stringContaining("awaits your approval")}));
    expect(h.filter).toHaveBeenCalledWith("id", "run");
  });
  it.each(["create", "settings", "budget", "status"])("a refused %s filing fails its run and rethrows the same refusal", async kind => {
    const refusal = new EmitNoWriteError("Previously rejected change");
    h.record.mockRejectedValueOnce(refusal);
    const request = kind === "create" ? requestCampaignCreation("tenant", "user", {}) : requestCampaignEdit("tenant", "user", {...input, changes: kind === "settings" ? {adgroup_name: "Changed"} : kind === "status" ? {status: "PAUSED"} : input.changes});
    await expect(request).rejects.toBe(refusal);
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({status: "failed", parse_ok: false, output_text: expect.stringContaining("No approval card was created")}));
    expect(h.filter).toHaveBeenCalledWith("id", "run");
  });
  it("a lost filing response stays uncertain, with no false no-card claim", async () => {
    h.record.mockRejectedValueOnce(new Error("connection lost"));
    await expect(requestCampaignEdit("tenant", "user", input)).rejects.toBeInstanceOf(CampaignFilingOutcomeUnknown);
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({status: "failed", output_text: expect.stringContaining("may have been saved")}));
  });
  it("a lost success-status update does not allow the saved card to be filed again", async () => {
    h.filter.mockResolvedValueOnce({error: {message: "write failed"}});
    await expect(requestCampaignEdit("tenant", "user", input)).rejects.toBeInstanceOf(CampaignFilingOutcomeUnknown);
    expect(h.record).toHaveBeenCalledTimes(1);
  });
});
