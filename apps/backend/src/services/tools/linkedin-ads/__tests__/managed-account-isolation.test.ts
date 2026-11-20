import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MANAGED = "900";
const MANAGED_URN = `urn:li:sponsoredAccount:${MANAGED}`;
const CAMPAIGN_A = "111";
const CAMPAIGN_B = "222";
const GROUP_A = "41";
const GROUP_B = "42";
const AD_A = "7001";
const AD_B = "7002";
const STAMP = Date.UTC(2026, 10, 4, 1, 0, 0);

type Row = Record<string, any>;

const m = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  leakyFacade: false,
  calls: [] as Array<{ token: string; path: string; params: Row }>,
  noisyAnalytics: false,
}));

function chain(rows: Row[]) {
  const filters: Array<(r: Row) => boolean> = [];
  const q: Row = {
    select: () => q,
    order: () => q,
    limit: () => q,
    gte: (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), q),
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
    range: async () => ({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
    maybeSingle: async () => ({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(ok, bad),
  };
  return q;
}

vi.mock("@/services/tenant-client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  asTenantId: (t: string) => t,
  globalClient: () => ({ from: (t: string) => chain(m.tables[t] ?? []) }),
  tenantClient: (tenant: string) => ({ from: (t: string) => chain((m.tables[t] ?? []).filter((r) => m.leakyFacade || !("tenant_id" in r) || r.tenant_id === tenant)) }),
  tenantRpc: async (_t: string, name: string) => {
    if (name === "ads_verify_account_binding") return { data: null, error: null };
    throw new Error(`unexpected rpc ${name}`);
  },
  platformSecretRpc: async () => ({ data: "managed-token", error: null }),
}));
vi.mock("@/services/connectors/core/token", () => ({
  getConnectorToken: async () => null,
  forceRefreshConnector: async () => null,
  markConnectorTokenRevoked: async () => undefined,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/decisions/ad-changes", () => ({ readOutsideChanges: async () => [], changeDaily: () => null }));

const campaignOf = (id: string, group: string, name: string) => ({
  id: Number(id),
  account: MANAGED_URN,
  name,
  status: "ACTIVE",
  campaignGroup: `urn:li:sponsoredCampaignGroup:${group}`,
  objectiveType: "LEAD_GENERATION",
  dailyBudget: { amount: "10", currencyCode: "USD" },
  runSchedule: { start: STAMP },
  changeAuditStamps: { created: { time: STAMP }, lastModified: { time: STAMP } },
});
const LINKEDIN: Record<string, Row> = {
  [`adAccounts/${MANAGED}`]: { id: Number(MANAGED), name: "Zavi managed", currency: "USD", status: "ACTIVE", servingStatuses: ["RUNNABLE"] },
  [`adAccounts/${MANAGED}/adCampaigns/${CAMPAIGN_A}`]: campaignOf(CAMPAIGN_A, GROUP_A, "A's campaign"),
  [`adAccounts/${MANAGED}/adCampaigns/${CAMPAIGN_B}`]: campaignOf(CAMPAIGN_B, GROUP_B, "B's secret campaign"),
  [`adAccounts/${MANAGED}/adCampaignGroups/${GROUP_A}`]: { id: Number(GROUP_A), name: "A's group", status: "ACTIVE", changeAuditStamps: { lastModified: { time: STAMP } } },
  [`adAccounts/${MANAGED}/adCampaignGroups/${GROUP_B}`]: { id: Number(GROUP_B), name: "B's secret group", status: "ACTIVE", changeAuditStamps: { lastModified: { time: STAMP } } },
};
const creatives = [
  { id: `urn:li:sponsoredCreative:${AD_A}`, name: "A's ad", campaign: `urn:li:sponsoredCampaign:${CAMPAIGN_A}`, intendedStatus: "ACTIVE", isServing: true, servingHoldReasons: [], review: { status: "APPROVED" }, createdAt: STAMP, lastModifiedAt: STAMP },
  { id: `urn:li:sponsoredCreative:${AD_B}`, name: "B's secret ad", campaign: `urn:li:sponsoredCampaign:${CAMPAIGN_B}`, intendedStatus: "ACTIVE", isServing: true, servingHoldReasons: [], review: { status: "APPROVED" }, createdAt: STAMP, lastModifiedAt: STAMP },
];
const analyticsRow = (pivot: string, spend: number) => ({ pivotValues: [pivot], impressions: 1000, clicks: 10, costInLocalCurrency: String(spend), externalWebsiteConversions: 1, oneClickLeads: 1, conversionValueInLocalCurrency: { amount: "5", currencyCode: "USD" }, approximateMemberReach: 500 });
const dailyRow = (pivot: string, spend: number) => ({ ...analyticsRow(pivot, spend), dateRange: { start: { year: 2026, month: 11, day: 3 }, end: { year: 2026, month: 11, day: 3 } } });

vi.mock("@/services/connectors/linkedin-ads/http", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  linkedinAdsGet: async (token: string, path: string, params: Row = {}) => {
    m.calls.push({ token, path, params });
    const { ExpectedToolError } = await import("@/services/tools/types");
    if (token !== "managed-token") throw new ExpectedToolError("linkedin_ads_unauthorized", "bad token", { status: 401 });
    if (LINKEDIN[path]) return LINKEDIN[path];
    const wanted = (urns: unknown) => (Array.isArray(urns) ? new Set(urns.map(String)) : null);
    if (path === "adAnalytics") {
      const filter = wanted(params.campaigns);
      const all = [CAMPAIGN_A, CAMPAIGN_B].map((id) => `urn:li:sponsoredCampaign:${id}`);
      const daily = params.timeGranularity === "DAILY";
      const pivots = params.pivot === "CREATIVE" ? [AD_A, AD_B].map((id) => `urn:li:sponsoredCreative:${id}`) : all;
      const rows = pivots
        .filter((p, i) => m.noisyAnalytics || !filter || filter.has(all[i]))
        .map((p, i) => (daily ? dailyRow(p, (i + 1) * 100) : analyticsRow(p, (i + 1) * 100)));
      return { elements: rows, paging: { total: rows.length } };
    }
    if (path === `adAccounts/${MANAGED}/creatives`) {
      const filter = wanted(params.campaigns);
      return { elements: creatives.filter((c) => !filter || filter.has(c.campaign)), metadata: {} };
    }
    if (path === `adAccounts/${MANAGED}/adCampaignGroups` || path === `adAccounts/${MANAGED}/adCampaigns`) {
      return { elements: Object.values(LINKEDIN).filter((o) => (path.endsWith("Groups") ? "changeAuditStamps" in o && !("campaignGroup" in o) && String(o.id).length === 2 : "campaignGroup" in o)), metadata: {} };
    }
    throw new ExpectedToolError("linkedin_ads_not_found", `no fake for ${path}`, { status: 404 });
  },
}));

import { linkedinAdsListCampaignsTool } from "../list_campaigns";
import { linkedinAdsListCampaignGroupsTool } from "../list_campaign_groups";
import { linkedinAdsReadAnalyticsTool } from "../read_analytics";
import { linkedinAdsDailySeriesTool } from "../daily_series";
import { linkedinAdsListAdsTool } from "../list_ads";
import { linkedinAdsRecentChangesTool } from "../recent_changes";
import { linkedinAdsListAccountsTool } from "../list_accounts";
import { readLinkedInPauseBody } from "../propose_pause_campaign";
import { readOwnCampaignTarget } from "../write/_own-target";
import { linkedinAccountAccess } from "../_wallet";

const ctx = (tenant_id: string) => ({ tenant_id, log: () => undefined }) as never;
const accountBinding = (tenant_id: string, id: string) => ({
  id,
  tenant_id,
  account_id: `acct-${id}`,
  platform: "linkedin",
  provider_account_id: MANAGED,
  currency: "USD",
  credential_source: "platform",
  credential_ref: "linkedin_ads_managed_main",
  credential_tenant_id: null,
  funding_source: "wallet",
  legacy_key: null,
});
const campaignBinding = (tenant_id: string, id: string, account_binding_id: string, provider_campaign_id: string) => ({
  id,
  tenant_id,
  account_binding_id,
  account_id: `acct-${account_binding_id}`,
  platform: "linkedin",
  provider_campaign_id,
  funding_source: "wallet",
});

const paths = () => m.calls.map((c) => c.path);
const readsOf = (fragment: string) => m.calls.filter((c) => c.path.includes(fragment));
const text = (v: unknown) => JSON.stringify(v);

beforeEach(() => {
  m.leakyFacade = false;
  m.noisyAnalytics = false;
  m.calls = [];
  m.tables = {
    ads_provider_accounts: [{ platform: "linkedin", provider_account_id: MANAGED, credential_source: "platform", credential_tenant_id: null, claim_released_at: null }],
    ads_account_binding_details: [accountBinding(A, "ab-A"), accountBinding(B, "ab-B")],
    ads_campaign_binding_details: [campaignBinding(A, "cb-A", "ab-A", CAMPAIGN_A), campaignBinding(B, "cb-B", "ab-B", CAMPAIGN_B)],
    ads_account_selections: [],
    ads_account_binding_status: [],
    ads_campaign_operations: [],
    ad_object_changes: [],
  };
});

describe("two workspaces on the one Zavi-managed LinkedIn ad account", () => {
  it("must catch: list_campaigns shows each workspace only its own campaign and never reads the other's from LinkedIn", async () => {
    const a = (await linkedinAdsListCampaignsTool.execute(ctx(A), { account_id: MANAGED })) as { campaigns: Array<{ id: string; campaign_group: { id: string; name: string } | null }> };
    expect(a.campaigns.map((c) => c.id)).toEqual([CAMPAIGN_A]);
    expect(a.campaigns[0].campaign_group).toEqual({ id: GROUP_A, name: "A's group" });
    expect(text(a)).not.toMatch(/secret|222|42/);
    expect(readsOf(`adCampaigns/${CAMPAIGN_B}`)).toHaveLength(0);
    expect(readsOf(`adCampaignGroups/${GROUP_B}`)).toHaveLength(0);
    expect(paths()).not.toContain(`adAccounts/${MANAGED}/adCampaignGroups`);
    expect(paths()).not.toContain(`adAccounts/${MANAGED}/adCampaigns`);
    expect(readsOf("creatives").every((c) => text(c.params.campaigns) === text([`urn:li:sponsoredCampaign:${CAMPAIGN_A}`]))).toBe(true);
    m.calls = [];
    const b = (await linkedinAdsListCampaignsTool.execute(ctx(B), { account_id: MANAGED })) as { campaigns: Array<{ id: string }> };
    expect(b.campaigns.map((c) => c.id)).toEqual([CAMPAIGN_B]);
    expect(text(b)).not.toMatch(/A's/);
    expect(readsOf(`adCampaigns/${CAMPAIGN_A}`)).toHaveLength(0);
  });

  it("must catch: campaign groups are read by this workspace's group ids only, never the whole shared account", async () => {
    const out = (await linkedinAdsListCampaignGroupsTool.execute(ctx(A), { account_id: MANAGED })) as { campaign_groups: Array<{ id: string; name: string }> };
    expect(out.campaign_groups.map((g) => [g.id, g.name])).toEqual([[GROUP_A, "A's group"]]);
    expect(text(out)).not.toMatch(/secret/);
    expect(paths()).not.toContain(`adAccounts/${MANAGED}/adCampaignGroups`);
    expect(readsOf("adCampaignGroups/").map((c) => c.path)).toEqual([`adAccounts/${MANAGED}/adCampaignGroups/${GROUP_A}`]);
  });

  it("must catch: analytics asks LinkedIn only for this workspace's campaigns and drops any foreign row LinkedIn returns anyway", async () => {
    m.noisyAnalytics = true;
    const out = (await linkedinAdsReadAnalyticsTool.execute(ctx(A), { account_id: MANAGED, pivot: "CAMPAIGN", lookback_days: 7 })) as { rows: Array<{ pivot: string | null; spend: number }> };
    expect(out.rows.map((r) => r.pivot)).toEqual([`urn:li:sponsoredCampaign:${CAMPAIGN_A}`]);
    expect(out.rows[0].spend).toBe(100);
    const analytics = readsOf("adAnalytics");
    expect(analytics.length).toBeGreaterThan(0);
    expect(analytics.every((c) => text(c.params.campaigns) === text([`urn:li:sponsoredCampaign:${CAMPAIGN_A}`]))).toBe(true);
  });

  it("must catch: the daily series and the ad list scoped to the other workspace's group or campaign come back empty without a LinkedIn read for it", async () => {
    const days = (await linkedinAdsDailySeriesTool.execute(ctx(A), { account_id: MANAGED, level: "campaign_group", campaign_group_id: GROUP_B, lookback_days: 7 })) as { rows: unknown[] };
    expect(days.rows).toEqual([]);
    expect(readsOf("adAnalytics").every((c) => text(c.params.campaigns) === text([`urn:li:sponsoredCampaign:${CAMPAIGN_A}`]))).toBe(true);
    m.calls = [];
    const ads = (await linkedinAdsListAdsTool.execute(ctx(A), { account_id: MANAGED, campaign_id: CAMPAIGN_B, recent_days: 7 })) as { ads: unknown[]; campaigns: unknown[] };
    expect(ads.ads).toEqual([]);
    expect(ads.campaigns).toEqual([]);
    expect(readsOf("creatives")).toHaveLength(0);
    expect(readsOf("adAnalytics")).toHaveLength(0);
    m.calls = [];
    const own = (await linkedinAdsListAdsTool.execute(ctx(A), { account_id: MANAGED, campaign_group_id: GROUP_A, recent_days: 7 })) as { ads: Array<{ ad_id: string; name: string | null }> };
    expect(own.ads.map((a) => a.ad_id)).toEqual([AD_A]);
    expect(text(own)).not.toMatch(/secret/);
    expect(readsOf("creatives").every((c) => text(c.params.campaigns) === text([`urn:li:sponsoredCampaign:${CAMPAIGN_A}`]))).toBe(true);
  });

  it("must catch: recent_changes lists only this workspace's group, campaign and ad", async () => {
    const out = (await linkedinAdsRecentChangesTool.execute(ctx(B), { account_id: MANAGED, day: "2026-11-04" })) as { objects: Array<{ level: string; id: string }> };
    expect(out.objects.map((o) => `${o.level}:${o.id}`)).toEqual([`campaign_group:${GROUP_B}`, `campaign:${CAMPAIGN_B}`, `ad:${AD_B}`]);
    expect(text(out)).not.toMatch(/A's/);
    expect(readsOf(`adCampaignGroups/${GROUP_A}`)).toHaveLength(0);
    expect(paths()).not.toContain(`adAccounts/${MANAGED}/adCampaignGroups`);
  });

  it("must catch: a pause card, a write proposal or any own-login tool aimed at the other workspace's managed campaign is refused before LinkedIn is read", async () => {
    await expect(readLinkedInPauseBody(A, { campaign_id: CAMPAIGN_B, account_id: MANAGED, rationale: "stop B" })).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    await expect(readOwnCampaignTarget(A, { campaign_id: CAMPAIGN_B, account_id: MANAGED }, "x")).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    await expect(readOwnCampaignTarget(A, { campaign_id: CAMPAIGN_A, account_id: MANAGED }, "x")).rejects.toMatchObject({ code: "linkedin_ads_wallet_campaign" });
    expect(readsOf("adCampaigns/")).toHaveLength(0);
  });

  it("must catch: a workspace with no campaign on the managed account cannot read it at all", async () => {
    m.tables.ads_campaign_binding_details = m.tables.ads_campaign_binding_details.filter((r) => r.tenant_id !== A);
    await expect(linkedinAccountAccess(A, MANAGED)).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    await expect(linkedinAdsListCampaignsTool.execute(ctx(A), { account_id: MANAGED })).rejects.toMatchObject({ code: "linkedin_ads_account_not_in_use" });
    const accounts = (await linkedinAdsListAccountsTool.execute(ctx(A), {}).catch((e: { code: string }) => e)) as { accounts?: unknown[]; code?: string };
    expect(text(accounts)).not.toContain(MANAGED);
    expect(m.calls).toHaveLength(0);
  });

  it("must catch: even if the database facade stopped filtering by tenant, A either sees only its own campaign or is refused, and B's campaign is never read", async () => {
    m.leakyFacade = true;
    m.tables.ads_campaign_binding_details = [campaignBinding(B, "cb-0B", "ab-B", CAMPAIGN_B), campaignBinding(A, "cb-A", "ab-A", CAMPAIGN_A)];
    m.tables.ads_account_binding_details = [accountBinding(B, "ab-B"), accountBinding(A, "ab-A")];
    const a = (await linkedinAdsListCampaignsTool.execute(ctx(A), { account_id: MANAGED }).catch((e: unknown) => e)) as { campaigns?: Array<{ id: string }> };
    if (a.campaigns) expect(a.campaigns.map((c) => c.id)).toEqual([CAMPAIGN_A]);
    expect(text(a)).not.toMatch(/secret|222/);
    expect(readsOf(`adCampaigns/${CAMPAIGN_B}`)).toHaveLength(0);
    expect(readsOf(`adCampaignGroups/${GROUP_B}`)).toHaveLength(0);
    const access = await linkedinAccountAccess(A, MANAGED).catch(() => null);
    const urns = access?.kind === "wallet" ? access.campaignUrns : [];
    expect(urns).not.toContain(`urn:li:sponsoredCampaign:${CAMPAIGN_B}`);
  });
});
