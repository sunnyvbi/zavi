const lock = vi.hoisted(() => ({ locked: false as boolean | "unreadable" }));
vi.mock("@/services/channels/lock", async (original) => ({ ...(await original<typeof import("@/services/channels/lock")>()), isChannelLockedStrict: async () => { if (lock.locked === "unreadable") throw new Error("channel lock config unavailable: system_config read failed"); return lock.locked; } }));

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  member: { role: "owner" } as { role: string } | null,
  bundle: vi.fn(),
  tier: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: table === "tenant_users" ? m.member : m.row, error: null }),
      };
      return q;
    },
  }),
}));
vi.mock("../write", async (original) => ({
  ...(await original<typeof import("../write")>()),
  createLinkedInCampaignBundle: m.bundle,
}));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));

import { executeLinkedInCampaignAction } from "../action-execution";
import { ExpectedToolError } from "@/services/tools/types";
import { creationJournal } from "../creation-progress";
import { classifyExecFailure, verdictFor } from "@/services/channels/exec-failure";
import { LINKEDIN_ADS_SETTINGS_REFUSED } from "../http";

const id = "10000000-0000-4000-8000-000000000001";
const claim = "20000000-0000-4000-8000-000000000002";
const payload = {
  account_id: "11",
  group: { name: "First test" },
  campaign: {
    name: "Pilot",
    daily_budget: { amount: "18", currency: "USD" },
    unit_cost: { amount: "6", currency: "USD" },
    geo_urns: ["urn:li:geo:103644278"],
    country: "US",
    language: "en",
    associated_entity: "urn:li:organization:42",
  },
  creative: { post_urn: "urn:li:share:7000000000000000001" },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
  m.row = {
    status: "approved",
    exec_class: "linkedin_ads.create_campaign_bundle",
    exec_status: "dispatching",
    exec_payload: structuredClone(payload),
    approved_by: "owner-1",
    exec_claim_id: claim,
    exec_progress: null,
  };
  m.member = { role: "owner" };
  m.bundle.mockResolvedValue({ group_id: "600", campaign_id: "700", creative_id: "800" });
  m.tier.mockResolvedValue({ allowed: true, enforced:true });
  lock.locked = false;
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
});

it("creates the bundle on the customer's linked account, everything paused", async () => {
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r.ok).toBe(true);
  expect(m.bundle).toHaveBeenCalledWith("tenant", "11", expect.objectContaining({ group: { name: `${payload.group.name} (Zavi ${id.slice(0, 8)})` } }), undefined, expect.any(Object));
  expect((r as { notice?: string }).notice).toBe("Created the campaign group, the paused campaign and its draft ad. Nothing can spend until you launch it. Review the campaign in Zavi before launching. Find it in LinkedIn Campaign Manager as Pilot.");
});

it.each([{}, { nothing_sent: true }])("a page-mismatch refusal before any create closes the card for a new campaign, since the approved post can never pass (%o)", async (meta) => {
  m.bundle.mockRejectedValue(new ExpectedToolError("linkedin_ads_post_page_mismatch", "This post was not published by the company page this ad account advertises for. Nothing was created.", meta));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({ ok: false, code: "linkedin_ads_post_author_refused", error: "This post was not published by the company page this ad account advertises for. Nothing was created." });
  expect(classifyExecFailure(r)).toEqual({ bucket: "blocked_on_us", fix: null, platform_code: "linkedin_ads_post_author_refused" });
});

it("an ad account, page or currency that changed since approval closes the card for a new review instead of offering Try again", async () => {
  m.bundle.mockRejectedValue(new ExpectedToolError("ads_account_mismatch", "The approved account, company or currency changed. Review the campaign again.", { nothing_sent: true }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({ ok: false, code: "linkedin_ads_account_changed", error: "The approved account, company or currency changed. Review the campaign again. Nothing was created in LinkedIn. Start a new campaign and review it again." });
  expect((r as { error: string }).error).not.toContain("approve the campaign again");
  expect(classifyExecFailure(r)).toEqual({ bucket: "blocked_on_us", fix: null, platform_code: "linkedin_ads_account_changed" });
});

it("a refused post whose campaign and group were archived closes the card for a new campaign, not a setup to finish or a Try again", async () => {
  const journal = creationJournal("tenant", id, claim, m.row.exec_payload, null);
  m.row.exec_progress = { ...journal.state, account_binding_id: "binding", group_id: "600", campaign_id: "700", group_paused: true };
  m.bundle.mockRejectedValue(new ExpectedToolError("linkedin_ads_post_author_refused", "LinkedIn would not promote this post because another page published it. Zavi archived the paused campaign and campaign group it had just made."));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({ ok: false, code: "linkedin_ads_post_author_refused", error: "LinkedIn would not promote this post because another page published it. Zavi archived the paused campaign and campaign group it had just made." });
  expect(classifyExecFailure(r)).toEqual({ bucket: "blocked_on_us", fix: null, platform_code: "linkedin_ads_post_author_refused" });
});

it.each([
  [true, /archived both/, /could not archive|may still be there/],
  [false, /could not archive the campaign group, which stays there empty/, /archived both/],
])("a refused post after Zavi made a campaign closes with a note that says what Zavi archived in the founder's account (group archived: %s)", async (group, says, never) => {
  const journal = creationJournal("tenant", id, claim, m.row.exec_payload, null);
  m.row.exec_progress = { ...journal.state, account_binding_id: "binding", group_id: "600", campaign_id: "700", group_paused: true };
  m.bundle.mockRejectedValue(new ExpectedToolError("linkedin_ads_post_author_refused", "LinkedIn refused the ad for this post.", { made: { group_id: "600", campaign_id: "700" }, archived: { campaign: true, group } }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  const note = verdictFor(r, "linkedin_ads.create_campaign_bundle")!.note!;
  expect(verdictFor(r, "linkedin_ads.create_campaign_bundle")!.bucket).toBe("blocked_on_us");
  expect(note).toMatch(/Zavi had already made a paused campaign/);
  expect(note).toContain(`${m.row.exec_payload && (m.row.exec_payload as { group: { name: string } }).group.name} (Zavi ${id.slice(0, 8)})`);
  expect(note).toMatch(says);
  expect(note).not.toMatch(never);
});

it("a refused post with nothing made keeps the plain closing note", async () => {
  m.bundle.mockRejectedValue(new ExpectedToolError("linkedin_ads_post_page_mismatch", "This post was not published by the company page this ad account advertises for. Nothing was created.", { nothing_sent: true }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(verdictFor(r, "linkedin_ads.create_campaign_bundle")!.note).not.toMatch(/archived|campaign group/);
});

it("keeps a checkpointed definite refusal retryable through the shared card classifier", async () => {
  const journal = creationJournal("tenant", id, claim, m.row.exec_payload, null);
  m.row.exec_progress = { ...journal.state, account_binding_id: "binding", group_id: "600", group_paused: true };
  m.bundle.mockRejectedValue(new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_SETTINGS_REFUSED, { status: 422, http_status: 422, linkedin_reason: "/status: account on hold" }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "linkedin_ads_creation_incomplete" });
  expect((r as { error: string }).error).toContain(LINKEDIN_ADS_SETTINGS_REFUSED);
  expect((r as { error: string }).error).not.toContain("account on hold");
  expect(classifyExecFailure(r)).toMatchObject({ bucket: "temporary" });
});

it("records LinkedIn's own refusal reason for support, and keeps it off the founder's message", async () => {
  const reason = "dailyBudget: Daily budget is below the minimum for this account";
  m.bundle.mockRejectedValue(new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_SETTINGS_REFUSED, {
    status: 422, http_status: 422, linkedin_reason: reason, made: { group_id: null, campaign_id: null, creative_id: null },
  }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_failed" });
  expect((r as { error: string }).error).toContain(LINKEDIN_ADS_SETTINGS_REFUSED);
  expect((r as { error: string }).error).not.toMatch(/minimum|dailyBudget/);
  expect(m.log).toHaveBeenCalledTimes(1);
  expect(m.log).toHaveBeenCalledWith({
    level: "warn",
    source: "linkedin-ads",
    code: "linkedin_ads.write_refused",
    tenant_id: "tenant",
    message: reason,
    meta: { stage: "create_bundle", object_id: id, failure_class: "linkedin_ads_write_refused", http_status: 422 },
  });
  expect(JSON.stringify(m.log.mock.calls)).not.toMatch(/token|Bearer/i);
});

it("logs a reasonless refusal with a fixed line and no raw text", async () => {
  m.bundle.mockRejectedValue(new ExpectedToolError("linkedin_ads_write_refused", LINKEDIN_ADS_SETTINGS_REFUSED, {
    status: 422, http_status: 422, made: { group_id: null, campaign_id: null, creative_id: null },
  }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_failed" });
  expect(m.log).toHaveBeenCalledTimes(1);
  expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ code: "linkedin_ads.write_refused", message: "LinkedIn refused this write and sent no reason Zavi could read." }));
});

const OFF = "You turned this ad account off in Zavi with Stop using this account. Nothing was created in LinkedIn. Turn it back on with Use this account again, or review the campaign with another account, then approve it again.";

it("a launch on an ad account the founder turned off is a clean failure that can be approved again", async () => {
  m.bundle.mockRejectedValue(new ExpectedToolError("linkedin_ads_account_disabled", OFF, { nothing_sent: true }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({ ok: false, code: "linkedin_ads_account_turned_off", error: OFF });
  expect(classifyExecFailure(r)).toEqual({ bucket: "temporary", fix: null, platform_code: null });
});

it("a Try again on an ad account turned off since the setup started says how to turn it back on", async () => {
  const journal = creationJournal("tenant", id, claim, m.row.exec_payload, null);
  m.row.exec_progress = { ...journal.state, account_binding_id: "binding", group_id: "600", group_paused: true };
  m.bundle.mockRejectedValue(new ExpectedToolError("linkedin_ads_account_disabled", OFF, { nothing_sent: true }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({ ok: false, code: "linkedin_ads_account_turned_off", error: "You turned this ad account off in Zavi with Stop using this account, so Zavi did not finish the campaign. Campaign setup is saved and stays paused. Turn the account back on with Use this account again, then choose Try again." });
  expect((r as { error: string }).error).not.toContain("in LinkedIn, then");
});

it.each([
  ["the account, company or currency changed", "ads_account_mismatch", "The approved account, company or currency changed. Review the campaign again."],
  ["the post is from another page of the same kind", "linkedin_ads_post_page_mismatch", "This post was not published by the company page this ad account advertises for."],
])("a Try again refused because %s stops for good instead of looping on Try again", async (_label, code, message) => {
  const journal = creationJournal("tenant", id, claim, m.row.exec_payload, null);
  m.row.exec_progress = { ...journal.state, account_binding_id: "binding", group_id: "600", group_paused: true };
  m.bundle.mockRejectedValue(new ExpectedToolError(code, message, { nothing_sent: true }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({ ok: false, code: "exec_partial", error: `${message} Zavi stopped and will not try this campaign again, because LinkedIn cannot fix this. What it made stays paused in LinkedIn, so nothing can spend. Open LinkedIn Campaign Manager to remove it, then approve a new campaign in Zavi.` });
  expect((r as { error: string }).error).not.toMatch(/Try again|Correct the issue/);
  expect(classifyExecFailure(r)).toMatchObject({ bucket: "partial_risk" });
});

it("keeps an uncertain checkpoint blocked rather than offering Try again", async () => {
  const journal = creationJournal("tenant", id, claim, m.row.exec_payload, null);
  m.row.exec_progress = { ...journal.state, account_binding_id: "binding", group_id: "600", group_paused: true, in_flight: "campaign_id" };
  m.bundle.mockRejectedValue(new ExpectedToolError("exec_partial", "Outcome is unknown"));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_partial" });
  expect(classifyExecFailure(r)).toMatchObject({ bucket: "partial_risk" });
});

it("refuses execution by a stale worker claim", async () => {
  await expect(executeLinkedInCampaignAction(id, "tenant", "owner-1", "stale-claim")).rejects.toThrow("approval");
  expect(m.bundle).not.toHaveBeenCalled();
});

it("refuses a CGO approval (no human actor)", async () => {
  await expect(executeLinkedInCampaignAction(id, "tenant", null, claim)).rejects.toThrow(/administrator/i);
  expect(m.bundle).not.toHaveBeenCalled();
});

it("refuses an actor who is not the recorded approver", async () => {
  await expect(executeLinkedInCampaignAction(id, "tenant", "someone-else", claim)).rejects.toThrow(/administrator/i);
  expect(m.bundle).not.toHaveBeenCalled();
});

it("refuses when the actor is not an owner or admin", async () => {
  m.member = { role: "member" };
  await expect(executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).rejects.toThrow(/owner or administrator/i);
  expect(m.bundle).not.toHaveBeenCalled();
});

it("a channel staff locked says coming soon, not unavailable, and creates nothing", async () => {
  lock.locked = true;
  await expect(executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).rejects.toThrow("LinkedIn Ads is coming soon.");
  expect(m.bundle).not.toHaveBeenCalled();
});

it("a plan without LinkedIn still says it is not available, and creates nothing", async () => {
  m.tier.mockResolvedValue({ allowed: false, enforced: true });
  await expect(executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).rejects.toThrow("LinkedIn Ads is not available for this workspace.");
  expect(m.bundle).not.toHaveBeenCalled();
});

it.each([
  ["comes back unverified", () => m.tier.mockResolvedValue({ allowed: true, enforced: false, unverified: true })],
  ["cannot be read at all", () => m.tier.mockRejectedValue(new Error("tenant_subscriptions read failed: timeout"))],
])("a Pro founder whose plan settings %s gets a try-again answer, never 'not available', and nothing is created", async (_label, arrange) => {
  arrange();
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_failed" });
  const error = (r as { error: string }).error;
  expect(error).toMatch(/could not check your plan/);
  expect(error).toMatch(/Try again|retry/);
  expect(error).not.toMatch(/not available|timeout|tenant_subscriptions/);
  expect(m.bundle).not.toHaveBeenCalled();
});

it("refuses while the write flag is OFF, even on an approved card", async () => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
  await expect(executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).rejects.toThrow(/switched off/i);
  expect(m.bundle).not.toHaveBeenCalled();
});

it("refuses a payload that smuggles a status field — paused is structural, not advisory", async () => {
  (m.row.exec_payload as Record<string, unknown>).campaign = { ...payload.campaign, status: "ACTIVE" };
  await expect(executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).rejects.toThrow();
  expect(m.bundle).not.toHaveBeenCalled();
});

it("a partial failure reports what exists and hides nothing", async () => {
  m.bundle.mockRejectedValue(
    new ExpectedToolError("linkedin_ads_write_refused", "HTTP 422", {
      made: { group_id: "600", campaign_id: null, creative_id: null },
    }),
  );
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_partial" });
  expect(String((r as { error?: string }).error)).toContain("campaign group");
});

it("a mid-bundle network error with a created id is exec_partial, never retryable exec_failed", async () => {
  m.bundle.mockRejectedValue(
    new ExpectedToolError("linkedin_ads_outcome_unknown", "did not come back clearly", {
      made: { group_id: "600", campaign_id: null, creative_id: null },
    }),
  );
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_partial" });
});

it("a first-create network error (nothing confirmed, maybe created) is exec_outcome_unknown", async () => {
  m.bundle.mockRejectedValue(
    new ExpectedToolError("linkedin_ads_outcome_unknown", "did not come back clearly", {
      made: { group_id: null, campaign_id: null, creative_id: null },
    }),
  );
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
});

it("a 2xx create whose id is unreadable is exec_outcome_unknown — the entity likely exists", async () => {
  m.bundle.mockRejectedValue(
    new ExpectedToolError("linkedin_ads_bad_response", "no x-restli-id", {
      made: { group_id: null, campaign_id: null, creative_id: null },
    }),
  );
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_outcome_unknown" });
});

it("a clean platform refusal of the first create is exec_failed — provably nothing exists, safe to re-approve", async () => {
  m.bundle.mockRejectedValue(
    new ExpectedToolError("linkedin_ads_write_refused", "HTTP 422", {
      made: { group_id: null, campaign_id: null, creative_id: null },
    }),
  );
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: "exec_failed" });
});

it("an unreadable Coming soon config blocks the create with plain words and a retryable outcome, never the internal error", async () => {
  lock.locked = "unreadable";
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toEqual({
    ok: false,
    code: "exec_failed",
    error: "Zavi could not check whether LinkedIn Ads is available, so nothing was created in LinkedIn. Approve the campaign again in a minute to retry.",
  });
  expect((r as { error: string }).error).not.toMatch(/config|unavailable|system_config/i);
  expect(m.bundle).not.toHaveBeenCalled();
  expect(classifyExecFailure(r)).toEqual({ bucket: "temporary", fix: null, platform_code: null });
});

it("a locked channel still refuses as Coming soon and creates nothing", async () => {
  lock.locked = true;
  await expect(executeLinkedInCampaignAction(id, "tenant", "owner-1", claim)).rejects.toMatchObject({ code: "linkedin_ads_conflict", message: "LinkedIn Ads is coming soon." });
  expect(m.bundle).not.toHaveBeenCalled();
});
