import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedInCreative } from "@/services/connectors/linkedin-ads/client";

const SHARED = "900";
const m = vi.hoisted(() => ({ wallet: false, ownList: vi.fn(), ownGroups: vi.fn(), walletGroups: vi.fn(), ownCreatives: vi.fn(), walletCreatives: vi.fn(), ledger: vi.fn() }));

vi.mock("@/services/tools/linkedin-ads/_wallet", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  linkedinAccountAccess: async (_t: string, account: string) =>
    m.wallet && account === SHARED
      ? { kind: "wallet", token: "managed-token", currency: "USD", campaignUrns: ["urn:li:sponsoredCampaign:111"], group: { binding: { provider_account_id: SHARED }, campaignBindingIds: ["cb-1"], campaignIds: ["111"] } }
      : { kind: "own" },
}));
vi.mock("@/services/tools/linkedin-ads/list_campaigns", () => ({
  walletCampaigns: async () => [{ id: "111", name: "Mine", status: "ACTIVE", objective: "LEAD_GENERATION", budget: null, campaign_group_id: "77", last_modified_at: "2026-11-04T09:00:00.000Z" }],
}));
vi.mock("@/services/connectors/linkedin-ads/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listLinkedInCampaigns: (...a: unknown[]) => m.ownList(...a),
  listLinkedInCampaignGroups: (...a: unknown[]) => m.ownGroups(...a),
  readLinkedInCampaignGroupsByIdWithToken: (...a: unknown[]) => m.walletGroups(...a),
  readLinkedInCreatives: (...a: unknown[]) => m.ownCreatives(...a),
  readLinkedInCreativesWithToken: (...a: unknown[]) => m.walletCreatives(...a),
}));
vi.mock("@/services/decisions/ad-changes", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readOutsideChanges: (...a: unknown[]) => m.ledger(...a),
}));

import { editedThatDay, fetchLinkedInRecentChanges, linkedinAdsRecentChangesTool, type LinkedInEditRow, type LinkedInLedgerChange } from "../recent_changes";

const campaign = (id: string, group: string, last_modified_at: string | null) => ({ id, name: `C${id}`, status: "ACTIVE", objective: "WEBSITE_CONVERSIONS", budget: null, campaign_group_id: group, last_modified_at, created_at: null, schedule_end_at: null });
const group = (id: string, last_modified_at: string | null) => ({ id, name: `G${id}`, status: "ACTIVE", total_budget: null, run_start_at: null, run_end_at: null, last_modified_at });
const creative = (id: string, campaign_id: string, last_modified_at: string | null): LinkedInCreative => ({ id, name: `Ad ${id}`, campaign_id, intended_status: "ACTIVE", is_serving: true, hold_reasons: [], review_status: "APPROVED", created_at: null, last_modified_at });
const ledgerRow = (platform: string, object_id: string, occurred_at: string, over: Record<string, unknown> = {}) => ({
  id: `${platform}-${object_id}`,
  platform,
  object_id,
  level: "ad_set",
  campaign_id: null,
  object_name: `obj ${object_id}`,
  source: "outside",
  action_table: null,
  action_id: null,
  change_kind: "status",
  before_status: "on",
  after_status: "off",
  before_daily_usd: "12.50",
  after_daily_usd: null,
  occurred_at,
  ...over,
});
const NOW = new Date("2026-11-04T18:00:00Z");
const ctx = { tenant_id: "t-a", log: () => undefined } as never;
type Out = { objects: LinkedInEditRow[]; edited_that_day: LinkedInEditRow[]; unknown: LinkedInEditRow[]; recent_edits: LinkedInEditRow[]; ledger_changes: LinkedInLedgerChange[]; day: string; window: { since: string; until: string } };

beforeEach(() => {
  m.wallet = false;
  for (const f of [m.ownList, m.ownGroups, m.walletGroups, m.ownCreatives, m.walletCreatives, m.ledger]) f.mockReset();
  m.ownGroups.mockResolvedValue([group("9", "2026-11-04T23:59:59.000Z"), group("8", "2026-10-01T00:00:00.000Z")]);
  m.ownList.mockResolvedValue([campaign("1", "9", "2026-11-03T23:59:59.000Z"), campaign("2", "9", "2026-11-05T00:00:00.000Z"), campaign("3", "8", null)]);
  m.ownCreatives.mockResolvedValue([creative("a1", "1", "2026-11-04T00:00:00.000Z"), creative("a2", "2", "2026-10-30T10:00:00.000Z")]);
  m.ledger.mockResolvedValue([
    ledgerRow("linkedin", "1", "2026-11-04T08:00:00.000Z"),
    ledgerRow("linkedin", "a1", "2026-11-02T08:00:00.000Z", { level: "ad", campaign_id: "1", change_kind: "budget", before_status: null, after_status: null, before_daily_usd: "10", after_daily_usd: "30" }),
    ledgerRow("meta", "1", "2026-11-04T08:00:00.000Z"),
    ledgerRow("linkedin", "999", "2026-11-04T08:00:00.000Z"),
  ]);
});

describe("linkedin_ads_recent_changes says whether an object was edited on the day the cost changed", () => {
  it("must catch: yes only when the latest edit falls on that UTC day, no when earlier, unknown when later or missing, and the ledger is filtered to this account's LinkedIn objects", async () => {
    const out = (await linkedinAdsRecentChangesTool.execute(ctx, { account_id: "500", day: "2026-11-04", lookback_days: 7 })) as Out;
    const verdict = Object.fromEntries(out.objects.map((o) => [`${o.level}:${o.id}`, o.edited_that_day]));
    expect(verdict).toEqual({
      "campaign_group:9": "yes",
      "campaign_group:8": "no",
      "campaign:1": "no",
      "campaign:2": "unknown",
      "campaign:3": "unknown",
      "ad:a1": "yes",
      "ad:a2": "no",
    });
    expect(out.edited_that_day.map((o) => o.id)).toEqual(["9", "a1"]);
    expect(out.unknown.map((o) => o.id)).toEqual(["2", "3"]);
    expect(out.window).toEqual({ since: "2026-10-29", until: "2026-11-04" });
    expect(out.recent_edits.map((o) => o.id)).toEqual(["9", "a1", "1", "a2"]);
    expect(m.ledger.mock.calls[0].slice(0, 2)).toEqual(["t-a", "2026-10-29T00:00:00.000Z"]);
    expect(out.ledger_changes).toEqual([
      expect.objectContaining({ object_id: "1", on_day: true, before_status: "on", after_status: "off", before_daily_usd: 12.5, after_daily_usd: null }),
      expect.objectContaining({ object_id: "a1", on_day: false, change_kind: "budget", before_daily_usd: 10, after_daily_usd: 30 }),
    ]);
    expect(JSON.stringify(out)).not.toMatch(/lastModifiedBy|modified_by|urn:li:person|actor/);
  });

  it("must catch: a wallet account reads with the managed token, only this workspace's campaign, group and ads, never the founder's login", async () => {
    m.wallet = true;
    m.walletGroups.mockImplementation(async (_t: string, _a: string, ids: string[]) => [group("77", "2026-11-04T01:00:00.000Z"), group("78", "2026-11-04T01:00:00.000Z")].filter((g) => ids.includes(g.id)));
    m.walletCreatives.mockResolvedValue([creative("w1", "111", "2026-11-01T00:00:00.000Z"), creative("x9", "222", "2026-11-04T00:00:00.000Z")]);
    m.ledger.mockResolvedValue([]);
    const out = (await linkedinAdsRecentChangesTool.execute(ctx, { account_id: SHARED, day: "2026-11-04" })) as Out;
    expect(m.walletGroups.mock.calls[0]).toEqual(["managed-token", SHARED, ["77"]]);
    expect(m.walletCreatives.mock.calls[0].slice(0, 3)).toEqual(["managed-token", SHARED, ["111"]]);
    expect(m.ownList).not.toHaveBeenCalled();
    expect(m.ownGroups).not.toHaveBeenCalled();
    expect(m.ownCreatives).not.toHaveBeenCalled();
    expect(out.objects.map((o) => `${o.level}:${o.id}:${o.edited_that_day}`)).toEqual(["campaign_group:77:yes", "campaign:111:yes", "ad:w1:no"]);
  });

  it("scopes to one campaign, defaults the day to today UTC and refuses a future day", async () => {
    const out = await fetchLinkedInRecentChanges("t-a", { account_id: "500", lookback_days: 3, campaign_id: "1" }, NOW);
    expect(out.day).toBe("2026-11-04");
    expect(out.objects.map((o) => `${o.level}:${o.id}`)).toEqual(["campaign_group:9", "campaign:1", "ad:a1"]);
    expect(m.ownCreatives.mock.calls[0][2]).toEqual(["1"]);
    await expect(fetchLinkedInRecentChanges("t-a", { account_id: "500", lookback_days: 3, day: "2026-11-05" }, NOW)).rejects.toMatchObject({ code: "linkedin_ads_bad_day" });
    for (const day of ["2026-02-31", "2026-00-15", "2026-13-01"]) await expect(fetchLinkedInRecentChanges("t-a", { account_id: "500", lookback_days: 3, day }, NOW)).rejects.toMatchObject({ code: "linkedin_ads_bad_day" });
    expect(editedThatDay("2026-11-04T00:00:00.000Z", "2026-11-04")).toBe("yes");
    expect(editedThatDay("2026-11-03T23:59:59.999Z", "2026-11-04")).toBe("no");
    expect(editedThatDay(null, "2026-11-04")).toBe("unknown");
  });
});
