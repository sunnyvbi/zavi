
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ campaigns: vi.fn(), pause: vi.fn(), record: vi.fn(), switched: vi.fn(), findBinding: vi.fn(), accountBinding: vi.fn(), boundPause: vi.fn(), boundCampaign: vi.fn(), unqueuedPause: vi.fn() }));
vi.mock("@/services/connectors/linkedin-ads/own-accounts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), linkedinAccountInUse: async () => true, linkedinAccountStoppable: async () => true }));
vi.mock("@/services/ads-wallet/bindings", () => ({ findCampaignBinding: mocks.findBinding, getAccountBinding: mocks.accountBinding }));
vi.mock("@/services/ads-wallet/adapters/linkedin", () => ({ requestLinkedinPause: mocks.boundPause, pauseLinkedinBoundCampaign: mocks.unqueuedPause, linkedinCampaign: mocks.boundCampaign }));
vi.mock("@/services/connectors/linkedin-ads/client", () => ({
  getLinkedInCampaign: async (t: string, a: string, id: string, opts?: unknown) => ((await mocks.campaigns(t, a, opts)) as Array<{ id: string }>).find((c) => c.id === id) ?? null,
}));
vi.mock("@/services/connectors/linkedin-ads/write", () => ({ pauseLinkedInCampaign: mocks.pause }));
vi.mock("@/services/channels/exec-actions", () => ({ recordChannelExecAction: mocks.record }));
vi.mock("@/services/channels/channel-actions", () => ({ switchedChannelForRun: mocks.switched }));

import { isLinkedInAdsWriteEnabled } from "@/services/tools/linkedin-ads/write/_flag-check";
import { linkedinAdsProposePauseCampaignTool, readLinkedInPauseBody } from "@/services/tools/linkedin-ads/propose_pause_campaign";
import { resolveLinkedInAdsEmit } from "@/services/tools/linkedin-ads/_exec-action";
import { executeLinkedInPause } from "../execute-pause";
import { ExpectedToolError } from "@/services/tools/types";
import { LINKEDIN_ADS_DAILY_LIMIT } from "../http";

const body = { campaign_id: "22", account_id: "11", status: "PAUSED", name: "Spring" };
let campaigns: Array<Record<string, unknown>>;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  campaigns = [{ id: "22", name: "Spring", status: "ACTIVE" }];
  mocks.campaigns.mockImplementation(async () => campaigns);
  mocks.pause.mockResolvedValue(undefined);
  mocks.record.mockResolvedValue({ id: "card-1", replayed: false });
  mocks.findBinding.mockResolvedValue(null);
  mocks.boundPause.mockResolvedValue(undefined);
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
});

describe("the write flag defaults OFF (Ravi's call to flip)", () => {
  it("is off unset and on anything but '1' or 'true', which turn it on like the managed-wallet switch", async () => {
    delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
    expect(await isLinkedInAdsWriteEnabled()).toBe(false);
    for (const off of ["0", "false", "yes", "on", "", "11"]) {
      process.env.LINKEDIN_ADS_WRITE_ENABLED = off;
      expect(await isLinkedInAdsWriteEnabled()).toBe(false);
    }
    for (const on of ["1", "true", "TRUE", " True "]) {
      process.env.LINKEDIN_ADS_WRITE_ENABLED = on;
      expect(await isLinkedInAdsWriteEnabled()).toBe(true);
    }
  });
});

describe("linkedin_ads__propose_pause_campaign", () => {
  const run = async (ctx: Record<string, unknown>, input: Record<string, unknown> = {}) =>
    linkedinAdsProposePauseCampaignTool.execute(
      { tenant_id: "t1", log: () => {}, ...ctx } as never,
      { campaign_id: "22", account_id: "11", rationale: "$40 over 30 days, 0 conversions", ...input },
    );

  it("files an executable pause card on a linkedin_ads channel run", async () => {
    mocks.switched.mockResolvedValue("linkedin_ads");
    const emit_decision = await resolveLinkedInAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: async () => "legacy" });
    const out = await run({ emit_decision });
    expect(out).toMatchObject({ action_id: "card-1", status: "waiting_for_founder" });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        execClass: "linkedin_ads.set_status",
        actionType: "pause_ad",
        channelSlug: "linkedin_ads",
        execPayload: expect.objectContaining(body),
      }),
    );
    expect(mocks.pause).not.toHaveBeenCalled();
  });

  it("still files a pause card while the write flag is OFF, because a pause only stops spend", async () => {
    delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
    mocks.switched.mockResolvedValue("linkedin_ads");
    const emit_decision = await resolveLinkedInAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: async () => "legacy" });
    await expect(run({ emit_decision })).resolves.toMatchObject({ action_id: "card-1", status: "waiting_for_founder" });
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ execClass: "linkedin_ads.set_status" }));
    expect(mocks.pause).not.toHaveBeenCalled();
  });

  it("gets no sink outside a linkedin_ads run", async () => {
    mocks.switched.mockResolvedValue(null);
    const emit_decision = await resolveLinkedInAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: async () => "legacy" });
    expect(emit_decision).toBeUndefined();
    await expect(run({ emit_decision })).rejects.toMatchObject({ code: "linkedin_ads_propose_not_channel_run" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a campaign that is not in the named account", async () => {
    mocks.switched.mockResolvedValue("linkedin_ads");
    campaigns = [];
    const emit_decision = await resolveLinkedInAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: async () => "legacy" });
    await expect(run({ emit_decision })).rejects.toMatchObject({ code: "linkedin_ads_campaign_not_found" });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it("refuses a campaign that is not ACTIVE — there is nothing to pause", async () => {
    mocks.switched.mockResolvedValue("linkedin_ads");
    campaigns = [{ id: "22", name: "Spring", status: "PAUSED" }];
    const emit_decision = await resolveLinkedInAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: async () => "legacy" });
    await expect(run({ emit_decision })).rejects.toMatchObject({ code: "linkedin_ads_campaign_not_active" });
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

describe("proposing a pause of a Zavi-managed (wallet) campaign", () => {
  const managed = { id: "bind-1", tenant_id: "t1", platform: "linkedin", provider_campaign_id: "22", account_binding_id: "acct-managed", funding_source: "wallet" };
  const rationale = "You asked Zavi to pause this campaign.";
  beforeEach(() => {
    mocks.findBinding.mockResolvedValue(managed);
    mocks.accountBinding.mockResolvedValue({ id: "acct-managed", provider_account_id: "11" });
    mocks.campaigns.mockRejectedValue(Object.assign(new Error("LinkedIn Ads is not connected"), { code: "not_connected" }));
    mocks.boundCampaign.mockResolvedValue({ campaign: { id: "22", name: "Managed spring", status: "ACTIVE" } });
  });

  it("reads the campaign through its managed binding, never the founder's own connector, and files the card", async () => {
    mocks.switched.mockResolvedValue("linkedin_ads");
    const emit_decision = await resolveLinkedInAdsEmit({ tenant_id: "t1", run_id: "r1", emit_decision: async () => "legacy" });
    const out = await linkedinAdsProposePauseCampaignTool.execute(
      { tenant_id: "t1", log: () => {}, emit_decision } as never,
      { campaign_id: "22", account_id: "11", rationale: "$40 over 30 days, 0 conversions" },
    );
    expect(out).toMatchObject({ action_id: "card-1", status: "waiting_for_founder", campaign: { id: "22", name: "Managed spring" } });
    expect(mocks.findBinding).toHaveBeenCalledWith("t1", "linkedin", "22");
    expect(mocks.boundCampaign).toHaveBeenCalledWith("t1", "bind-1", false, false, true);
    expect(mocks.campaigns).not.toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ execPayload: expect.objectContaining({ campaign_id: "22", account_id: "11", status: "PAUSED", name: "Managed spring" }) }));
  });

  it("builds the founder's pause body from the bound read", async () => {
    expect(await readLinkedInPauseBody("t1", { campaign_id: "22", account_id: "11", rationale })).toEqual({
      campaign_id: "22", account_id: "11", status: "PAUSED", name: "Managed spring", rationale, funding_source: "wallet",
    });
    expect(mocks.campaigns).not.toHaveBeenCalled();
  });

  it("refuses a card whose account is not the campaign's bound account, without reading LinkedIn", async () => {
    await expect(readLinkedInPauseBody("t1", { campaign_id: "22", account_id: "99", rationale })).rejects.toMatchObject({ code: "linkedin_ads_campaign_not_found" });
    expect(mocks.boundCampaign).not.toHaveBeenCalled();
    expect(mocks.campaigns).not.toHaveBeenCalled();
  });

  it("says a bound campaign that is already paused has nothing to pause", async () => {
    mocks.boundCampaign.mockResolvedValue({ campaign: { id: "22", name: "Managed spring", status: "PAUSED" } });
    await expect(readLinkedInPauseBody("t1", { campaign_id: "22", account_id: "11", rationale })).rejects.toMatchObject({ code: "linkedin_ads_campaign_not_active", message: '"Managed spring" is already paused.' });
  });
});

describe("executeLinkedInPause (Approve on a linkedin_ads.set_status card)", () => {
  it("on a managed campaign's first 404 says Zavi is checking, never ended or failed", async () => {
    const { ExpectedToolError } = await import("@/services/tools/types");
    mocks.findBinding.mockResolvedValue({ id: "bound", account_binding_id: "ab" });
    mocks.accountBinding.mockResolvedValue({ provider_account_id: "11" });
    mocks.boundPause.mockRejectedValue(new ExpectedToolError("ads_pause_queued", "Zavi is checking again.", { checking: true }));
    const r = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(r).toEqual({ ok: false, code: "ads_pause_queued", error: '"Spring": Zavi is checking again.' });
  });

  it("re-reads the campaign past a local LinkedIn daily block, so a throttle elsewhere cannot stop the pause", async () => {
    await executeLinkedInPause({ tenant_id: "t1", body });
    expect(mocks.campaigns).toHaveBeenCalledWith("t1", "11", { pauseCritical: true });
    expect(mocks.pause).toHaveBeenCalledTimes(1);
  });
  it("a LinkedIn day limit on the re-read still sends the pause: reading never stands between the founder and the stop", async () => {
    mocks.campaigns.mockRejectedValue(new ExpectedToolError("linkedin_ads_http_error", LINKEDIN_ADS_DAILY_LIMIT, { status: 429, http_status: 429 }));
    const r = await executeLinkedInPause({ tenant_id: "t1", body } as never);
    expect(mocks.pause).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, notice: 'Paused "Spring" in LinkedIn Ads.' });
  });

  it("a LinkedIn day limit on the read and the write says the campaign keeps spending", async () => {
    const limit = new ExpectedToolError("linkedin_ads_http_error", LINKEDIN_ADS_DAILY_LIMIT, { status: 429, http_status: 429 });
    mocks.campaigns.mockRejectedValue(limit);
    mocks.pause.mockRejectedValue(limit);
    const r = await executeLinkedInPause({ tenant_id: "t1", body } as never);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toContain("keeps running on LinkedIn and can keep spending");
    expect(r.error).toContain("00:00 UTC");
    expect(r.error).not.toContain("few minutes");
  });

  it("a bound pause LinkedIn accepted but could not confirm settles the card with those words", async () => {
    mocks.findBinding.mockResolvedValue({ id: "bound-1", account_binding_id: "ab" });
    mocks.accountBinding.mockResolvedValue({ provider_account_id: "11" });
    mocks.boundPause.mockRejectedValue(new ExpectedToolError("ads_pause_queued", "LinkedIn accepted the pause.", { accepted: true }));
    expect(await executeLinkedInPause({ tenant_id: "t1", body } as never)).toEqual({ ok: true, notice: '"Spring": LinkedIn accepted the pause.' });
  });

  it("must-catch: a bound pause LinkedIn answered 429 is saved and retried, and the card says so instead of 'keeps running'", async () => {
    mocks.findBinding.mockResolvedValue({ id: "bound-1", account_binding_id: "ab" });
    mocks.accountBinding.mockResolvedValue({ provider_account_id: "11" });
    mocks.unqueuedPause.mockRejectedValue(new ExpectedToolError("linkedin_ads_write_refused", "LinkedIn Ads is busy right now. Try again in a few minutes.", { status: 429, http_status: 429 }));
    mocks.boundPause.mockRejectedValue(new ExpectedToolError("ads_pause_queued", "Zavi saved your pause request and will keep retrying it. Check back in a few minutes."));
    const r = await executeLinkedInPause({ tenant_id: "t1", body } as never);
    expect(r).toEqual({ ok: false, code: "ads_pause_queued", error: '"Spring": Zavi saved your pause request and will keep retrying it. Check back in a few minutes.' });
    expect(mocks.boundPause).toHaveBeenCalledWith("t1", "bound-1");
    expect(mocks.unqueuedPause).not.toHaveBeenCalled();
  });

  it("a bound campaign relaunched during the pause says so, never that LinkedIn refused", async () => {
    mocks.findBinding.mockResolvedValue({ id: "bound-1", account_binding_id: "ab" });
    mocks.accountBinding.mockResolvedValue({ provider_account_id: "11" });
    mocks.boundPause.mockRejectedValue(new ExpectedToolError("ads_pause_superseded", "This campaign was relaunched while Zavi was pausing it, so Zavi left it running. Pause it again if you still want it stopped."));
    const r = await executeLinkedInPause({ tenant_id: "t1", body } as never);
    expect(r).toMatchObject({ ok: false, code: "ads_pause_superseded" });
    expect(r.error).toContain("relaunched");
    expect(r.error).not.toContain("keeps running on LinkedIn");
  });

  it("a bound pause stopped by the day limit fails with the adapter's own true words", async () => {
    mocks.findBinding.mockResolvedValue({ id: "bound-1", account_binding_id: "ab" });
    mocks.accountBinding.mockResolvedValue({ provider_account_id: "11" });
    mocks.boundPause.mockRejectedValue(new ExpectedToolError("ads_pause_queued", "It can keep spending until 00:00 UTC.", { daily_limit: true }));
    expect(await executeLinkedInPause({ tenant_id: "t1", body } as never)).toEqual({ ok: false, code: "ads_pause_queued", error: '"Spring": It can keep spending until 00:00 UTC.' });
  });

  it("re-reads the campaign, then pauses it", async () => {
    const r = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(r.ok).toBe(true);
    expect(mocks.pause).toHaveBeenCalledWith("t1", "11", "22");
  });

  it("refuses anything but a pause, before any call", async () => {
    const r = await executeLinkedInPause({ tenant_id: "t1", body: { ...body, status: "ACTIVE" } });
    expect(r).toMatchObject({ ok: false, code: "linkedin_ads_body_invalid" });
    expect(mocks.pause).not.toHaveBeenCalled();
  });

  it("an approved pause still pauses while the write flag is OFF, so the founder can always stop spend", async () => {
    delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
    const r = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(r.ok).toBe(true);
    expect(mocks.pause).toHaveBeenCalledWith("t1", "11", "22");
  });

  it("does not write when the campaign left the account or ended, and closes the card as nothing to pause", async () => {
    for (const status of ["ARCHIVED", "COMPLETED", "CANCELED", "PENDING_DELETION", "REMOVED"]) {
      campaigns = [{ id: "22", name: "Spring", status }];
      expect(await executeLinkedInPause({ tenant_id: "t1", body })).toEqual({ ok: true, notice: 'LinkedIn shows "Spring" already ended, so there was nothing to pause.' });
    }
    campaigns = [{ id: "22", name: "Spring", status: "DRAFT" }];
    expect(await executeLinkedInPause({ tenant_id: "t1", body })).toMatchObject({ ok: false, code: "linkedin_ads_campaign_not_active" });
    expect(mocks.pause).not.toHaveBeenCalled();
  });

  it("two immediate 404s are not taken as gone: the card stays open, says nothing stopped, and nothing is written", async () => {
    campaigns = [];
    const r = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(r).toEqual({
      ok: false,
      code: "linkedin_ads_campaign_checking",
      error: 'LinkedIn could not find "Spring" just now, so Zavi did not change anything and cannot say it has stopped. Check it in LinkedIn Campaign Manager, or approve this again in a few minutes.',
    });
    expect(r.notice).toBeUndefined();
    expect(mocks.campaigns).toHaveBeenCalledTimes(2);
    expect(mocks.pause).not.toHaveBeenCalled();
    campaigns = [{ id: "22", name: "Spring", status: "ACTIVE" }];
    expect(await executeLinkedInPause({ tenant_id: "t1", body })).toEqual({ ok: true, notice: 'Paused "Spring" in LinkedIn Ads.' });
    expect(mocks.pause).toHaveBeenCalledTimes(1);
  });

  it("one empty read is not taken as gone: the confirming read finds it running and it is paused", async () => {
    mocks.campaigns.mockImplementationOnce(async () => []);
    expect(await executeLinkedInPause({ tenant_id: "t1", body })).toEqual({ ok: true, notice: 'Paused "Spring" in LinkedIn Ads.' });
    expect(mocks.campaigns).toHaveBeenCalledTimes(2);
    expect(mocks.pause).toHaveBeenCalledWith("t1", "11", "22");
  });

  it("an empty read then an unreadable confirming read fails the pause instead of saying there was nothing to pause", async () => {
    mocks.campaigns.mockImplementationOnce(async () => []).mockImplementationOnce(async () => {
      throw new Error("LinkedIn 500");
    });
    const r = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(r).toMatchObject({ ok: false, code: "linkedin_ads_read_failed" });
    expect(r.notice).toBeUndefined();
    expect(mocks.pause).not.toHaveBeenCalled();
  });

  it.each([
    ["read_only", new ExpectedToolError("ads_account_read_only", "Your LinkedIn user can only view this ad account.")],
    ["403", new ExpectedToolError("linkedin_ads_forbidden", "LinkedIn did not let Zavi make changes in this ad account.")],
    ["expired login", new ExpectedToolError("linkedin_ads_token_revoked", "LinkedIn Ads needs to be reconnected.")],
  ])("a refused pause (%s) says the campaign keeps running before it says why", async (_label, refusal) => {
    mocks.pause.mockRejectedValue(refusal);
    const r = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(refusal.code);
    expect(r.error).toBe(`Zavi could not pause "Spring", so it keeps running on LinkedIn and can keep spending. ${refusal.message}`);
  });

  it("a refused pause of a Zavi-bound campaign says so too", async () => {
    mocks.findBinding.mockResolvedValue({ id: "b", account_binding_id: "a" });
    mocks.accountBinding.mockResolvedValue({ provider_account_id: "11" });
    mocks.boundPause.mockRejectedValue(new ExpectedToolError("ads_account_read_only", "View only."));
    expect((await executeLinkedInPause({ tenant_id: "t1", body })).error).toBe('Zavi could not pause "Spring", so it keeps running on LinkedIn and can keep spending. View only.');
  });

  it.each(["read", "write"])("a Zavi-side LinkedIn login fault on the %s says the pause did not happen and what to do, never that there is nothing to do", async (where) => {
    const fault = new ExpectedToolError("linkedin_ads_zavi_fault", "LinkedIn Ads could not be read because of a problem on Zavi's side. Your connection is fine and there is nothing for you to do. Zavi will try again.");
    if (where === "read") mocks.campaigns.mockRejectedValue(fault);
    else mocks.pause.mockRejectedValue(fault);
    const r = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("linkedin_ads_zavi_fault");
    expect(r.error).toMatch(/^Zavi could not pause "Spring" because of a problem on Zavi's side, so it keeps running on LinkedIn and can keep spending\./);
    expect(r.error).toContain("pause it in LinkedIn Campaign Manager");
    expect(r.error).not.toMatch(/nothing for you to do|will try again|could not be read/);
    if (where === "read") expect(mocks.pause).not.toHaveBeenCalled();
  });

  it("the running warning survives the longest campaign name the card allows", async () => {
    const name = "N".repeat(300);
    mocks.pause.mockRejectedValue(new ExpectedToolError("linkedin_ads_forbidden", "x".repeat(300)));
    campaigns = [{ id: "22", name, status: "ACTIVE" }];
    const r = await executeLinkedInPause({ tenant_id: "t1", body: { ...body, name } });
    expect(r.error!.length).toBeLessThanOrEqual(400);
    expect(r.error).toContain("keeps running on LinkedIn");
  });

  it("does not claim it keeps running when the outcome is unknown", async () => {
    mocks.pause.mockRejectedValue(new Error("socket hang up"));
    const r = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(r.error).toBe('Pause of "Spring" failed: LinkedIn Ads did not confirm the pause.');
  });

  it("an already-paused campaign settles as a success with no write", async () => {
    campaigns = [{ id: "22", name: "Spring", status: "PAUSED" }];
    expect((await executeLinkedInPause({ tenant_id: "t1", body })).ok).toBe(true);
    expect(mocks.pause).not.toHaveBeenCalled();
  });
});

describe("an approved pause of a campaign Zavi created", () => {
  beforeEach(() => {
    mocks.findBinding.mockResolvedValue({ id: "binding-22", account_binding_id: "acct-binding", platform: "linkedin", provider_campaign_id: "22", funding_source: "wallet" });
    mocks.accountBinding.mockResolvedValue({ id: "acct-binding", provider_account_id: "11", credential_source: "platform" });
    mocks.campaigns.mockRejectedValue(Object.assign(new Error("not connected"), { code: "linkedin_ads_not_connected" }));
  });

  it("pauses a Zavi-managed campaign through its bound account, recording the stop before LinkedIn", async () => {
    const out = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(out).toMatchObject({ ok: true });
    expect(mocks.boundPause).toHaveBeenCalledWith("t1", "binding-22");
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.campaigns).not.toHaveBeenCalled();
  });

  it("refuses when the card's account is not the campaign's bound account", async () => {
    mocks.accountBinding.mockResolvedValue({ id: "acct-binding", provider_account_id: "99" });
    const out = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(out).toMatchObject({ ok: false, code: "linkedin_ads_campaign_not_found" });
    expect(mocks.boundPause).not.toHaveBeenCalled();
    expect(mocks.pause).not.toHaveBeenCalled();
  });

  it("fails closed without a raw write when the binding cannot be resolved", async () => {
    mocks.findBinding.mockRejectedValue(new Error("ambiguous"));
    mocks.campaigns.mockResolvedValue([{ id: "22", name: "Spring", status: "PAUSED" }]);
    const out = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(out).toMatchObject({ ok: false, code: "ads_binding_unavailable" });
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.boundPause).not.toHaveBeenCalled();
  });

  it("records a customer-billed stop through the bound path so a failed provider call can recover", async () => {
    mocks.findBinding.mockResolvedValue({ id: "binding-22", account_binding_id: "acct-binding", platform: "linkedin", provider_campaign_id: "22", funding_source: "provider" });
    mocks.campaigns.mockResolvedValue([{ id: "22", name: "Spring", status: "ACTIVE" }]);
    mocks.boundPause.mockRejectedValue(new Error("LinkedIn 503"));
    const out = await executeLinkedInPause({ tenant_id: "t1", body });
    expect(out).toMatchObject({ ok: false });
    expect(mocks.boundPause).toHaveBeenCalledWith("t1", "binding-22");
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.campaigns).not.toHaveBeenCalled();
  });
  it("checks the customer campaign's bound account against the approved card", async () => {
    mocks.findBinding.mockResolvedValue({ id: "binding-22", account_binding_id: "acct-binding", platform: "linkedin", provider_campaign_id: "22", funding_source: "provider" });
    mocks.accountBinding.mockResolvedValue({ provider_account_id: "99" });
    mocks.campaigns.mockResolvedValue([{ id: "22", name: "Spring", status: "ACTIVE" }]);
    expect(await executeLinkedInPause({ tenant_id: "t1", body })).toMatchObject({ ok: false, code: "linkedin_ads_campaign_not_found" });
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.boundPause).not.toHaveBeenCalled();
  });
});
