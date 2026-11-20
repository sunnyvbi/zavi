
import type { AccountRead, LedgerSpend } from "@/services/decisions/ad-budget-reconcile";
import {
  DailySpend,
  campaignIdleSince,
  dayChunks,
  ledgerConnected,
  onOffStatus,
  spendAmount,
  zoneDate,
} from "@/services/connectors/core/budget-ledger";
import {
  listEveryLinkedInAdAccountRaw,
  listEveryLinkedInCampaign,
  readLinkedInAdAnalytics,
  withLinkedInAdsToken,
} from "./client";
import { LINKEDIN_ADS_SLUG } from "./constants";
import { linkedinAdsGet, type LinkedInPage } from "./http";
import { ExpectedToolError } from "@/services/tools/types";
import { AdAccountLostError, classifyAdReadError } from "@/services/connectors/core/read-error-kind";
import { readManagedLinkedinLedger } from "@/services/ads-wallet/linkedin-ledger";
import { asTenantId, globalClient, tenantClient } from "@/services/tenant-client";
import { adsFx, adsUsd } from "@/services/ads-wallet/fx";

const LABEL = "LinkedIn Ads";
export const MANAGED_LINKEDIN_READ_DOWN = "Zavi could not read the LinkedIn campaigns it runs for you from its own LinkedIn account. This is on Zavi's side and Zavi is fixing it; there is nothing for you to connect or change.";
const ELEMENT_CAP = 15_000;
const CHUNK_DAYS = 7;

type Row = {
  dateRange?: { start?: { year?: number; month?: number; day?: number } };
  pivotValues?: string[];
  costInLocalCurrency?: string | null;
};

const RECORDED_PAGE = 1000;
const RECORDED_MAX_PAGES = 100;
const LOST_LOOKBACK_DAYS = 7;
const LEDGER_CAMPAIGN_CAP = 5000;
const STOPPED_LEDGER_STATUSES = new Set(["PAUSED", "ARCHIVED", "CANCELED", "COMPLETED", "REMOVED", "PENDING_DELETION", "DRAFT"]);
const daysBefore = (ymd: string, days: number) => new Date(Date.parse(ymd) - days * 86_400_000).toISOString().slice(0, 10);

async function recordedSpend(tenantId: string, start: Date, read: Set<string>, now: Date): Promise<{ outside: Map<string, LedgerSpend[]>; spentInRead: Set<string>; lastSpentOutside: Map<string, string> }> {
  const since = start.toISOString().slice(0, 10);
  const [y, m] = since.split("-").map(Number);
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const lookback = daysBefore(zoneDate(now), LOST_LOOKBACK_DAYS);
  const outside = new Map<string, LedgerSpend[]>();
  const spentInRead = new Set<string>();
  const lastSpentOutside = new Map<string, string>();
  for (let page = 0; ; page++) {
    if (page >= RECORDED_MAX_PAGES) throw new Error(`${LABEL} recorded spend is larger than one read covers; spend is unknown.`);
    const { data, error } = await tenantClient(asTenantId(tenantId))
      .from("ad_spend_daily")
      .select("account_id,object_id,spend_date,amount_usd,provisional")
      .eq("platform", "linkedin")
      .eq("source", "api")
      .gte("spend_date", lookback < since ? lookback : since)
      .lt("spend_date", nextMonth)
      .gt("amount_usd", 0)
      .order("id", { ascending: true })
      .range(page * RECORDED_PAGE, (page + 1) * RECORDED_PAGE - 1);
    if (error || !data) throw new Error(`${LABEL} recorded spend is unreadable; spend is unknown.`);
    const rows = data as Array<{ account_id: string | null; object_id: string; spend_date: string; amount_usd: number | string; provisional?: boolean | null }>;
    for (const r of rows) {
      if (!r.account_id) continue;
      if (!read.has(r.account_id) && r.spend_date > (lastSpentOutside.get(r.account_id) ?? "")) lastSpentOutside.set(r.account_id, r.spend_date);
      if (r.spend_date < since) continue;
      if (read.has(r.account_id)) {
        spentInRead.add(r.account_id);
        continue;
      }
      const list = outside.get(r.account_id) ?? [];
      list.push({ object_id: r.object_id, spend_date: r.spend_date, amount_usd: Number(r.amount_usd), provisional: r.provisional === true });
      outside.set(r.account_id, list);
    }
    if (rows.length < RECORDED_PAGE) return { outside, spentInRead, lastSpentOutside };
  }
}

async function lostAccountsThatMayStillSpend(tenantId: string, lost: string[], lastSpent: Map<string, string>, provenStopped: Set<string>, now: Date): Promise<string[]> {
  if (!lost.length) return [];
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("ad_campaigns")
    .select("account_id,object_id,status")
    .eq("platform", "linkedin")
    .in("account_id", lost)
    .range(0, LEDGER_CAMPAIGN_CAP - 1);
  if (error || !data || data.length === LEDGER_CAMPAIGN_CAP)
    throw new Error(`${LABEL} cannot see an ad account, and what its campaigns were last doing is unreadable; spend is unknown.`);
  const campaigns = data as Array<{ account_id: string; object_id: string; status: string | null }>;
  const today = zoneDate(now);
  return lost.filter((id) => {
    const own = campaigns.filter((c) => c.account_id === id);
    const couldServe = own.some((c) => !provenStopped.has(c.object_id) && !STOPPED_LEDGER_STATUSES.has(String(c.status ?? "").toUpperCase()));
    const floor = daysBefore(today, own.length ? 1 : LOST_LOOKBACK_DAYS);
    return couldServe || (lastSpent.get(id) ?? "") >= floor;
  });
}

async function budgetDayFloor(tenantId: string, now: Date): Promise<string> {
  const { data, error } = await tenantClient(asTenantId(tenantId)).from("tenants").select("timezone").maybeSingle();
  if (error) throw new Error(`${LABEL} budget day is unknown, so its holds cannot be judged; spend is unknown.`);
  const utc = zoneDate(now);
  const local = zoneDate(now, (data as { timezone?: string | null } | null)?.timezone);
  return local < utc ? local : utc;
}

async function anyLiveZaviCampaign(tenantId: string, bindingIds: string[], now: Date): Promise<boolean> {
  const db = tenantClient(asTenantId(tenantId));
  const [ops, stops] = await Promise.all([
    db
      .from("ads_campaign_operations")
      .select("campaign_binding_id,status,updated_at,end_time:payload->>end_time")
      .eq("kind", "activate")
      .in("campaign_binding_id", bindingIds)
      .range(0, 4999),
    db
      .from("ads_campaign_lifecycle")
      .select("campaign_binding_id,stop_requested_at,stop_confirmed_at")
      .in("campaign_binding_id", bindingIds)
      .range(0, 999),
  ]);
  if (ops.error || stops.error || !ops.data || !stops.data || ops.data.length === 5000 || stops.data.length === 1000)
    throw new Error(`${LABEL} cannot see an ad account that ran Zavi campaigns, and whether they still run is unreadable; spend is unknown.`);
  const at = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);
  const latest = new Map<string, { updated_at: unknown; end_time: unknown }>();
  for (const op of ops.data as Array<{ campaign_binding_id: string; status: string; updated_at: unknown; end_time: unknown }>) {
    if (op.status === "refused") continue;
    const seen = latest.get(op.campaign_binding_id);
    if (!seen || !(at(op.updated_at) <= at(seen.updated_at))) latest.set(op.campaign_binding_id, op);
  }
  const lifecycle = new Map((stops.data as Array<{ campaign_binding_id: string; stop_requested_at: unknown; stop_confirmed_at: unknown }>).map((l) => [l.campaign_binding_id, l]));
  return [...latest].some(([id, op]) => {
    const end = op.end_time == null ? NaN : Number(op.end_time);
    if (end <= now.getTime()) return false;
    const stop = lifecycle.get(id);
    const confirmed = at(stop?.stop_confirmed_at);
    return !(confirmed >= at(stop?.stop_requested_at) && confirmed >= at(op.updated_at));
  });
}

const pad = (n: number) => String(n).padStart(2, "0");
const parts = (ymd: string) => {
  const [year, month, day] = ymd.split("-").map(Number);
  return { year, month, day };
};

export async function readLinkedinAccountsForBudget(
  tenantId: string,
  start: Date,
  now = new Date(),
): Promise<AccountRead[]> {
  const managed = await readManagedLinkedinLedger(tenantId, start, now).catch((e: unknown) => {
    if (classifyAdReadError(e) !== "auth") throw e;
    throw new ExpectedToolError("linkedin_ads_managed_unavailable", MANAGED_LINKEDIN_READ_DOWN);
  });
  if (!(await ledgerConnected(tenantId, LINKEDIN_ADS_SLUG, LABEL)))
    return managed;
  const { token, accounts: visible } = await withLinkedInAdsToken(tenantId, async (t) => ({ token: t, accounts: await listEveryLinkedInAdAccountRaw(t) }));
  const reads: AccountRead[] = [...managed];
  const bindings = await tenantClient(asTenantId(tenantId))
    .from("ads_campaign_binding_details")
    .select("id,provider_campaign_id,account_binding_id")
    .eq("platform", "linkedin")
    .eq("funding_source", "provider")
    .range(0, 999);
  const boundAccounts = await tenantClient(asTenantId(tenantId))
    .from("ads_account_binding_details")
    .select("id,provider_account_id,funding_source")
    .eq("platform", "linkedin")
    .range(0, 999);
  const statuses = await tenantClient(asTenantId(tenantId))
    .from("ads_account_binding_status")
    .select("account_binding_id,disabled_at")
    .range(0, 999);
  if (
    bindings.error ||
    boundAccounts.error ||
    statuses.error ||
    !bindings.data ||
    !boundAccounts.data ||
    !statuses.data ||
    bindings.data.length === 1000 ||
    boundAccounts.data.length === 1000 ||
    statuses.data.length === 1000
  )
    throw new Error("LinkedIn campaign identities are unavailable");
  const accountRows = boundAccounts.data as Array<{ id: string; provider_account_id: string; funding_source: string }>;
  const ids = new Map(accountRows.map((a) => [a.id, a.provider_account_id]));
  const disabled = new Set(
    (statuses.data as Array<{ account_binding_id: string; disabled_at: string | null }>)
      .filter((r) => r.disabled_at)
      .map((r) => r.account_binding_id),
  );
  const withCampaigns = new Set((bindings.data as Array<{ account_binding_id: string }>).map((c) => c.account_binding_id));
  const customer = accountRows.filter((a) => a.funding_source === "provider" && a.provider_account_id);
  const counted = new Set(
    customer.filter((a) => !disabled.has(a.id) || withCampaigns.has(a.id)).map((a) => a.provider_account_id),
  );
  const managedIds = new Set(managed.map((a) => a.account_id));
  const claims = counted.size
    ? await globalClient()
        .from("ads_provider_accounts")
        .select("provider_account_id,credential_source,credential_tenant_id")
        .eq("platform", "linkedin")
        .in("provider_account_id", [...counted])
        .range(0, 999)
    : { data: [], error: null };
  if (claims.error || !claims.data || claims.data.length === 1000)
    throw new Error(`${LABEL} account owners are unreadable; spend is unknown.`);
  const elsewhere = new Set(
    (claims.data as Array<{ provider_account_id: string | null; credential_source: string; credential_tenant_id: string | null }>)
      .filter((c) => c.credential_source !== "tenant_connector" || c.credential_tenant_id !== tenantId)
      .flatMap((c) => (c.provider_account_id ? [c.provider_account_id] : [])),
  );
  const accounts = visible.filter((a) => counted.has(a.id) && (managedIds.has(a.id) || !elsewhere.has(a.id)));
  const unseen = customer.filter((a) => withCampaigns.has(a.id) && !accounts.some((v) => v.id === a.provider_account_id));
  const readIds = new Set([...managedIds, ...accounts.map((a) => a.id)]);
  const { outside: recorded, spentInRead, lastSpentOutside } = await recordedSpend(tenantId, start, readIds, now);
  const unreadObjects = [
    ...(bindings.data as Array<{ id: string; provider_campaign_id: string; account_binding_id: string }>)
      .filter((c) => unseen.some((a) => a.id === c.account_binding_id))
      .flatMap((c) => [c.id, c.provider_campaign_id]),
    ...[...recorded.values()].flatMap((rows) => rows.map((r) => r.object_id)),
  ];
  if (unreadObjects.length) {
    const holds = await tenantClient(asTenantId(tenantId))
      .from("ad_budget_reservations")
      .select("object_id,ends_on")
      .eq("platform", "linkedin")
      .in("status", ["reserved", "committed"])
      .in("object_id", [...new Set(unreadObjects)])
      .range(0, 999);
    if (holds.error || !holds.data || holds.data.length === 1000)
      throw new Error(`${LABEL} cannot see an ad account that ran Zavi campaigns, and its budget holds are unreadable; spend is unknown.`);
    const held = holds.data as Array<{ ends_on: string | null }>;
    const dayFloor = held.length ? await budgetDayFloor(tenantId, now) : "";
    if (held.some((h) => !h.ends_on || h.ends_on >= dayFloor))
      throw new AdAccountLostError(`${LABEL} cannot see an ad account that runs Zavi campaigns; spend is unknown.`);
  }
  const unseenCampaigns = (bindings.data as Array<{ id: string; account_binding_id: string }>)
    .filter((c) => unseen.some((a) => a.id === c.account_binding_id))
    .map((c) => c.id);
  if (unseenCampaigns.length && (await anyLiveZaviCampaign(tenantId, unseenCampaigns, now)))
    throw new AdAccountLostError(`${LABEL} cannot see an ad account that runs Zavi campaigns; spend is unknown.`);
  const lost = [...counted].filter((id) => !readIds.has(id) && !elsewhere.has(id));
  if ((await lostAccountsThatMayStillSpend(tenantId, lost, lastSpentOutside, new Set(unseenCampaigns), now)).length)
    throw new AdAccountLostError(`${LABEL} cannot see an ad account that may still be spending; spend is unknown.`);
  if (unseen.length)
    console.warn(
      `[linkedin-budget-ledger] tenant ${tenantId}: ad account ${unseen.map((a) => a.provider_account_id).join(", ")} is not visible to this LinkedIn login and holds no live Zavi budget; left out of this read, its recorded spend this month stays counted by the reconcile.`,
    );
  const bound = new Map(
    (
      bindings.data as Array<{
        id: string;
        provider_campaign_id: string;
        account_binding_id: string;
      }>
    ).map((c) => [
      `${ids.get(c.account_binding_id)}:${c.provider_campaign_id}`,
      c.id,
    ]),
  );
  for (const acct of accounts) {
    const fx = await adsFx(acct.currency ?? "UNKNOWN");
    if (managed.some((a) => a.account_id === acct.id))
      throw new Error("Managed and customer LinkedIn accounts overlap");
    const identity = (raw: string) => bound.get(`${acct.id}:${raw}`) ?? raw;
    const window = {
      since: start.toISOString().slice(0, 10),
      until: zoneDate(now),
    };
    const campaigns = await listEveryLinkedInCampaign(tenantId, acct.id);
    const spend = new DailySpend();
    let dailySum = 0;
    let dailyRows = 0;
    const neverChanged = (c: (typeof campaigns)[number]) => c.status === "PAUSED" && !!c.created_at && c.created_at === c.last_modified_at;
    const windowStart = `${window.since}T00:00:00Z`;
    const endedBeforeWindow = (c: (typeof campaigns)[number]) => !!c.schedule_end_at && Date.parse(c.schedule_end_at) <= Date.parse(windowStart);
    const couldServe = campaigns.some((c) => !neverChanged(c) && !endedBeforeWindow(c) && !campaignIdleSince(c.status, c.last_modified_at, windowStart, ["PAUSED", "ARCHIVED", "CANCELED"]));
    const readTotal = () => readLinkedInAdAnalytics(tenantId, acct.id, { pivot: "ACCOUNT", start: parts(window.since), end: parts(window.until), fresh: true }).then(([row]) => row, (e) => {
      if (e instanceof ExpectedToolError && e.code === "linkedin_ads_bad_response") throw new Error(`${LABEL} analytics returned no elements; spend is unknown.`);
      throw e;
    });
    const idleTotal = window.since <= window.until && !couldServe ? await readTotal() : undefined;
    if (window.since <= window.until && (couldServe || idleTotal))
      for (const chunk of dayChunks(window.since, window.until, CHUNK_DAYS)) {
        const page = await linkedinAdsGet<LinkedInPage<Row>>(
          token,
          "adAnalytics",
          {
            q: "analytics",
            pivot: "CAMPAIGN",
            timeGranularity: "DAILY",
            dateRange: { start: parts(chunk.since), end: parts(chunk.until) },
            accounts: [`urn:li:sponsoredAccount:${acct.id}`],
          },
          { fields: "dateRange,pivotValues,costInLocalCurrency" },
          { fresh: true },
        );
        if (!Array.isArray(page.elements))
          throw new Error(
            `${LABEL} analytics returned no elements; spend is unknown.`,
          );
        if (page.elements.length >= ELEMENT_CAP)
          throw new Error(
            `${LABEL} analytics hit its element cap; spend is unknown.`,
          );
        for (const r of page.elements) {
          const s = r.dateRange?.start;
          const urn = r.pivotValues?.[0];
          if (!s?.year || !s.month || !s.day || !urn)
            throw new Error(
              `${LABEL} analytics row has no day or campaign; spend is unknown.`,
            );
          dailyRows++;
          if (r.costInLocalCurrency == null) continue;
          const amount = spendAmount(LABEL, r.costInLocalCurrency);
          dailySum += amount;
          spend.add(
            identity(urn.replace(/^urn:li:sponsoredCampaign:/, "")),
            `${s.year}-${pad(s.month)}-${pad(s.day)}`,
            amount,
          );
        }
      }
    if (window.since <= window.until) {
      const total = couldServe ? await readTotal() : idleTotal;
      if ((total && total.missing_metrics?.includes("spend")) || (!total && (dailyRows > 0 || couldServe || spentInRead.has(acct.id))))
        throw new Error(`${LABEL} period spend is missing; spend is unknown.`);
      const periodTotal = total ? spendAmount(LABEL, total.spend) : 0;
      spend.add(
        `account_${acct.id}`,
        window.since,
        Math.max(0, Math.round((periodTotal - dailySum) * 100) / 100),
      );
    }
    reads.push({
      platform: "linkedin",
      account_id: acct.id,
      window,
      campaigns: campaigns.map((c) => ({
        object_id: identity(c.id),
        level: "campaign" as const,
        campaign_id: identity(c.id),
        name: c.name,
        budget_kind: c.budget == null ? ("none" as const) : c.budget.kind,
        budget_usd:
          c.budget?.amount == null ? null : adsUsd(c.budget.amount, fx),
        status: onOffStatus(
          c.status === "ACTIVE" ? true : c.status === "PAUSED" ? false : null,
          c.status,
        ),
        currency: "USD",
      })),
      spend: spend
        .toRows(window.until, 1)
        .map((r) => ({ ...r, amount_usd: adsUsd(r.amount_usd, fx) })),
    });
  }
  for (const [account_id, spend] of recorded) {
    console.warn(`[linkedin-budget-ledger] tenant ${tenantId}: ad account ${account_id} is no longer read; its recorded spend this month stays counted.`);
    reads.push({
      platform: "linkedin",
      account_id,
      recorded_only: true,
      window: { since: start.toISOString().slice(0, 10), until: zoneDate(now) },
      campaigns: [],
      spend,
    });
  }
  return reads;
}
