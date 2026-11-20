import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  bundle: vi.fn(),
  log: vi.fn(),
  funding: "wallet" as "wallet" | "provider",
}));
vi.mock("@/services/channels/lock", async (original) => ({ ...(await original<typeof import("@/services/channels/lock")>()), isChannelLockedStrict: async () => false }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantClient: () => ({
    from: (table: string) => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: table === "tenant_users" ? { role: "owner" } : m.row, error: null }) };
      return q;
    },
  }),
}));
vi.mock("../write", async (original) => ({ ...(await original<typeof import("../write")>()), createLinkedInCampaignBundle: m.bundle }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true, enforced: true }) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: m.log }));
vi.mock("@/services/ads-wallet/bindings", () => ({ getAccountBinding: async (_t: string, id: string) => ({ id, funding_source: m.funding }), bindCampaign: vi.fn() }));

import { executeLinkedInCampaignAction } from "../action-execution";
import { ExpectedToolError } from "@/services/tools/types";
import { creationJournal } from "../creation-progress";
import { classifyExecFailure, verdictFor } from "@/services/channels/exec-failure";
import { LINKEDIN_ADS_RECONNECT } from "../http";
import { CHANGED_IN_LINKEDIN, POST_AUTHOR_REFUSED, POST_MISSING } from "../write";

const id = "10000000-0000-4000-8000-000000000001";
const claim = "20000000-0000-4000-8000-000000000002";
const binding = "30000000-0000-4000-8000-000000000003";
const payload = {
  account_id: "11",
  account_binding_id: binding,
  group: { name: "First test" },
  campaign: { name: "Pilot", daily_budget: { amount: "18", currency: "USD" }, unit_cost: { amount: "6", currency: "USD" }, geo_urns: ["urn:li:geo:103644278"], country: "US", language: "en", associated_entity: "urn:li:organization:42" },
  creative: { post_urn: "urn:li:share:7000000000000000001" },
};
const OWN_FIX = /Campaign Manager|reconnect|Correct the issue in LinkedIn/i;

function madeSoFar(extra: Record<string, unknown> = {}) {
  const journal = creationJournal("tenant", id, claim, m.row.exec_payload, null);
  m.row.exec_progress = { ...journal.state, account_binding_id: binding, group_id: "600", campaign_id: "700", group_paused: true, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
  m.funding = "wallet";
  m.log.mockResolvedValue(undefined);
  m.row = { status: "approved", exec_class: "linkedin_ads.create_campaign_bundle", exec_status: "dispatching", exec_payload: structuredClone(payload), approved_by: "owner-1", exec_claim_id: claim, exec_progress: null };
});

const changed = () => new ExpectedToolError("exec_partial", "The campaign Zavi made is no longer paused in LinkedIn, outside Zavi.", { [CHANGED_IN_LINKEDIN]: true });
const refusedAfterGroup = () => new ExpectedToolError("linkedin_ads_token_revoked", LINKEDIN_ADS_RECONNECT, { status: 401 });

it("a wallet campaign that stopped partway never sends the founder to Campaign Manager, stays never-re-run, and alerts Zavi to remove it", async () => {
  madeSoFar();
  m.bundle.mockRejectedValue(changed());
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim) as { ok: false; code: string; error: string; managed?: true };
  expect(r.code).toBe("exec_partial");
  expect(r.managed).toBe(true);
  expect(r.error).not.toMatch(OWN_FIX);
  expect(r.error).toMatch(/Zavi removes it/);
  expect(classifyExecFailure(r)?.bucket).toBe("partial_risk");
  expect(m.log).toHaveBeenCalledWith(expect.objectContaining({ code: "linkedin_ads.wallet_leftover", tenant_id: "tenant", meta: expect.objectContaining({ action_id: id, group_id: "600", campaign_id: "700" }) }));
});

it("a wallet campaign that can be finished says Try again, with no reconnect and nothing to correct in LinkedIn", async () => {
  madeSoFar({ campaign_id: null });
  m.bundle.mockRejectedValue(refusedAfterGroup());
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim) as { ok: false; code: string; error: string; managed?: true };
  expect(r.ok).toBe(false);
  expect(r.managed).toBe(true);
  expect(r.error).not.toMatch(OWN_FIX);
  expect(r.error).toMatch(/Choose Try again/);
  expect(verdictFor(r, "linkedin_ads.create_campaign_bundle")?.fix).not.toBe("reconnect");
});

it("an own-billing campaign keeps today's Campaign Manager and reconnect words", async () => {
  m.funding = "provider";
  madeSoFar();
  m.bundle.mockRejectedValue(changed());
  const partial = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim) as { error: string; managed?: true };
  expect(partial.error).toMatch(/Campaign Manager/);
  expect(partial.managed).toBeUndefined();
  madeSoFar({ campaign_id: null });
  m.bundle.mockRejectedValue(refusedAfterGroup());
  const retry = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim) as { error: string };
  expect(retry.error).toMatch(/Reconnect/);
  expect(m.log).not.toHaveBeenCalledWith(expect.objectContaining({ code: "linkedin_ads.wallet_leftover" }));
});

it("a post deleted after Create closes the card with the deletion named on the card, not a link to paste again", async () => {
  m.funding = "provider";
  madeSoFar();
  const message = "The post this campaign promotes is no longer on LinkedIn, so Zavi stopped and closed this card. Zavi archived the paused campaign and campaign group it had already made, so nothing can spend. Start a new campaign with a post that is still on LinkedIn.";
  m.bundle.mockRejectedValue(new ExpectedToolError(POST_AUTHOR_REFUSED, message, { [POST_MISSING]: true, archived: { campaign: true, group: true } }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim);
  expect(r).toMatchObject({ ok: false, code: POST_AUTHOR_REFUSED, [POST_MISSING]: true });
  const v = verdictFor(r, "linkedin_ads.create_campaign_bundle")!;
  expect(v.bucket).toBe("blocked_on_us");
  expect(v.note).toBe(message);
});

it.each([
  ["the daily limit", "linkedin_ads_daily_limit", "LinkedIn's daily allowance of requests for this LinkedIn connection is used up. It resets at 00:00 UTC (5:30 AM IST). Try again after that.", /00:00 UTC/],
  ["a rate limit", "linkedin_ads_rate_limited", "LinkedIn Ads is busy right now. Try again in a few minutes.", /in a few minutes/],
])("a 429 on a create step during Create is %s to wait out, not a refusal to correct in LinkedIn", async (_label, code, message, when) => {
  m.funding = "provider";
  madeSoFar({ campaign_id: null });
  m.bundle.mockRejectedValue(new ExpectedToolError("linkedin_ads_write_refused", message, { status: 429, http_status: 429, made: { group_id: "600", campaign_id: null } }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim) as { ok: false; code: string; error: string };
  expect(r.code).toBe(code);
  expect(r.error).toMatch(when);
  expect(r.error).not.toMatch(/refused|Correct the issue in LinkedIn|Campaign Manager/);
  expect(r.error).toMatch(/stays paused/);
  expect(classifyExecFailure(r)?.bucket).toBe("temporary");
});

it("a shared-wallet permission withdrawn before Try again says to authorize the shared wallet again, not to correct LinkedIn", async () => {
  madeSoFar({ campaign_id: null });
  m.bundle.mockRejectedValue(new ExpectedToolError("ads_consent_required", "Review and authorize shared-wallet spending first.", { nothing_sent: true }));
  const r = await executeLinkedInCampaignAction(id, "tenant", "owner-1", claim) as { ok: false; code: string; error: string };
  expect(r.code).toBe("linkedin_ads_wallet_consent_withdrawn");
  expect(r.error).toMatch(/Authorize shared wallet/);
  expect(r.error).not.toMatch(OWN_FIX);
  expect(classifyExecFailure(r)?.bucket).toBe("temporary");
});
