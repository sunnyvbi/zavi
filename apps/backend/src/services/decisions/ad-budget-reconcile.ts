import { readXAccountsForBudget } from "@/services/connectors/x-ads/budget-ledger";
import { readChatgptAccountsForBudget as readChatgptAccount } from "@/services/ads-wallet/chatgpt-ledger";
import { readRedditAccounts } from "@/services/connectors/reddit-ads/budget-ledger";
import { LEDGER_ONLY_READERS, type LedgerOnlyPlatform } from "@/services/decisions/ad-ledger-platforms";

import {
  asTenantId,
  fleetSweepClient,
  tenantClient,
  tenantRpc,
} from "@/services/tenant-client";
import { fetchMetaDailySeries } from "@/services/tools/meta-ads/daily_series";
import { enumerateAccountAdSets } from "@/services/tools/meta-ads/list_ad_sets";
import {
  gadsCustomerId,
  gadsGetBudgetGuardFacts,
  gadsSearch,
} from "@/services/tools/google-ads/_client";
import { accountClock } from "@/services/tools/google-ads/_read-window";
import { GOOGLE_ADS_VAULT_KEYS } from "@/services/tools/google-ads/keys";
import { getSecret } from "@/services/secrets/vault";
import {
  fbGet,
  fbGetAllPages,
  metaAdsCreds,
} from "@/services/tools/meta-ads/_client";
import { withMetaCaller } from "@/services/tools/meta-ads/_cooldown";
import {
  runBudgetBrake,
  type BrakeOutcome,
} from "@/services/decisions/ad-budget-brake";
import { renderEmail, escapeEmailHtml, oneLineName } from "@/email/theme";
import { adBudgetUrl } from "@/services/web-base";
import { logOutsideChanges } from "@/services/decisions/ad-changes";
import { resolveInflightAdHolds, resolveUnknownAdHolds, type ResolveOutcome } from "@/services/decisions/ad-hold-resolve";
import { adBudgetReadStart, syncAdHoldsToLive, type HoldUpkeep } from "@/services/decisions/ad-budget";
import { ConnectionUnknownError } from "@/services/connectors/core/budget-ledger";
import { ExpectedToolError } from "@/services/tools/types";
import { AdAccountLostError, classifyAdReadError, isRetryableAdReadKind, type AdReadErrorKind } from "@/services/connectors/core/read-error-kind";

export type ActiveBudget = {
  id: string;
  tenant_id: string;
  created_at: string;
};

export type Platform = "meta" | "google" | "chatgpt" | "reddit" | "x" | LedgerOnlyPlatform;

const CORE_PLATFORM_NAME: Record<"meta" | "google" | "chatgpt" | "reddit" | "x", string> = {
  meta: "Meta Ads", google: "Google Ads", chatgpt: "ChatGPT Ads", reddit: "Reddit Ads", x: "X Ads",
};
export function platformName(p: Platform): string {
  return (CORE_PLATFORM_NAME as Record<string, string>)[p] ?? LEDGER_ONLY_READERS.find((r) => r.platform === p)?.name ?? p;
}

export type LedgerCampaign = {
  object_id: string;
  level: "ad_set" | "campaign" | "ad_group";
  campaign_id: string | null;
  name: string | null;
  budget_kind: "daily" | "lifetime" | "none" | "campaign_level" | "shared";
  budget_usd: number | null;
  campaign_budget_usd?: number | null;
  status: string | null;
  currency: string;
};

export type LedgerSpend = {
  object_id: string;
  spend_date: string;
  amount_usd: number;
  provisional: boolean;
};

export type AccountRead = {
  platform: Platform;
  account_id: string;
  campaigns: LedgerCampaign[];
  spend: LedgerSpend[];
  window: { since: string; until: string };
  recorded_only?: boolean;
  managed?: boolean;
};

export type BudgetOutcome =
  | {
      budget_id: string;
      tenant_id: string;
      outcome: "recorded";
      actual_usd: number;
      recorded_only_accounts?: string[];
      status: string;
      alarm: "none" | "sent" | "send_failed";
      rolled: boolean;
      ledger_failed: Platform[];
      brake?: BrakeOutcome["status"];
      unknown_holds?: ResolveOutcome;
      inflight_holds?: ResolveOutcome;
      live_holds?: HoldUpkeep & { lowered?: number };
    }
  | {
      budget_id: string;
      tenant_id: string;
      outcome: "read_failed";
      brake?: BrakeOutcome["status"];
      live_holds?: HoldUpkeep & { lowered?: number };
      error: string;
      status: string;
      alarm: "none" | "sent" | "send_failed";
      rolled: boolean;
      ledger_failed: Platform[];
    }
  | { budget_id: string; tenant_id: string; outcome: "skipped"; status: string }
  | { budget_id: string; tenant_id: string; outcome: "error"; error: string };

type MonthAnswer = {
  status?: string;
  rolled?: boolean;
  month_start?: string;
  month_cap_usd?: number | string;
  monthly_usd?: number | string;
};

type RecordAnswer = {
  status?: string;
  spent_usd?: number | string;
  month_cap_usd?: number | string;
  alarm?: boolean;
};

const MAX_BUDGETS_PER_SWEEP = 500;
const HOUR_MS = 3_600_000;

export async function listActiveBudgets(): Promise<ActiveBudget[]> {
  const { data, error } = await fleetSweepClient(
    "ad-budget hourly reconcile: list active budgets",
  )
    .from("ad_budgets")
    .select("id, tenant_id, created_at")
    .eq("status", "active")
    .limit(MAX_BUDGETS_PER_SWEEP);
  if (error)
    throw new Error(
      `ad-budget-reconcile: budget list failed: ${error.message}`,
    );
  return (data ?? []) as ActiveBudget[];
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function monthReadStart(month_start: string, created_at: string): Date {
  const first = new Date(`${month_start}T00:00:00Z`);
  const created = new Date(created_at);
  if (Number.isNaN(first.getTime()))
    throw new Error(`invalid month_start ${month_start}`);
  if (Number.isNaN(created.getTime()))
    throw new Error(`invalid created_at ${created_at}`);
  return created > first ? created : first;
}

export async function monthLedgerAccounts(tenant_id: string, month_start: string): Promise<Map<Platform, { accounts: string[]; usd: number }>> {
  const [y, m] = month_start.split("-").map(Number);
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const out = new Map<Platform, { ids: Set<string>; usd: number }>();
  for (let page = 0; ; page++) {
    if (page >= LEDGER_MAX_PAGES) throw new Error("the month's ledger is larger than one check covers");
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("ad_spend_daily")
      .select("platform, account_id, amount_usd")
      .eq("source", "api")
      .gte("spend_date", month_start)
      .lt("spend_date", nextMonth)
      .gt("amount_usd", 0)
      .order("id", { ascending: true })
      .range(page * LEDGER_PAGE, (page + 1) * LEDGER_PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ platform: Platform; account_id: string | null; amount_usd?: number | string | null }>;
    for (const r of rows) {
      if (!out.has(r.platform)) out.set(r.platform, { ids: new Set(), usd: 0 });
      const p = out.get(r.platform)!;
      const usd = Number(r.amount_usd ?? 0);
      if (Number.isFinite(usd)) p.usd += usd;
      if (r.account_id) p.ids.add(r.account_id);
    }
    if (rows.length < LEDGER_PAGE) break;
  }
  return new Map([...out].map(([p, v]) => [p, { accounts: [...v.ids], usd: v.usd }]));
}
const LEDGER_PAGE = 1000;
const LEDGER_MAX_PAGES = 100;

function monthLastDay(month_start: string): string {
  const [y, m] = month_start.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function accountMonthWindow(
  month_start: string,
  read: { since: string; until: string },
): { since: string; until: string } | null {
  if (!/^\d{4}-\d{2}-01$/.test(month_start)) throw new Error(`invalid month_start ${month_start}`);
  const last = monthLastDay(month_start);
  const since = read.since > month_start ? read.since : month_start;
  const until = read.until < last ? read.until : last;
  return since > until ? null : { since, until };
}

function dateInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const v = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}

function isNotConnected(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.endsWith("_not_connected");
}

function metaMinorToUsd(minor: string | null | undefined): number | null {
  const n = Number(minor);
  if (minor == null || minor === "" || !Number.isFinite(n) || n <= 0)
    return null;
  return Math.round(n) / 100;
}

function microsUpToCent(micros: unknown): number {
  const n = Number(micros ?? 0);
  if (!Number.isFinite(n) || n < 0)
    throw new Error("Google Ads returned an unreadable amount");
  return Math.ceil(n / 10_000) / 100;
}

export async function readMetaAccount(
  tenant_id: string,
  start: Date,
  now: Date,
): Promise<AccountRead | null> {
  let account: string;
  try {
    account = (await metaAdsCreds(tenant_id)).ad_account_id;
  } catch (e) {
    if (isNotConnected(e)) return null;
    throw e;
  }
  const facts = (await fbGet(tenant_id, account, {
    fields: "currency,timezone_name,timezone_offset_hours_utc,account_status",
  })) as {
    currency?: string;
    timezone_name?: string;
    timezone_offset_hours_utc?: number | string;
    account_status?: number | string;
  };
  await import("@/services/growth/ad-account-watch")
    .then(({ noteMetaAccountStatus }) => noteMetaAccountStatus(tenant_id, account, facts.account_status, now))
    .catch((e) => console.warn(`[ad-budget-reconcile] account status note for ${tenant_id}: ${(e as Error).message}`));
  if (facts.currency !== "USD")
    throw new Error(
      `Meta ad account ${account} is in ${facts.currency ?? "an unreported currency"}, not USD`,
    );
  let onAccount: ((at: Date) => string) | null = null;
  const zone = facts.timezone_name;
  if (zone) {
    try {
      dateInZone(now, zone);
      onAccount = (at) => dateInZone(at, zone);
    } catch {
    }
  }
  if (!onAccount) {
    const offset = Number(facts.timezone_offset_hours_utc);
    if (facts.timezone_offset_hours_utc == null || !Number.isFinite(offset)) {
      throw new Error("Meta did not report the ad account's time zone");
    }
    onAccount = (at) => ymd(new Date(at.getTime() + offset * HOUR_MS));
  }
  const since = onAccount(start);
  const today = onAccount(now);
  const win = { since: since > today ? today : since, until: today };

  const campaignBudgeted = new Map(
    (
      await fbGetAllPages<{
        id?: string;
        daily_budget?: string | null;
        lifetime_budget?: string | null;
      }>(tenant_id, `${account}/campaigns`, {
        fields: "id,daily_budget,lifetime_budget",
        limit: 200,
      })
    )
      .filter(
        (c) =>
          c.id &&
          (metaMinorToUsd(c.daily_budget) != null ||
            metaMinorToUsd(c.lifetime_budget) != null),
      )
      .map((c) => [c.id as string, metaMinorToUsd(c.daily_budget)] as const),
  );
  const campaigns: LedgerCampaign[] = (
    await enumerateAccountAdSets(tenant_id, account)
  ).map((a) => {
    if (!a.id) throw new Error("Meta returned an ad set without an id");
    const daily = metaMinorToUsd(a.daily_budget);
    const lifetime = metaMinorToUsd(a.lifetime_budget);
    const onCampaign =
      a.campaign_id != null && campaignBudgeted.has(a.campaign_id);
    return {
      object_id: a.id,
      level: "ad_set",
      campaign_id: a.campaign_id ?? null,
      name: a.name ?? null,
      budget_kind:
        daily != null
          ? "daily"
          : lifetime != null
            ? "lifetime"
            : onCampaign
              ? "campaign_level"
              : "none",
      budget_usd: daily ?? lifetime,
      campaign_budget_usd: onCampaign ? (campaignBudgeted.get(a.campaign_id as string) ?? null) : null,
      status: a.effective_status ?? null,
      currency: "USD",
    };
  });

  const series = await fetchMetaDailySeries(tenant_id, {
    level: "adset",
    time_range: win,
    all_pages: true,
  });
  if (series.truncated) throw new Error("Meta insights were truncated");
  const spend: LedgerSpend[] = series.rows.map((r) => {
    if (!r.ad_set_id || !/^\d{4}-\d{2}-\d{2}$/.test(r.date))
      throw new Error("Meta returned an unreadable insight row");
    if (!Number.isFinite(r.spend_usd) || r.spend_usd < 0)
      throw new Error(
        `Meta returned an unreadable spend for ad set ${r.ad_set_id}`,
      );
    return {
      object_id: r.ad_set_id,
      spend_date: r.date,
      amount_usd: r.spend_usd,
      provisional: r.date === win.until,
    };
  });
  return { platform: "meta", account_id: account, campaigns, spend, window: win };
}

type GoogleCampaignRow = {
  campaign?: { id?: string | number; name?: string; status?: string };
  campaignBudget?: {
    amountMicros?: string | number;
    totalAmountMicros?: string | number;
    period?: string;
    explicitlyShared?: boolean;
  };
};

export async function readGoogleAccount(
  tenant_id: string,
  start: Date,
): Promise<AccountRead | null> {
  let customer: string;
  try {
    customer = await gadsCustomerId(tenant_id);
  } catch (e) {
    if (isNotConnected(e)) return null;
    if (
      (e as { code?: unknown } | null)?.code === "google_ads_not_configured"
    ) {
      if (!(await getSecret(tenant_id, GOOGLE_ADS_VAULT_KEYS.customer_id)))
        return null;
    }
    throw e;
  }
  const { currency_code, account_status } = await gadsGetBudgetGuardFacts(tenant_id, null);
  await import("@/services/growth/ad-account-watch")
    .then(({ noteGoogleAccountStatus }) => noteGoogleAccountStatus(tenant_id, customer, account_status, new Date()))
    .catch((e) => console.warn(`[ad-budget-reconcile] google account status note for ${tenant_id}: ${(e as Error).message}`));
  if (currency_code !== "USD")
    throw new Error(
      `Google Ads customer ${customer} is in ${currency_code ?? "an unreported currency"}, not USD`,
    );
  const clock = await accountClock(tenant_id);
  const since = dateInZone(start, clock.time_zone);
  const win = {
    since: since > clock.date ? clock.date : since,
    until: clock.date,
  };

  const rows = (await gadsSearch(
    tenant_id,
    "SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, campaign_budget.total_amount_micros, " +
      "campaign_budget.period, campaign_budget.explicitly_shared FROM campaign WHERE campaign.status != 'REMOVED'",
    { complete: true },
  )) as GoogleCampaignRow[];
  const campaigns: LedgerCampaign[] = rows.map((r) => {
    const id = r.campaign?.id != null ? String(r.campaign.id) : "";
    if (!/^\d+$/.test(id))
      throw new Error("Google Ads returned a campaign without an id");
    const b = r.campaignBudget;
    let budget_kind: LedgerCampaign["budget_kind"] = "none";
    let budget_usd: number | null = null;
    if (b?.explicitlyShared === true) {
      budget_kind = "shared";
    } else if (b?.period === "DAILY" && b.amountMicros != null) {
      budget_kind = "daily";
      budget_usd = microsUpToCent(b.amountMicros);
    } else if (b?.totalAmountMicros != null) {
      budget_kind = "lifetime";
      budget_usd = microsUpToCent(b.totalAmountMicros);
    }
    return {
      object_id: id,
      level: "campaign",
      campaign_id: id,
      name: r.campaign?.name ?? null,
      budget_kind,
      budget_usd,
      status: r.campaign?.status ?? null,
      currency: "USD",
    };
  });

  const spendRows = (await gadsSearch(
    tenant_id,
    `SELECT campaign.id, segments.date, metrics.cost_micros FROM campaign ` +
      `WHERE segments.date BETWEEN '${win.since}' AND '${win.until}'`,
    { complete: true },
  )) as Array<{
    campaign?: { id?: string | number };
    segments?: { date?: string };
    metrics?: { costMicros?: string | number };
  }>;
  const spend: LedgerSpend[] = spendRows.map((r) => {
    const id = r.campaign?.id != null ? String(r.campaign.id) : "";
    const date = r.segments?.date ?? "";
    if (!/^\d+$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error("Google Ads returned an unreadable cost row");
    return {
      object_id: id,
      spend_date: date,
      amount_usd: microsUpToCent(r.metrics?.costMicros),
      provisional: date === win.until,
    };
  });
  return { platform: "google", account_id: customer, campaigns, spend, window: win };
}

export function sumSpend(reads: AccountRead[], month_start: string): number {
  let cents = 0;
  for (const r of reads) {
    const w = accountMonthWindow(month_start, r.window);
    if (!w) continue;
    for (const s of r.spend)
      if (s.spend_date >= w.since && s.spend_date <= w.until)
        cents += Math.round(s.amount_usd * 100);
  }
  return cents / 100;
}

async function writeLedger(tenant_id: string, r: AccountRead, now: Date = new Date()): Promise<void> {
  if (r.recorded_only) return;
  await logOutsideChanges(tenant_id, r, now);
  const res = await tenantRpc(asTenantId(tenant_id), "record_ad_ledger_read", {
    p_platform: r.platform,
    p_account_id: r.account_id,
    p_campaigns: r.campaigns,
    p_spend: r.spend,
  });
  if (res.error)
    throw new Error(`record_ad_ledger_read failed: ${res.error.message}`);
}

function usd(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

function usdShort(n: number): string {
  if (Math.abs(n) < 10) return usd(n);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export type AdBudgetAlarmContext = {
  companyName: string | null;
  url: string;
};

export function renderAdBudgetAlarm(
  spent_usd: number,
  month_cap_usd: number,
  ctx: AdBudgetAlarmContext,
) {
  const company = oneLineName(ctx.companyName);
  const spentC = Math.round(spent_usd * 100);
  const capC = Math.round(month_cap_usd * 100);
  const pct = capC > 0 ? Math.max(90, Math.floor((spentC * 100) / capC)) : 90;
  const usedUp = pct >= 100;
  const intro = company
    ? `${company} has used ${usd(spent_usd)} of its ${usd(month_cap_usd)} ad budget this month.`
    : `You have used ${usd(spent_usd)} of your ${usd(month_cap_usd)} ad budget this month.`;
  const running =
    "Autopilot stops adding spend at the limit, but ads that are already running keep spending until you lower or pause them.";
  const resets = "The full amount comes back on the 1st.";
  const ctaText = "Lower or pause running ads";
  const subject = `${company ? `${company}: ` : ""}${usdShort(spent_usd)} of your ${usdShort(month_cap_usd)} ad budget used (${pct}%)`;
  const text = [`${intro} ${running}`, "", resets, "", `${ctaText}: ${ctx.url}`].join("\n");
  return {
    subject,
    text,
    html: renderEmail({
      preheader: "Running ads keep spending until you lower or pause them. Resets on the 1st.",
      kicker: "Ad budget",
      eyebrow: `${company ? `${escapeEmailHtml(company)} · ` : ""}${pct}% used`,
      title: usedUp
        ? "Your monthly budget is <em>used up</em>"
        : "Your monthly budget is nearly <em>used</em>",
      intro: escapeEmailHtml(`${intro} ${running}`),
      body: `<p>${escapeEmailHtml(resets)}</p>`,
      ctaText,
      ctaUrl: escapeEmailHtml(ctx.url),
      footerVariant: "founder-growth",
    }),
  };
}

export async function readCompanyName(tenant_id: string): Promise<string | null> {
  try {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("tenants")
      .select("display_name, slug")
      .maybeSingle();
    if (error) throw new Error(error.message);
    const t = (data ?? null) as { display_name?: unknown; slug?: unknown } | null;
    for (const v of [t?.display_name, t?.slug]) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  } catch (e) {
    console.warn(
      `[ad-budget-reconcile] company name read failed for tenant ${tenant_id}; sending without it: ${(e as Error).message}`,
    );
    return null;
  }
}

async function sendOwnerNote(
  tenant_id: string,
  r: { subject: string; html: string; text: string },
): Promise<"sent"> {
  const { resolveTenantOwnerEmail, sgSend } =
    await import("@/email/sendAuthEmail");
  const email = await resolveTenantOwnerEmail(tenant_id);
  if (!email) throw new Error("no owner email resolved");
  await sgSend(email, r.subject, r.html, r.text);
  return "sent";
}

export async function startBudgetMonth(
  tenant_id: string,
  budget_id: string,
): Promise<MonthAnswer> {
  const r = await tenantRpc(asTenantId(tenant_id), "start_ad_budget_month", {
    p_budget_id: budget_id,
  });
  if (r.error)
    throw new Error(`start_ad_budget_month failed: ${r.error.message}`);
  const ans = (r.data ?? {}) as MonthAnswer;
  if (
    ans.status === "active" &&
    (typeof ans.month_start !== "string" ||
      !/^\d{4}-\d{2}-01$/.test(ans.month_start))
  ) {
    throw new Error("start_ad_budget_month returned no month");
  }
  return ans;
}

async function recordActual(
  tenant_id: string,
  budget_id: string,
  actual_usd: number | null,
  month: string,
): Promise<RecordAnswer> {
  const r = await tenantRpc(asTenantId(tenant_id), "record_ad_budget_actual", {
    p_budget_id: budget_id,
    p_actual_usd: actual_usd,
    p_month: month,
  });
  if (r.error)
    throw new Error(`record_ad_budget_actual failed: ${r.error.message}`);
  return (r.data ?? {}) as RecordAnswer;
}

async function deliverAlarm(
  tenant_id: string,
  budget_id: string,
  ans: RecordAnswer,
) {
  if (ans.alarm !== true) return "none" as const;
  try {
    return await sendOwnerNote(
      tenant_id,
      renderAdBudgetAlarm(
        Number(ans.spent_usd ?? 0),
        Number(ans.month_cap_usd ?? 0),
        {
          companyName: await readCompanyName(tenant_id),
          url: adBudgetUrl(tenant_id),
        },
      ),
    );
  } catch (e) {
    console.error(
      `[ad-budget-reconcile] 90% note failed for budget ${budget_id}; retrying next hour: ${(e as Error).message}`,
    );
    const back = await tenantRpc(
      asTenantId(tenant_id),
      "release_ad_budget_alarm",
      { p_budget_id: budget_id },
    );
    if (back.error) {
      console.error(
        `[ad-budget-reconcile] could not give back the alarm claim for ${budget_id}: ${back.error.message}`,
      );
    }
    return "send_failed" as const;
  }
}

async function snapshotAfterReconcile(
  b: ActiveBudget,
  i: { reads: AccountRead[]; unread: Platform[]; read_started_at: Date; now: Date },
): Promise<void> {
  try {
    const { moneyBookShadowEnabled } = await import("@/services/decisions/ad-money-book-flag");
    if (!moneyBookShadowEnabled()) return;
    const { storeMonthSnapshot } = await import("@/services/decisions/ad-money-book-store");
    const unread = [...new Set(i.unread)];
    const out = await storeMonthSnapshot({
      tenant_id: b.tenant_id,
      budget_id: b.id,
      accounts: i.reads
        .filter((r) => !unread.includes(r.platform))
        .map((r) => ({ platform: r.platform, account_id: r.account_id, today: r.window.until })),
      unread_platforms: unread,
      read_started_at: i.read_started_at,
      now: i.now,
    });
    if (out.status === "skipped") console.log(`[ad-money-book] budget ${b.id}: snapshot skipped (${out.reason})`);
  } catch (e) {
    console.warn(`[ad-money-book] budget ${b.id}: snapshot not stored: ${(e as Error)?.message ?? String(e)}`);
  }
}

export type ReadFailureKind = AdReadErrorKind | "account_gone" | "disconnected";

export const READ_SLOW_ALERT_MS = 3 * 3_600_000;

export function readFailingForLong(since: string, now: Date): boolean {
  const t = Date.parse(since);
  return Number.isFinite(t) && now.getTime() - t >= READ_SLOW_ALERT_MS;
}

export const reconcileRetry = {
  wait: (): Promise<void> => new Promise((res) => setTimeout(res, 2_000 + Math.floor(Math.random() * 3_000))),
};

async function writeReadFailureKinds(b: ActiveBudget, kinds: Record<string, ReadFailureKind>): Promise<void> {
  try {
    const { error } = await tenantClient(asTenantId(b.tenant_id)).from("ad_budgets").update({ read_failure_kinds: kinds }).eq("id", b.id);
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn(`[ad-budget-reconcile] budget ${b.id}: read failure kinds not stored: ${(e as Error).message}`);
  }
}

export async function reconcileBudget(
  b: ActiveBudget,
  now: Date = new Date(),
  opts: { syncLiveHolds?: boolean } = {},
): Promise<BudgetOutcome> {
  const readStartedAt = new Date();
  const dbReadStartedAt = await adBudgetReadStart(b.tenant_id);
  try {
    const m = await startBudgetMonth(b.tenant_id, b.id);
    if (m.status !== "active")
      return {
        budget_id: b.id,
        tenant_id: b.tenant_id,
        outcome: "skipped",
        status: String(m.status ?? "unknown"),
      };
    const monthStart = m.month_start as string;
    const rolled = m.rolled === true;

    const reads: AccountRead[] = [];
    const errors: string[] = [];
    const failedPlatforms: Platform[] = [];
    const failureKinds = new Map<Platform, ReadFailureKind>();
    const disconnectedUsd = new Map<Platform, number>();
    const founderReasons = new Map<Platform, string>();
    let start: Date | null = null;
    try {
      start = monthReadStart(monthStart, b.created_at);
    } catch (e) {
      errors.push((e as Error).message);
    }
    if (start) {
      const readers: Array<[Platform, () => Promise<AccountRead | AccountRead[] | null>]> = [
        ["meta", () => withMetaCaller("reconcile", () => readMetaAccount(b.tenant_id, start as Date, now))],
        ["google", () => readGoogleAccount(b.tenant_id, start as Date)],
        ["chatgpt", () => readChatgptAccount(b.tenant_id, start as Date, now)],
        ["reddit", () => readRedditAccounts(b.tenant_id, start as Date, now)],
        ["x", () => readXAccountsForBudget(b.tenant_id, start as Date, now)],
        ...LEDGER_ONLY_READERS.map((r): [Platform, () => Promise<AccountRead[]>] => [r.platform, () => r.read(b.tenant_id, start as Date, now)]),
      ];
      const firstFailures = new Map<Platform, unknown>();
      const retryable: Array<[Platform, () => Promise<AccountRead | AccountRead[] | null>]> = [];
      for (const [platform, read] of readers) {
        try {
          const r = await read();
          if (r) reads.push(...(Array.isArray(r) ? r : [r]));
        } catch (e) {
          firstFailures.set(platform, e);
          if (!(e instanceof ConnectionUnknownError) && !(e instanceof AdAccountLostError) && isRetryableAdReadKind(classifyAdReadError(e))) retryable.push([platform, read]);
        }
      }
      if (retryable.length > 0) {
        await reconcileRetry.wait();
        for (const [platform, read] of retryable) {
          try {
            const r = await read();
            if (r) reads.push(...(Array.isArray(r) ? r : [r]));
            firstFailures.delete(platform);
            console.log(`[ad-budget-reconcile] budget ${b.id}: ${platform} read on retry`);
          } catch {
          }
        }
      }
      for (const [platform, e] of firstFailures) {
        errors.push(`${platform}: ${(e as Error).message}`);
        if (e instanceof ConnectionUnknownError) continue;
        failedPlatforms.push(platform);
        failureKinds.set(platform, e instanceof AdAccountLostError ? "account_gone" : classifyAdReadError(e));
        const reason = e instanceof ExpectedToolError ? e.meta?.founder_reason : null;
        if (typeof reason === "string" && reason.trim()) founderReasons.set(platform, reason.trim());
        await logReadFailed(b.tenant_id, platform, e);
      }
    }

    const dropped = new Set<Platform>();
    if (start && start.toISOString().slice(0, 10) <= monthStart) {
      try {
        for (const [platform, ledger] of await monthLedgerAccounts(b.tenant_id, monthStart)) {
          if (failedPlatforms.includes(platform)) continue;
          const platformReads = reads.filter((r) => r.platform === platform);
          const read = new Set(platformReads.map((r) => r.account_id));
          const gone = ledger.accounts.filter((a) => !read.has(a));
          if (platformReads.every((r) => r.managed) && (read.size === 0 || gone.length > 0)) {
            if (read.size > 0) dropped.add(platform);
            failedPlatforms.push(platform);
            failureKinds.set(platform, "disconnected");
            disconnectedUsd.set(platform, ledger.usd);
            errors.push(`${platform}: recorded spend this month and is no longer connected`);
            continue;
          }
          if (gone.length === 0) continue;
          dropped.add(platform);
          failedPlatforms.push(platform);
          failureKinds.set(platform, "account_gone");
          errors.push(`${platform}: ad account ${gone.join(", ")} recorded spend this month and is no longer read`);
        }
      } catch (e) {
        errors.push(`ledger accounts could not be checked: ${(e as Error).message}`);
      }
    }
    const counted = reads.filter((r) => !dropped.has(r.platform));

    const ledger_failed: Platform[] = [];
    for (const r of reads) {
      try {
        await writeLedger(b.tenant_id, r, now);
      } catch (e) {
        ledger_failed.push(r.platform);
        console.error(
          `[ad-budget-reconcile] budget ${b.id}: ${r.platform} ledger write failed: ${(e as Error).message}`,
        );
      }
    }

    const readError = errors.length > 0 ? errors.join("; ") : null;
    if (readError !== null)
      console.warn(
        `[ad-budget-reconcile] budget ${b.id}: read incomplete; retaining unknown spend and recording verified lower bounds: ${readError}`,
      );
    const partialRead = errors.length > 0 && errors.length === failedPlatforms.length;
    const failedNames = failedPlatforms.map(platformName);
    const verifiedPlatforms = counted.map(r => r.platform).filter(p => !ledger_failed.includes(p));
    const recordedOnly = counted.filter((r) => r.recorded_only);
    const recordedOnlyPlatforms = [...new Set(recordedOnly.map((r) => r.platform))];
    const incompleteNames = partialRead ? [...new Set(failedNames)] : [];
    const actual = readError === null ? sumSpend(counted, monthStart) : null;
    let ans: Awaited<ReturnType<typeof recordActual>>;
    if (partialRead) {
      const partial = await tenantRpc(asTenantId(b.tenant_id), "record_ad_budget_partial_actual_v2", {
        p_budget_id: b.id, p_actual_usd: sumSpend(counted, monthStart), p_month: monthStart,
        p_failed_platforms: failedPlatforms,
      });
      if (partial.error) throw new Error(partial.error.message);
      ans = partial.data as Awaited<ReturnType<typeof recordActual>>;
    } else ans = await recordActual(b.tenant_id, b.id, actual, monthStart);
    const status = String(ans.status ?? "unknown");
    const alarm = await deliverAlarm(b.tenant_id, b.id, ans);
    if (readError === null) {
      const cleared = await tenantRpc(asTenantId(b.tenant_id), "clear_ad_budget_read_failed_platforms", { p_budget_id: b.id });
      if (cleared.error) console.warn(`[ad-budget-reconcile] budget ${b.id}: clearing failed platforms: ${cleared.error.message}`);
      else await writeReadFailureKinds(b, {});
    } else if (partialRead) {
      const kinds = Object.fromEntries(failedPlatforms.map((p) => [p, failureKinds.get(p) ?? "unknown"])) as Record<string, ReadFailureKind>;
      await writeReadFailureKinds(b, kinds);
      const { alertFounderSafely, adReadFailedBlocker, adReadSlowBlocker, adDisconnectedBlocker } = await import("@/services/growth/cgo-blockers");
      const row = await tenantClient(asTenantId(b.tenant_id)).from("ad_budgets").select("read_failed").eq("id", b.id).maybeSingle();
      const began = ((row.data as { read_failed?: Record<string, string> } | null)?.read_failed) ?? {};
      const day = now.toISOString().slice(0, 10);
      const alerts = failedPlatforms.flatMap((platform) => {
        const since = began[platform] ?? now.toISOString();
        const base = { budget_id: b.id, platform, name: platformName(platform), day, since };
        const kind = kinds[platform];
        if (kind === "auth" || kind === "account_gone") return [adReadFailedBlocker({ ...base, kind, reason: kind === "auth" ? founderReasons.get(platform) : null })];
        if (kind === "disconnected") return [adDisconnectedBlocker({ ...base, usd: disconnectedUsd.get(platform) ?? 0 })];
        return readFailingForLong(since, now) ? [adReadSlowBlocker(base)] : [];
      });
      if (alerts.length > 0) await alertFounderSafely(b.tenant_id, "ad spend read failed", alerts);
    }
    const unknown_holds = await resolveUnknownAdHolds(b.tenant_id, now, undefined, { allowRelease: readError === null || partialRead, platforms: verifiedPlatforms });
    const inflight_holds = await resolveInflightAdHolds(b.tenant_id, now, {
      allowRelease: readError === null || partialRead,
      platforms: verifiedPlatforms,
    });
    const live_holds = opts.syncLiveHolds !== false && (readError === null || partialRead) && dbReadStartedAt
      ? await syncAdHoldsToLive(b.tenant_id, verifiedPlatforms, dbReadStartedAt)
      : undefined;
    let brake: BrakeOutcome["status"] | undefined;
    if (status === "active" && ledger_failed.length === 0 && (readError === null || partialRead)) {
      const out = await runBudgetBrake(
        b,
        counted.filter((r) => !r.recorded_only).map((r) => ({ platform: r.platform, account_id: r.account_id })),
        {
          incompletePlatforms: incompleteNames,
          send: sendOwnerNote,
          companyName: readCompanyName,
          alertFounder: async (tenant_id, o) => {
            const { alertFounderSafely, overspendBlocker } = await import("@/services/growth/cgo-blockers");
            const blocker = overspendBlocker(o);
            if (incompleteNames.length > 0) {
              blocker.what = `${incompleteNames.join(", ")} could not be read; these are minimum known totals. ${blocker.what}`;
            }
            await alertFounderSafely(tenant_id, "overspend brake", [blocker]);
          },
        },
      );
      brake = out.status;
      if (out.status === "error")
        console.warn(
          `[ad-budget-reconcile] budget ${b.id}: brake: ${out.error}`,
        );
    }
    if (status === "active" && (readError === null || partialRead)) {
      await snapshotAfterReconcile(b, {
        reads: counted,
        unread: [...failedPlatforms, ...ledger_failed, ...recordedOnlyPlatforms],
        read_started_at: readStartedAt,
        now,
      });
    }
    if (readError !== null) {
      return {
        budget_id: b.id,
        tenant_id: b.tenant_id,
        outcome: "read_failed",
        error: readError,
        status,
        alarm,
        rolled,
        ledger_failed,
        brake,
        live_holds,
      };
    }
    return {
      budget_id: b.id,
      tenant_id: b.tenant_id,
      outcome: "recorded",
      actual_usd: Number(ans.spent_usd ?? actual ?? 0),
      status,
      alarm,
      rolled,
      ledger_failed,
      brake,
      ...(recordedOnly.length > 0 ? { recorded_only_accounts: recordedOnly.map((r) => r.account_id) } : {}),
      unknown_holds,
      inflight_holds,
      live_holds,
    };
  } catch (e) {
    return {
      budget_id: b.id,
      tenant_id: b.tenant_id,
      outcome: "error",
      error: (e as Error).message,
    };
  }
}

const MAX_CONNECTED_TENANTS_PER_SWEEP = 1000;

export async function listConnectedAdTenants(): Promise<string[]> {
  const { data, error } = await fleetSweepClient(
    "ad-budget hourly reconcile: list tenants with a connected ad account",
  )
    .from("connector_metadata")
    .select("tenant_id")
    .in("slug", ["meta_ads", "google_ads", "composio.reddit_ads", "x_ads", ...LEDGER_ONLY_READERS.flatMap((r) => r.slugs)])
    .limit(MAX_CONNECTED_TENANTS_PER_SWEEP);
  if (error)
    throw new Error(
      `ad-budget-reconcile: connected tenant list failed: ${error.message}`,
    );
  const wallets = await fleetSweepClient("ad-budget hourly reconcile: include prepaid ChatGPT advertisers")
    .from("ads_wallets").select("tenant_id").limit(MAX_CONNECTED_TENANTS_PER_SWEEP);
  if (wallets.error) throw new Error("ChatGPT advertiser list unavailable");
  const bindings = await fleetSweepClient("ad-budget hourly reconcile: include explicitly bound advertisers")
    .from("ads_account_bindings").select("tenant_id").limit(MAX_CONNECTED_TENANTS_PER_SWEEP);
  if (bindings.error) throw new Error("Bound advertiser list unavailable");
  if ([data, wallets.data, bindings.data].some(rows => !Array.isArray(rows) || rows.length >= MAX_CONNECTED_TENANTS_PER_SWEEP))
    throw new Error("Connected advertiser inventory is incomplete");
  return [...new Set(([...(data ?? []), ...(wallets.data ?? []), ...(bindings.data ?? [])] as Array<{ tenant_id: string }>).map((r) => r.tenant_id))];
}

export type LedgerOnlyOutcome = {
  tenant_id: string;
  read: Platform[];
  failed: string[];
};

export async function reconcileLedgerOnly(
  tenant_id: string,
  now: Date = new Date(),
): Promise<LedgerOnlyOutcome> {
  const start = new Date(`${now.toISOString().slice(0, 7)}-01T00:00:00Z`);
  const out: LedgerOnlyOutcome = { tenant_id, read: [], failed: [] };
  const readers: Array<[Platform, () => Promise<AccountRead | AccountRead[] | null>]> = [
    ["meta", () => withMetaCaller("reconcile", () => readMetaAccount(tenant_id, start, now))],
    ["google", () => readGoogleAccount(tenant_id, start)],
    ["chatgpt", () => readChatgptAccount(tenant_id, start, now)],
    ["reddit", () => readRedditAccounts(tenant_id, start, now)],
    ["x", () => readXAccountsForBudget(tenant_id, start, now)],
    ...LEDGER_ONLY_READERS.map((r): [Platform, () => Promise<AccountRead[]>] => [r.platform, () => r.read(tenant_id, start, now)]),
  ];
  for (const [platform, read] of readers) {
    try {
      const r = await read();
      if (!r) continue;
      for (const account of (Array.isArray(r) ? r : [r])) await writeLedger(tenant_id, account, now);
      out.read.push(platform);
    } catch (e) {
      out.failed.push(`${platform}: ${(e as Error).message}`);
    }
  }
  return out;
}

export async function runAdBudgetReconcile(now: Date = new Date()) {
  const monitor = async (tenantId: string) => {
    try { await (await import("@/services/connectors/x-ads/budget-stop")).enforceXBudget(tenantId, now); }
    catch (e) { console.warn(`[ad-budget-reconcile] X Ads budget stop: ${e instanceof Error ? e.message : "read failed"}`); }
    try { await (await import("@/services/connectors/reddit-ads/monitor")).monitorRedditAds(tenantId, now); }
    catch (e) { console.warn(`[ad-budget-reconcile] Reddit monitoring: ${e instanceof Error ? e.message : "read failed"}`); }
  };
  const budgets = await listActiveBudgets();
  const results: BudgetOutcome[] = [];
  for (const b of budgets) {
    const r = await reconcileBudget(b, now);
    if (r.outcome === "error")
      console.warn(`[ad-budget-reconcile] budget ${b.id}: ${r.error}`);
    results.push(r);
    await monitor(b.tenant_id);
    try {
      const { runPendingTestsForTenant } = await import("@/services/growth/pending-test-claim");
      await runPendingTestsForTenant(b.tenant_id, now, { allowClaim: r.outcome === "recorded" });
    } catch (e) {
      console.warn(`[ad-budget-reconcile] pending tests for ${b.tenant_id}: ${(e as Error).message}`);
    }
  }
  let ledgerOnly = 0;
  let ledgerOnlyFailed = 0;
  try {
    const budgeted = new Set(budgets.map((b) => b.tenant_id));
    for (const tenant_id of await listConnectedAdTenants()) {
      if (budgeted.has(tenant_id)) continue;
      const r = await reconcileLedgerOnly(tenant_id, now);
      await monitor(tenant_id);
      ledgerOnly++;
      if (r.failed.length > 0) {
        ledgerOnlyFailed++;
        console.warn(`[ad-budget-reconcile] tenant ${tenant_id} (no budget): ${r.failed.join("; ")}`);
      }
    }
  } catch (e) {
    console.warn(`[ad-budget-reconcile] connected-account sweep failed: ${(e as Error).message}`);
  }
  const read = results.flatMap((r) =>
    r.outcome === "recorded" || r.outcome === "read_failed" ? [r] : [],
  );
  return {
    budgets: budgets.length,
    recorded: results.filter((r) => r.outcome === "recorded").length,
    read_failed: results.filter((r) => r.outcome === "read_failed").length,
    errors: results.filter((r) => r.outcome === "error").length,
    alarms: read.filter((r) => r.alarm === "sent").length,
    rolled: read.filter((r) => r.rolled).length,
    ledger_failed: read.reduce((s, r) => s + r.ledger_failed.length, 0),
    brake_warned: results.filter(
      (r) => (r.outcome === "recorded" || r.outcome === "read_failed") && r.brake === "warned",
    ).length,
    brake_due: results.filter(
      (r) => (r.outcome === "recorded" || r.outcome === "read_failed") && r.brake === "brake_due",
    ).length,
    ledger_only: ledgerOnly,
    ledger_only_failed: ledgerOnlyFailed,
    holds_released: read.reduce((s, r) => s + (r.live_holds?.released ?? 0), 0),
    holds_lowered: read.reduce((s, r) => s + (r.live_holds?.lowered ?? 0), 0),
  };
}

export async function reconcileReadFailedBudgets(tenant_id: string, now: Date = new Date()) {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("ad_budgets")
    .select("id, tenant_id, created_at, read_failed")
    .eq("tenant_id", tenant_id)
    .eq("status", "active");
  if (error) throw new Error(`ad-budget reconnect read: budget list failed: ${error.message}`);
  const flagged = ((data ?? []) as Array<ActiveBudget & { read_failed: Record<string, string> | null }>).filter(
    (b) => Object.keys(b.read_failed ?? {}).length > 0,
  );
  const results: BudgetOutcome[] = [];
  for (const b of flagged) {
    const r = await reconcileBudget({ id: b.id, tenant_id: b.tenant_id, created_at: b.created_at }, now, { syncLiveHolds: false });
    if (r.outcome === "error") console.warn(`[ad-budget reconnect read] budget ${b.id}: ${r.error}`);
    results.push(r);
  }
  return {
    flagged: flagged.length,
    recorded: results.filter((r) => r.outcome === "recorded").length,
    read_failed: results.filter((r) => r.outcome === "read_failed").length,
    errors: results.filter((r) => r.outcome === "error").length,
  };
}

export async function logReadFailed(tenant_id: string, platform: string, e: unknown): Promise<void> {
  try {
    const { redactError } = await import("@/services/growth/ad-goal-match");
    const { logEvent } = await import("@/services/logging/logEvent");
    await logEvent({
      level: "warn",
      source: "ad-budget-reconcile",
      code: "ad_budget_read_failed",
      message: `${platform}: ${redactError(String((e as Error)?.message ?? e))}`,
      tenant_id,
      meta: { platform },
    });
  } catch {
  }
}
