import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), exec: vi.fn(), record: vi.fn(), switched: vi.fn() }));
vi.mock("@/services/connectors/composio/account", () => ({ resolveOwnedComposioAccount: mocks.resolve }));
vi.mock("@/services/connectors/composio/api", () => ({ composioExecuteTool: mocks.exec }));
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: mocks.record }));
vi.mock("@/services/channels/channel-actions", () => ({ switchedChannelForRun: mocks.switched }));

import { executeRedditPause } from "../execute-pause";
import { redditAdsProposePauseCampaignTool } from "@/services/tools/reddit-ads/propose_pause_campaign";
import { resolveRedditAdsEmit } from "@/services/tools/reddit-ads/_exec-action";

const account = { tenant_id: "t1", toolkit: "reddit_ads", connected_account_id: "ca", auth_config_id: "ac" };
let campaign: Record<string, unknown> | null;
const ok = (data: unknown) => ({ ok: true, status: 200, data: { data }, error: null, outcome_unknown: false });
const body = { campaign_id: "c1", ad_account_id: "a2_x", status: "PAUSED", name: "Spring" };
const updates = () => mocks.exec.mock.calls.filter(([a]) => (a as { tool_slug: string }).tool_slug === "REDDIT_ADS_UPDATE_CAMPAIGN");

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  campaign = { id: "c1", name: "Spring", ad_account_id: "a2_x", configured_status: "ACTIVE" };
  mocks.resolve.mockResolvedValue(account);
  mocks.record.mockResolvedValue({ id: "card-1", replayed: false });
  mocks.exec.mockImplementation(async ({ tool_slug }: { tool_slug: string }) =>
    tool_slug === "REDDIT_ADS_GET_CAMPAIGN" ? ok(campaign) : ok({ ...campaign, configured_status: "PAUSED" }),
  );
});

describe("executeRedditPause (Approve on a reddit_ads.set_status card)", () => {
  it("pauses an ACTIVE campaign through REDDIT_ADS_UPDATE_CAMPAIGN", async () => {
    const r = await executeRedditPause({ tenant_id: "t1", body });
    expect(r.ok).toBe(true);
    expect(updates()).toHaveLength(1);
    expect(updates()[0][0]).toMatchObject({
      user_id: "t1",
      connected_account_id: "ca",
      arguments: { campaign_id: "c1", data: { configured_status: "PAUSED" } },
    });
  });

  it("refuses anything but a pause, before any call", async () => {
    const r = await executeRedditPause({ tenant_id: "t1", body: { ...body, status: "ACTIVE" } });
    expect(r).toMatchObject({ ok: false, code: "reddit_ads_body_invalid" });
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("asks for a reconnect when the account is gone", async () => {
    mocks.resolve.mockResolvedValue(null);
    expect(await executeRedditPause({ tenant_id: "t1", body })).toMatchObject({ ok: false, code: "reddit_ads_not_connected" });
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("does not write when the campaign moved to another ad account or stopped running", async () => {
    campaign = { ...campaign, ad_account_id: "a2_other" };
    expect((await executeRedditPause({ tenant_id: "t1", body })).ok).toBe(false);
    campaign = { id: "c1", name: "Spring", ad_account_id: "a2_x", configured_status: "ARCHIVED" };
    expect(await executeRedditPause({ tenant_id: "t1", body })).toMatchObject({ ok: false, code: "reddit_ads_campaign_not_active" });
    expect(updates()).toHaveLength(0);
  });

  it("does not write when Reddit returns the campaign without its ad account", async () => {
    campaign = { id: "c1", name: "Spring", configured_status: "ACTIVE" };
    expect(await executeRedditPause({ tenant_id: "t1", body })).toMatchObject({ ok: false, code: "reddit_ads_campaign_not_found" });
    expect(updates()).toHaveLength(0);
  });

  it("an already-paused campaign is a success with no write", async () => {
    campaign = { ...campaign, configured_status: "PAUSED" };
    expect((await executeRedditPause({ tenant_id: "t1", body })).ok).toBe(true);
    expect(updates()).toHaveLength(0);
  });

  it("a lost Composio response is outcome_unknown, never a failure", async () => {
    mocks.exec.mockImplementation(async ({ tool_slug }: { tool_slug: string }) =>
      tool_slug === "REDDIT_ADS_GET_CAMPAIGN"
        ? ok(campaign)
        : { ok: false, status: 502, data: null, error: "composio_ambiguous_response", outcome_unknown: true },
    );
    const r = await executeRedditPause({ tenant_id: "t1", body });
    expect(r).toMatchObject({ ok: false, outcome_unknown: true, code: "reddit_ads_outcome_unknown" });
    expect(r.error).toContain("did not confirm the pause");
  });
});

describe("reddit_ads__propose_pause_campaign", () => {
  const run = async (ctx: Record<string, unknown>, input: Record<string, unknown> = {}) =>
    redditAdsProposePauseCampaignTool.execute(
      { tenant_id: "t1", log: () => {}, ...ctx } as never,
      { campaign_id: "c1", account_id: "a2_x", rationale: "$40 over 30 days, 0 conversions", ...input },
    );

  it("files an executable pause card on a reddit_ads channel run", async () => {
    mocks.switched.mockResolvedValue("reddit_ads");
    const emit_decision = await resolveRedditAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: async () => "legacy" });
    const out = await run({ emit_decision });
    expect(out).toMatchObject({ action_id: "card-1", status: "waiting_for_founder" });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        execClass: "reddit_ads.set_status",
        actionType: "pause_ad",
        channelSlug: "reddit_ads",
        execPayload: expect.objectContaining({ campaign_id: "c1", ad_account_id: "a2_x", status: "PAUSED", name: "Spring" }),
      }),
    );
    expect(updates()).toHaveLength(0);
  });

  it("gets no sink outside a reddit_ads run, so a chat pause goes through Composio instead", async () => {
    mocks.switched.mockResolvedValue(null);
    const emit_decision = await resolveRedditAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: async () => "legacy" });
    expect(emit_decision).toBeUndefined();
    await expect(run({ emit_decision })).rejects.toMatchObject({ code: "reddit_ads_propose_not_channel_run" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a campaign Reddit returns without its ad account", async () => {
    mocks.switched.mockResolvedValue("reddit_ads");
    campaign = { id: "c1", name: "Spring", configured_status: "ACTIVE" };
    const emit_decision = await resolveRedditAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: async () => "legacy" });
    await expect(run({ emit_decision })).rejects.toMatchObject({ code: "reddit_ads_campaign_account_mismatch" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a campaign that is not running", async () => {
    mocks.switched.mockResolvedValue("reddit_ads");
    campaign = { ...campaign, configured_status: "PAUSED" };
    const emit_decision = await resolveRedditAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: async () => "legacy" });
    await expect(run({ emit_decision })).rejects.toMatchObject({ code: "reddit_ads_campaign_not_active" });
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
