
import { adWindowFor } from "@/services/connectors/core/ad-metrics";
import {
  listLinkedInAdAccounts,
  listLinkedInCampaignGroups,
  readLinkedInCampaignGroupsByIdWithToken,
  listLinkedInCampaigns,
  readLinkedInAdAnalytics,
  readLinkedInAdAnalyticsWithToken,
  readLinkedInCreatives,
  readLinkedInCreativesWithToken,
  type AdAnalyticsRow,
  type LinkedInAdState,
  type LinkedInCampaignGroup,
  type LinkedInCreative,
} from "@/services/connectors/linkedin-ads/client";
import { createHash } from "node:crypto";
import { adDelivery, adStatesByCampaign, type AdDelivery } from "@/services/connectors/linkedin-ads/ad-delivery";
import { LINKEDIN_ADS_SLUG } from "@/services/connectors/linkedin-ads/constants";
import { LINKEDIN_ADS_DAILY_LIMIT } from "@/services/connectors/linkedin-ads/http";
import type { AdAccount } from "@/services/connectors/core/ads-shapes";
import { goneLinkedinCampaignDates, linkedinCampaign } from "@/services/ads-wallet/adapters/linkedin";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { ownLinkedinAccountSet } from "@/services/connectors/linkedin-ads/own-accounts";
import { ownCampaignGroupIds } from "@/services/tools/linkedin-ads/_groups";
import { linkedinManagerLink } from "@/services/tools/linkedin-ads/_change-bodies";
import { ExpectedToolError } from "@/services/tools/types";
import type { DashboardBuilder, DashboardContext } from "./_contract";

export { adDelivery, type AdDelivery };

export const LINKEDIN_RANGES = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "14d", label: "Last 14 days", days: 14 },
  { id: "30d", label: "Last 30 days", days: 30 },
] as const;
const DEFAULT_DAYS = 30;
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; payload: LinkedinAdsPayload }>();

export type LinkedinTotals = {
  spend: number | null;
  impressions: number;
  clicks: number;
  conversions: number;
  leads: number;
  conversion_value: number | null;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
};

export type LinkedinCampaignGroupRef = { id: string; name: string };

export type LinkedinCampaign = {
  id: string;
  ad_account_id: string | null;
  funding_source: "wallet" | "provider";
  currency: string | null;
  name: string;
  status: string;
  campaign_group: LinkedinCampaignGroupRef | null;
  daily_budget: number | null;
  ad_delivery: AdDelivery | null;
  ads_not_running: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  leads: number;
  conversion_value: number | null;
  cpa: number | null;
  url: string | null;
};

export type LinkedinAccountError = { id: string; name: string; reason: string };

export type LinkedinOtherCampaigns = {
  kind: "ended" | "removed";
  name: string;
  currency: string | null;
  spend: number;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  leads: number | null;
  conversion_value: number | null;
  cpa: number | null;
};

export type LinkedinGroupRow = {
  id: string;
  ad_account_id: string;
  name: string;
  status: string | null;
  total_budget: { amount: number; currency: string } | null;
  run_end_at: string | null;
  is_default: boolean;
  campaign_count: number;
};

export type LinkedinAdRow = {
  id: string;
  campaign_id: string;
  ad_account_id: string;
  name: string;
  intended_status: string | null;
  is_serving: boolean | null;
  review_status: string | null;
  hold_reasons: string[];
};

export type LinkedinAdsPayload = {
  platform: "linkedin_ads";
  connected: boolean;
  own_connected: boolean;
  error_code: string | null;
  wallet_error_code: string | null;
  wallet_offered?: boolean;
  held_elsewhere?: string[];
  own_error_code: string | null;
  account_errors: LinkedinAccountError[];
  retry_at: string | null;
  left_out_spend: { now: number; before: number };
  window_days: number;
  ranges: typeof LINKEDIN_RANGES;
  period: { from: string; to: string };
  prev_period: { from: string; to: string };
  account: {
    id: string | null;
    name: string | null;
    account_count: number;
    campaign_count: number;
    active_count: number;
    currency: string | null;
  } | null;
  totals: LinkedinTotals | null;
  prev_totals: LinkedinTotals | null;
  campaigns: LinkedinCampaign[];
  other_campaigns: LinkedinOtherCampaigns[];
  groups: LinkedinGroupRow[];
  ads: LinkedinAdRow[];
};

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;
const HIDDEN = new Set(["ARCHIVED", "CANCELED"]);
const LISTED_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "DRAFT"];

const toParts = (iso: string) => {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
};

type Sums = { spend: number; impressions: number; clicks: number; conversions: number; leads: number; conversion_value: number | null };
const ZERO: Sums = { spend: 0, impressions: 0, clicks: 0, conversions: 0, leads: 0, conversion_value: 0 };

const results = (r: AdAnalyticsRow) => r.conversions;
const addValue = (a: number | null, b: number | null | undefined) => (a === null || b === null || b === undefined ? null : a + b);
const addSums = (a: Sums, b: Sums): Sums => ({
  spend: a.spend + b.spend,
  impressions: a.impressions + b.impressions,
  clicks: a.clicks + b.clicks,
  conversions: a.conversions + b.conversions,
  leads: a.leads + b.leads,
  conversion_value: addValue(a.conversion_value, b.conversion_value),
});

function sumRows(rows: AdAnalyticsRow[]): Sums {
  return rows.reduce(
    (t, r) => ({
      spend: t.spend + r.spend,
      impressions: t.impressions + r.impressions,
      clicks: t.clicks + r.clicks,
      conversions: t.conversions + results(r),
      leads: t.leads + r.leads,
      conversion_value: addValue(t.conversion_value, r.conversion_value),
    }),
    ZERO,
  );
}

export function linkedinTotals(s: Sums): LinkedinTotals {
  return {
    spend: round2(s.spend),
    impressions: s.impressions,
    clicks: s.clicks,
    conversions: s.conversions,
    leads: s.leads,
    conversion_value: s.conversion_value === null ? null : round2(s.conversion_value),
    ctr: s.impressions > 0 ? round2((s.clicks / s.impressions) * 100) : null,
    cpc: s.clicks > 0 ? round2(s.spend / s.clicks) : null,
    cpa: s.conversions > 0 ? round2(s.spend / s.conversions) : null,
  };
}

const BLOCKED: ReadonlySet<AdDelivery> = new Set(["rejected", "in_review", "out_of_budget", "held", "no_ads"]);

const campaignIdOf = (pivot: string | null) => pivot?.split(":").pop() ?? "";

async function connectionStamp(c: DashboardContext): Promise<string | null> {
  try {
    const { data, error } = await c.sb
      .from("connector_metadata")
      .select("team_id, connected_at")
      .eq("tenant_id", c.tenantId)
      .eq("slug", LINKEDIN_ADS_SLUG)
      .maybeSingle();
    if (error) return null;
    const r = data as { team_id?: string | null; connected_at?: string | null } | null;
    return r ? `${r.team_id ?? ""}@${r.connected_at ?? ""}` : "none";
  } catch {
    return null;
  }
}

async function selectedAccount(tenantId: string): Promise<string | null> {
  try {
    const db = tenantClient(asTenantId(tenantId));
    const { data, error } = await db
      .from("ads_account_selections")
      .select("account_binding_id")
      .eq("platform", "linkedin")
      .maybeSingle();
    if (error) return null;
    const id = (data as { account_binding_id?: string | null } | null)?.account_binding_id;
    if (!id) return "none";
    const status = await db.from("ads_account_binding_status").select("disabled_at").eq("account_binding_id", id).maybeSingle();
    if (status.error) return null;
    return `${id}:${(status.data as { disabled_at?: string | null } | null)?.disabled_at ? "off" : "on"}`;
  } catch {
    return null;
  }
}

async function adChangeStamp(tenantId: string): Promise<string | null> {
  try {
    const db = tenantClient(asTenantId(tenantId));
    const [lifecycle, operations, cards] = await Promise.all([
      db
        .from("ads_campaign_lifecycle")
        .select("campaign_binding_id, activation_attempted_at, stop_requested_at, stop_confirmed_at")
        .eq("tenant_id", tenantId)
        .order("campaign_binding_id")
        .range(0, 999),
      db.from("ads_campaign_operations").select("updated_at").eq("tenant_id", tenantId).order("updated_at", { ascending: false }).range(0, 0),
      db
        .from("channel_actions")
        .select("executed_at")
        .eq("tenant_id", tenantId)
        .eq("channel_slug", LINKEDIN_ADS_SLUG)
        .order("executed_at", { ascending: false, nullsFirst: false })
        .range(0, 0),
    ]);
    if (lifecycle.error || operations.error || cards.error) return null;
    if (!Array.isArray(lifecycle.data) || lifecycle.data.length === 1000) return null;
    return createHash("sha256")
      .update(JSON.stringify([lifecycle.data, operations.data ?? [], cards.data ?? []]))
      .digest("hex")
      .slice(0, 32);
  } catch {
    return null;
  }
}

type DayRange = { start: { year: number; month: number; day: number }; end: { year: number; month: number; day: number } };
type CampaignRow = { id: string; name: string; status: string | null; campaign_group_id?: string | null; budget?: { amount: number; currency: string | null; kind: "daily" | "lifetime" } | null };
type Recorded = { now: number; before: number; leftOutNow: number; leftOutBefore: number };
type Groups = Map<string, LinkedInCampaignGroup>;
type AccountRead = { a: AdAccount; rows: CampaignRow[]; now: AdAnalyticsRow[]; before: AdAnalyticsRow[]; wallet: boolean; ads?: Map<string, LinkedInAdState[]> | null; creatives?: LinkedInCreative[]; groups?: Groups | null; recorded?: Recorded };
const GROUP_LIST_LIMIT = 500;
const groupIdOf = (urn: unknown): string | null => (typeof urn === "string" ? (/^urn:li:sponsoredCampaignGroup:(\d{1,20})$/.exec(urn)?.[1] ?? null) : null);

type AdsRead = { ads: Map<string, LinkedInAdState[]> | null; creatives: LinkedInCreative[] };

async function adsOf(rows: CampaignRow[], read: (ids: string[]) => Promise<LinkedInCreative[]>): Promise<AdsRead> {
  const creatives: LinkedInCreative[] = [];
  const ads = await adStatesByCampaign(rows, async (ids) => {
    const list = await read(ids);
    creatives.push(...list);
    return list;
  });
  return { ads, creatives: ads ? creatives : [] };
}

function groupRows(perAccount: AccountRead[], campaigns: LinkedinCampaign[]): LinkedinGroupRow[] {
  const counts = new Map<string, number>();
  for (const c of campaigns) if (c.campaign_group) counts.set(c.campaign_group.id, (counts.get(c.campaign_group.id) ?? 0) + 1);
  const out: LinkedinGroupRow[] = [];
  const seen = new Set<string>();
  for (const r of perAccount) {
    if (r.wallet || !r.groups) continue;
    for (const g of r.groups.values()) {
      const key = `${r.a.id}:${g.id}`;
      if (seen.has(key) || HIDDEN.has(g.status ?? "")) continue;
      seen.add(key);
      out.push({ id: g.id, ad_account_id: r.a.id, name: g.name, status: g.status, total_budget: g.total_budget, run_end_at: g.run_end_at, is_default: g.is_default === true, campaign_count: counts.get(g.id) ?? 0 });
    }
  }
  return out;
}

function adRows(perAccount: AccountRead[]): LinkedinAdRow[] {
  const out: LinkedinAdRow[] = [];
  for (const r of perAccount) {
    if (r.wallet) continue;
    for (const c of r.creatives ?? []) {
      if (!c.id || !c.campaign_id) continue;
      out.push({ id: c.id, campaign_id: c.campaign_id, ad_account_id: r.a.id, name: c.name ?? `Ad ${c.id}`, intended_status: c.intended_status, is_serving: c.is_serving, review_status: c.review_status, hold_reasons: c.hold_reasons });
    }
  }
  return out;
}

async function groupsOf(read: () => Promise<LinkedInCampaignGroup[]>): Promise<Groups | null> {
  try {
    const groups = await read();
    return Array.isArray(groups) ? new Map(groups.map((g) => [g.id, g])) : null;
  } catch {
    return null;
  }
}

function groupRef(campaign: CampaignRow, groups: Groups | null | undefined): LinkedinCampaignGroupRef | null {
  const id = campaign.campaign_group_id ?? null;
  const g = id === null ? undefined : groups?.get(id);
  return g && !HIDDEN.has(g.status ?? "") ? { id: g.id, name: g.name } : null;
}
type Period = { from: string; to: string };

const WALLET_ACCOUNT_NAME = "Zavi ads wallet";
const WALLET_READ_FAILED = "linkedin_ads_wallet_read_failed";
const DAILY_LIMIT = "linkedin_ads_daily_limit";
const RATE_LIMITED = "linkedin_ads_rate_limited";
const WALLET_DAILY_LIMIT = "linkedin_ads_wallet_daily_limit";
const WALLET_RATE_LIMITED = "linkedin_ads_wallet_rate_limited";
const dailyLimitHit = (e: unknown) => e instanceof ExpectedToolError && e.message === LINKEDIN_ADS_DAILY_LIMIT;
const throttled = (e: unknown) => e instanceof ExpectedToolError && !dailyLimitHit(e) && (e.code === RATE_LIMITED || e.meta?.http_status === 429);
const errorCodeOf = (e: unknown) => (dailyLimitHit(e) ? DAILY_LIMIT : throttled(e) ? RATE_LIMITED : e instanceof ExpectedToolError ? e.code : "linkedin_ads_read_failed");
const retryAtOf = (e: unknown): string | null => {
  if (!throttled(e)) return null;
  const at = (e as ExpectedToolError).meta?.retry_at;
  return typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null;
};
const latest = (times: Array<string | null | undefined>): string | null =>
  times.reduce<string | null>((max, t) => (t && (!max || Date.parse(t) > Date.parse(max)) ? t : max), null);

function waitWords(at: string): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(at) - Date.now()) / 60_000));
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}
const NOT_ACTIVE = "linkedin_ads_account_not_active";
const CLOSED = "linkedin_ads_account_closed";
const CLOSED_STATUSES = new Set(["CANCELED", "REMOVED", "PENDING_DELETION"]);

function accountErrorReason(e: unknown): string {
  const code = errorCodeOf(e);
  if (code === DAILY_LIMIT) return "LinkedIn's daily limit for reading this account is used up. Its numbers come back tomorrow.";
  if (code === "linkedin_ads_forbidden") return "LinkedIn did not let Zavi read this account. An admin of the account in LinkedIn Campaign Manager can give your LinkedIn user a role on it.";
  if (code === RATE_LIMITED) {
    const at = retryAtOf(e);
    return at ? `LinkedIn asked Zavi to slow down, so Zavi will not read this account again for ${waitWords(at)}. Try Refresh after that.` : "LinkedIn is limiting requests right now. Try Refresh in a minute.";
  }
  return "LinkedIn did not answer for this account just now. Try Refresh in a minute.";
}

const monthStartOf = (day: string) => `${day.slice(0, 7)}-01`;
const monthEndOf = (day: string) => {
  const [year, month] = day.split("-").map(Number);
  return ymd(new Date(Date.UTC(year, month, 0)));
};

async function readGoneCampaignSpend(tenantId: string, goneOn: Map<string, string>, period: Period, prevPeriod: Period): Promise<AccountRead[] | null> {
  const ids = [...goneOn.keys()];
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("ad_spend_daily")
    .select("tenant_id, account_id, object_id, spend_date, amount_usd, provisional")
    .eq("platform", "linkedin")
    .eq("source", "api")
    .in("object_id", ids)
    .gte("spend_date", monthStartOf(prevPeriod.from))
    .lte("spend_date", period.to)
    .range(0, 999);
  if (error || !Array.isArray(data) || data.length === 1000) return null;
  const byAccount = new Map<string, Recorded>();
  for (const r of data as Array<{ tenant_id: string; account_id: string | null; object_id: string; spend_date: string; amount_usd: number | string; provisional?: boolean | null }>) {
    if (r.tenant_id !== tenantId || !ids.includes(r.object_id)) continue;
    const key = r.account_id ?? WALLET_ACCOUNT_NAME;
    const sums = byAccount.get(key) ?? { now: 0, before: 0, leftOutNow: 0, leftOutBefore: 0 };
    const amount = Number(r.amount_usd);
    if (!Number.isFinite(amount)) return null;
    const monthEnd = monthEndOf(r.spend_date);
    const gone = goneOn.get(r.object_id) as string;
    const coveredTo = gone < monthEnd ? gone : monthEnd;
    const firstDay = r.spend_date;
    const lastDay = r.provisional === true && coveredTo > r.spend_date ? coveredTo : r.spend_date;
    const inside = (p: Period) => firstDay >= p.from && lastDay <= p.to;
    const overlaps = (p: Period) => firstDay <= p.to && lastDay >= p.from;
    if (inside(period)) sums.now += amount;
    else if (inside(prevPeriod)) sums.before += amount;
    else {
      if (overlaps(period)) sums.leftOutNow += amount;
      if (overlaps(prevPeriod)) sums.leftOutBefore += amount;
    }
    byAccount.set(key, sums);
  }
  return [...byAccount.entries()]
    .filter(([, sums]) => sums.now > 0 || sums.before > 0 || sums.leftOutNow > 0 || sums.leftOutBefore > 0)
    .map(([id, recorded]) => ({ a: { id, name: WALLET_ACCOUNT_NAME, currency: "USD", status: null }, rows: [], now: [], before: [], wallet: true, recorded }));
}

type WalletReads = { reads: AccountRead[]; failed: boolean; goneOnly?: boolean; dailyLimit?: boolean; rateLimited?: boolean; retryAt?: string | null };

async function readWalletCampaigns(tenantId: string, range: DayRange, prevRange: DayRange, period: Period, prevPeriod: Period): Promise<WalletReads> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_binding_details")
    .select("id, tenant_id")
    .eq("platform", "linkedin")
    .eq("funding_source", "wallet")
    .order("id")
    .range(0, 999);
  if (error || !Array.isArray(data) || data.length === 1000)
    throw new ExpectedToolError("linkedin_ads_read_failed", "Zavi-managed LinkedIn campaigns could not be read.");
  const bindings = (data as Array<{ id: string; tenant_id: string }>).filter((b) => b.tenant_id === tenantId);
  if (!bindings.length) return { reads: [], failed: false };
  const gone = await goneLinkedinCampaignDates(tenantId).catch(() => null);
  const goneOn = new Map(bindings.flatMap((b) => (gone?.has(b.id) ? [[b.id, gone.get(b.id) as string] as const] : [])));
  const recorded = goneOn.size ? await readGoneCampaignSpend(tenantId, goneOn, period, prevPeriod) : [];
  const resolved = await Promise.allSettled(bindings.filter((b) => !gone?.has(b.id)).map((b) => linkedinCampaign(tenantId, b.id)));
  type Resolved = Awaited<ReturnType<typeof linkedinCampaign>>;
  const byAccount = new Map<string, { token: string; account: Resolved["account"]; campaigns: Resolved["campaign"][] }>();
  let failed = gone === null || recorded === null;
  for (const r of resolved) {
    if (r.status === "rejected") {
      failed = true;
      continue;
    }
    const { token, account, campaign } = r.value;
    const group = byAccount.get(account.id) ?? { token, account, campaigns: [] };
    group.campaigns.push(campaign);
    byAccount.set(account.id, group);
  }
  const reads = await Promise.allSettled(
    [...byAccount.values()].map(async ({ token, account, campaigns }) => {
      const urns = [...new Set(campaigns.map((c) => `urn:li:sponsoredCampaign:${c.id}`))];
      const own = (rows: AdAnalyticsRow[]) => rows.filter((r) => r.pivot !== null && urns.includes(r.pivot));
      const rows = campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, campaign_group_id: groupIdOf((c as { campaignGroup?: unknown }).campaignGroup) }));
      const [now, before, { ads }, groups] = await Promise.all([
        readLinkedInAdAnalyticsWithToken(token, account.id, { pivot: "CAMPAIGN", campaigns: urns, value: true, ...range }).then(own),
        readLinkedInAdAnalyticsWithToken(token, account.id, { pivot: "CAMPAIGN", campaigns: urns, value: true, ...prevRange }).then(own),
        adsOf(rows, (ids) => readLinkedInCreativesWithToken(token, account.id, ids)),
        groupsOf(() => readLinkedInCampaignGroupsByIdWithToken(token, account.id, ownCampaignGroupIds(rows))),
      ]);
      return {
        a: { id: account.id, name: WALLET_ACCOUNT_NAME, currency: account.currency, status: account.status },
        rows,
        now,
        before,
        ads,
        groups,
        wallet: true,
      };
    }),
  );
  const ok = reads.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const rejected = [...resolved, ...reads].flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
  return {
    reads: [...ok, ...(recorded ?? [])],
    failed: failed || ok.length < reads.length,
    goneOnly: goneOn.size === bindings.length,
    dailyLimit: rejected.some(dailyLimitHit),
    rateLimited: rejected.some(throttled),
    retryAt: latest(rejected.map(retryAtOf)),
  };
}

type OwnReads = { reads: AccountRead[]; failed: LinkedinAccountError[]; inactive: AdAccount | null; retryAt: string | null };

async function readOwnAccounts(tenantId: string, range: DayRange, prevRange: DayRange): Promise<OwnReads | null> {
  try {
    const listed = await listLinkedInAdAccounts(tenantId);
    const { accounts, inactiveSelected } = listed.length > 0 ? await ownLinkedinAccountSet(tenantId, listed) : { accounts: [], inactiveSelected: null };
    const settled = await Promise.allSettled(
      accounts.map(async (a): Promise<AccountRead> => {
        const rows: CampaignRow[] = await listLinkedInCampaigns(tenantId, a.id, 200, LISTED_STATUSES);
        if (!rows.length && !(await listLinkedInCampaigns(tenantId, a.id, 1, [...HIDDEN])).length) return { a, rows, now: [], before: [], wallet: false };
        const [now, before, { ads, creatives }, groups] = await Promise.all([
          readLinkedInAdAnalytics(tenantId, a.id, { pivot: "CAMPAIGN", value: true, ...range }),
          readLinkedInAdAnalytics(tenantId, a.id, { pivot: "CAMPAIGN", value: true, ...prevRange }),
          adsOf(rows, (ids) => readLinkedInCreatives(tenantId, a.id, ids)),
          groupsOf(() => listLinkedInCampaignGroups(tenantId, a.id, GROUP_LIST_LIMIT)),
        ]);
        return { a, rows, now, before, ads, creatives, groups, wallet: false };
      }),
    );
    const firstFailure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (firstFailure && settled.every((r) => r.status === "rejected")) throw firstFailure.reason;
    return {
      reads: settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
      failed: settled.flatMap((r, i) => (r.status === "rejected" ? [{ id: accounts[i].id, name: accounts[i].name, reason: accountErrorReason(r.reason) }] : [])),
      inactive: inactiveSelected,
      retryAt: latest(settled.map((r) => (r.status === "rejected" ? retryAtOf(r.reason) : null))),
    };
  } catch (e) {
    if (e instanceof ExpectedToolError && e.code === "linkedin_ads_not_connected") return null;
    throw e;
  }
}

const spentIn = (rows: AdAnalyticsRow[], recorded = 0) =>
  recorded > 0 || rows.some((r) => r.spend > 0 || r.missing_metrics?.includes("spend"));

function soleCurrency(reads: AccountRead[]): string | null {
  const currencies = new Set(reads.map((r) => r.a.currency));
  return currencies.size === 1 ? [...currencies][0] : null;
}

async function walletOffered(tenantId: string): Promise<boolean> {
  try {
    const { linkedinWalletSwitchedOn } = await import("@/services/ads-wallet/accounts");
    return await linkedinWalletSwitchedOn();
  } catch {
    return false;
  }
}

async function heldElsewhereNames(tenantId: string): Promise<string[]> {
  try {
    const { customerAccountChoices } = await import("@/services/ads-wallet/accounts");
    const offered = (await customerAccountChoices(tenantId, "linkedin")).accounts as Array<{ name?: string | null; view_only?: true; held_elsewhere?: true }>;
    if (offered.some((a) => !a.held_elsewhere && !a.view_only)) return [];
    return offered.filter((a) => a.held_elsewhere && a.name).map((a) => a.name as string);
  } catch {
    return [];
  }
}

export const build: DashboardBuilder = async (c) => {
  const picked = adWindowFor(c.rangeDays ?? DEFAULT_DAYS, c.customRange);
  const { days, period, prev_period } = picked;
  const base = { platform: "linkedin_ads" as const, window_days: days, ranges: LINKEDIN_RANGES, period, prev_period };
  const empty: LinkedinAdsPayload = {
    ...base,
    connected: false,
    own_connected: false,
    error_code: null,
    wallet_error_code: null,
    own_error_code: null,
    account_errors: [],
    retry_at: null,
    left_out_spend: { now: 0, before: 0 },
    account: null,
    totals: null,
    prev_totals: null,
    campaigns: [],
    other_campaigns: [],
    groups: [],
    ads: [],
  };

  const [stamp, chosen, changes] = await Promise.all([connectionStamp(c), selectedAccount(c.tenantId), adChangeStamp(c.tenantId)]);
  const key = stamp === null || chosen === null || changes === null ? null : `${c.tenantId}:${picked.key}:${period.to}:${stamp}:${chosen}:${changes}`;
  const hit = key === null ? undefined : cache.get(key);
  if (hit && !c.refresh && !c.meteredRefresh && Date.now() - hit.at < CACHE_MS) return hit.payload;

  try {
    const range = { start: toParts(period.from), end: toParts(period.to) };
    const prevRange = { start: toParts(prev_period.from), end: toParts(prev_period.to) };
    const [ownResult, wallet] = await Promise.all([
      readOwnAccounts(c.tenantId, range, prevRange).then(
        (value) => ({ value, error: undefined as unknown }),
        (error: unknown) => ({ value: null, error }),
      ),
      readWalletCampaigns(c.tenantId, range, prevRange, period, prev_period).catch((e: unknown): WalletReads => ({ reads: [], failed: true, goneOnly: false, dailyLimit: dailyLimitHit(e), rateLimited: throttled(e), retryAt: retryAtOf(e) })),
    ]);
    const ownFailed = ownResult.error !== undefined;
    const ownReads = ownFailed ? [] : (ownResult.value?.reads ?? null);
    const ownOff = !ownFailed && ownResult.value === null;
    const inactive = ownResult.value?.inactive ?? null;
    const account_errors = ownResult.value?.failed ?? [];
    const own_error_code = ownFailed ? errorCodeOf(ownResult.error) : inactive ? (CLOSED_STATUSES.has(inactive.status ?? "") ? CLOSED : NOT_ACTIVE) : null;
    const wallet_error_code = wallet.failed ? (wallet.dailyLimit ? WALLET_DAILY_LIMIT : wallet.rateLimited ? WALLET_RATE_LIMITED : WALLET_READ_FAILED) : null;
    const retry_at = latest([
      own_error_code === RATE_LIMITED ? retryAtOf(ownResult.error) : null,
      ownResult.value?.retryAt,
      wallet_error_code === WALLET_RATE_LIMITED ? wallet.retryAt : null,
    ]);
    const perAccount = [...(ownReads ?? []), ...wallet.reads];
    if (perAccount.length === 0 && wallet.goneOnly && !wallet.failed)
      perAccount.push({ a: { id: WALLET_ACCOUNT_NAME, name: WALLET_ACCOUNT_NAME, currency: "USD", status: null }, rows: [], now: [], before: [], wallet: true });
    if (perAccount.length === 0 && ownFailed) throw ownResult.error;
    if (perAccount.length === 0 && inactive)
      return {
        ...empty,
        connected: true,
        own_connected: true,
        own_error_code,
        wallet_error_code,
        retry_at,
        account: { id: inactive.id, name: inactive.name, account_count: 1, campaign_count: 0, active_count: 0, currency: inactive.currency },
      };
    if (perAccount.length === 0)
      return { ...empty, connected: !ownOff, own_connected: !ownOff, error_code: wallet_error_code, wallet_error_code, retry_at, wallet_offered: ownOff ? undefined : await walletOffered(c.tenantId), held_elsewhere: ownOff ? undefined : await heldElsewhereNames(c.tenantId) };
    const accounts = [...new Map(perAccount.map((r) => [r.a.id, r.a])).values()];

    const own = [...new Set((ownReads ?? []).map((r) => r.a.id))];
    const spentNow = perAccount.filter((r) => spentIn(r.now, r.recorded?.now));
    const spentBefore = perAccount.filter((r) => spentIn(r.before, r.recorded?.before));
    const active = perAccount.filter((r) => r.a.status === "ACTIVE");
    const currency = soleCurrency([spentNow, spentBefore, active, perAccount].find((group) => group.length) ?? []);
    const beforeIsForeign = spentBefore.some((r) => r.a.currency !== currency);

    let cur = ZERO;
    let prev = ZERO;
    let recordedNow = 0;
    let recordedBefore = 0;
    const left_out_spend = { now: 0, before: 0 };
    const campaigns: LinkedinCampaign[] = [];
    const others = new Map<string, { kind: LinkedinOtherCampaigns["kind"]; currency: string | null; sums: Sums }>();
    const addOther = (kind: LinkedinOtherCampaigns["kind"], currency: string | null, s: Sums) => {
      if (!(s.spend > 0 || s.impressions > 0 || s.clicks > 0 || s.conversions > 0 || s.leads > 0)) return;
      const k = `${kind}:${currency ?? ""}`;
      const o = others.get(k) ?? { kind, currency, sums: ZERO };
      o.sums = addSums(o.sums, s);
      others.set(k, o);
    };
    for (const { a, rows, now, before, ads, groups, wallet, recorded } of perAccount) {
      recordedNow += recorded?.now ?? 0;
      recordedBefore += recorded?.before ?? 0;
      left_out_spend.now += recorded?.leftOutNow ?? 0;
      left_out_spend.before += recorded?.leftOutBefore ?? 0;
      if (recorded?.now) addOther("removed", a.currency, { ...ZERO, spend: recorded.now, conversion_value: null });
      const shown = new Set(rows.filter((r) => !HIDDEN.has(r.status ?? "")).map((r) => r.id));
      addOther("ended", a.currency, sumRows(now.filter((r) => !shown.has(campaignIdOf(r.pivot)))));
      const nowById = new Map(now.map((r) => [campaignIdOf(r.pivot), r]));
      const curSums = sumRows(now);
      const prevSums = sumRows(before);
      cur = addSums(cur, curSums);
      prev = addSums(prev, prevSums);
      for (const r of rows) {
        if (HIDDEN.has(r.status ?? "")) continue;
        const s = nowById.get(r.id);
        campaigns.push({
          id: r.id,
          ad_account_id: wallet ? null : a.id,
          funding_source: wallet ? "wallet" : "provider",
          currency: a.currency,
          name: r.name,
          status: r.status ?? "UNKNOWN",
          campaign_group: groupRef(r, groups),
          daily_budget: r.budget?.kind === "daily" && Number.isFinite(r.budget.amount) && r.budget.currency === a.currency ? round2(r.budget.amount) : null,
          ...(r.status === "ACTIVE" ? adDelivery(ads ? (ads.get(r.id) ?? []) : null) : { ad_delivery: null, ads_not_running: 0 }),
          spend: round2(s?.spend ?? 0),
          impressions: s?.impressions ?? 0,
          clicks: s?.clicks ?? 0,
          conversions: s ? results(s) : 0,
          leads: s?.leads ?? 0,
          conversion_value: s ? (s.conversion_value === null || s.conversion_value === undefined ? null : round2(s.conversion_value)) : 0,
          cpa: s && results(s) > 0 ? round2(s.spend / results(s)) : null,
          url: wallet ? null : linkedinManagerLink(a.id, r.id),
        });
      }
    }
    campaigns.sort((x, y) => Number(y.status === "ACTIVE") - Number(x.status === "ACTIVE") || y.spend - x.spend);
    const other_campaigns: LinkedinOtherCampaigns[] = [...others.values()].map(({ kind, currency: cur, sums }) => ({
      kind,
      name: kind === "ended" ? "Archived, canceled and older campaigns" : "Campaigns no longer in LinkedIn",
      currency: cur,
      spend: round2(sums.spend),
      impressions: kind === "ended" ? sums.impressions : null,
      clicks: kind === "ended" ? sums.clicks : null,
      conversions: kind === "ended" ? sums.conversions : null,
      leads: kind === "ended" ? sums.leads : null,
      conversion_value: kind === "ended" && sums.conversion_value !== null ? round2(sums.conversion_value) : null,
      cpa: kind === "ended" && sums.conversions > 0 ? round2(sums.spend / sums.conversions) : null,
    }));

    const payload: LinkedinAdsPayload = {
      ...base,
      connected: true,
      own_connected: !ownOff,
      error_code: null,
      wallet_error_code,
      own_error_code,
      account_errors,
      retry_at,
      left_out_spend: { now: round2(left_out_spend.now), before: round2(left_out_spend.before) },
      account: {
        id: own.length === 1 ? own[0] : null,
        name: accounts.length > 1 ? `${accounts.length} ad accounts` : (accounts[0]?.name ?? null),
        account_count: accounts.length,
        campaign_count: campaigns.length,
        active_count: campaigns.filter((x) => x.status === "ACTIVE" && !(x.ad_delivery && BLOCKED.has(x.ad_delivery))).length,
        currency,
      },
      totals: linkedinTotals({ ...cur, spend: cur.spend + recordedNow, conversion_value: recordedNow > 0 ? null : cur.conversion_value }),
      prev_totals: beforeIsForeign
        ? { ...linkedinTotals(prev), spend: null, cpc: null, cpa: null, conversion_value: null }
        : linkedinTotals({ ...prev, spend: prev.spend + recordedBefore, conversion_value: recordedBefore > 0 ? null : prev.conversion_value }),
      campaigns,
      other_campaigns,
      groups: groupRows(perAccount, campaigns),
      ads: adRows(perAccount),
    };
    const groupsUnread = perAccount.some((r) => r.groups === null && r.rows.length > 0);
    if (key !== null && !wallet_error_code && !own_error_code && !account_errors.length && !groupsUnread && !campaigns.some((x) => x.ad_delivery === "unread")) cache.set(key, { at: Date.now(), payload });
    return payload;
  } catch (e) {
    if (key !== null) cache.delete(key);
    if (e instanceof ExpectedToolError && e.code === "linkedin_ads_not_connected") return empty;
    return {
      ...empty,
      connected: true,
      own_connected: true,
      error_code: errorCodeOf(e),
      retry_at: retryAtOf(e),
    };
  }
};
