
import type { AccountRead } from "@/services/decisions/ad-budget-reconcile";
import { DailySpend, dayChunks, ledgerConnected, onOffStatus, requireUsd, spendAmount, zoneDate } from "@/services/connectors/core/budget-ledger";
import { listAppleAdAccountsRaw, tenantCreds } from "./client";
import { APPLE_ADS_SLUG } from "./constants";
import { appleAccessToken, appleAdsRequest } from "./http";

const LABEL = "Apple Ads";
const REPORT_MAX_DAYS = 90;
const PAGE = 1000;
const REPORT_PAGE = 5000;
const MAX_PAGES = 20;
const IDS_PER_REPORT = 200;

type Money = { amount?: string | number; currency?: string };
type Campaign = {
  id?: number | string; name?: string; status?: string; deleted?: boolean; promotedObjectType?: string;
  dailyBudget?: { value?: Money } & Money; dailyBudgetAmount?: Money;
};
type AdAccount = { id?: number | string; currency?: string; timezone?: string };
type ReportRow = {
  metadata?: { id?: number | string };
  granularMetrics?: Array<{ date?: string; localSpend?: Money }>;
  totalMetrics?: { localSpend?: Money };
};

const REPORT_PATH: Record<string, string> = {
  APPSTORE_APP: "reports/apps/campaigns/query",
  BUSINESS_BRAND: "reports/business-brands/campaigns/query",
};

function dailyBudget(c: Campaign): Money | undefined {
  return c.dailyBudget?.value ?? (c.dailyBudget?.amount != null ? c.dailyBudget : undefined) ?? c.dailyBudgetAmount;
}

export async function readAppleAccountsForBudget(tenantId: string, start: Date, now = new Date()): Promise<AccountRead[]> {
  if (!(await ledgerConnected(tenantId, APPLE_ADS_SLUG, LABEL))) return [];
  const token = await appleAccessToken(await tenantCreds(tenantId), tenantId);
  const accounts = await listAppleAdAccountsRaw(token);
  const reads: AccountRead[] = [];
  for (const a of accounts) {
    const info = (await appleAdsRequest<AdAccount>(token, "GET", `ad-accounts/${a.id}`)).result ?? {};
    requireUsd(LABEL, [info.currency]);
    const window = { since: start.toISOString().slice(0, 10), until: zoneDate(now, info.timezone) };
    const campaigns: Campaign[] = [];
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new Error(`${LABEL} has more campaigns than one read covers; spend is unknown.`);
      const env = await appleAdsRequest<Campaign[]>(token, "POST", "campaigns/query", {
        adAccountId: a.id, body: { filters: [{ field: "deleted", operator: "IN", value: [true, false] }], pagination: { offset: page * PAGE, pageSize: PAGE, fetchTotalCount: false } },
      });
      const rows = env.result ?? [];
      campaigns.push(...rows);
      if (rows.length < PAGE) break;
    }
    const idsByReport = new Map<string, string[]>();
    for (const c of campaigns) {
      const id = String(c.id ?? "");
      if (!id) continue;
      const path = REPORT_PATH[c.promotedObjectType ?? ""];
      if (!path) throw new Error(`${LABEL} campaign ${id} has type ${c.promotedObjectType ?? "none"}, which Zavi cannot read spend for; spend is unknown.`);
      idsByReport.set(path, [...(idsByReport.get(path) ?? []), id]);
    }
    const spend = new DailySpend();
    if (window.since <= window.until)
      for (const [path, ids] of idsByReport)
        for (const chunk of dayChunks(window.since, window.until, REPORT_MAX_DAYS))
          for (let i = 0; i < ids.length; i += IDS_PER_REPORT) {
            const oneDay = chunk.since === chunk.until;
            for (let page = 0; ; page++) {
              if (page >= MAX_PAGES) throw new Error(`${LABEL} report too large for one read; spend is unknown.`);
              const env = await appleAdsRequest<{ reportingDataResponse?: { row?: ReportRow[] }; rows?: ReportRow[] }>(token, "POST", path, {
                adAccountId: a.id,
                body: {
                  timeRange: { start: chunk.since, end: chunk.until, timeZone: "ORTZ", ...(oneDay ? {} : { granularity: "DAILY" }) },
                  filters: [{ field: "campaignId", operator: "IN", value: ids.slice(i, i + IDS_PER_REPORT) }],
                  fields: ["localSpend"],
                  pagination: { offset: page * REPORT_PAGE, pageSize: REPORT_PAGE },
                },
              });
              const rows = env.result?.rows ?? env.result?.reportingDataResponse?.row;
              if (!Array.isArray(rows)) throw new Error(`${LABEL} report returned no rows array; spend is unknown.`);
              for (const r of rows) {
                const id = r.metadata?.id;
                if (id == null) throw new Error(`${LABEL} report row has no campaign; spend is unknown.`);
                if (oneDay) {
                  const m = r.totalMetrics?.localSpend;
                  if (m?.amount == null) continue;
                  requireUsd(LABEL, [m.currency]);
                  spend.add(String(id), chunk.since, spendAmount(LABEL, m.amount));
                  continue;
                }
                for (const g of r.granularMetrics ?? []) {
                  const day = typeof g.date === "string" ? g.date.slice(0, 10) : "";
                  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`${LABEL} report row has no day; spend is unknown.`);
                  if (g.localSpend?.amount == null) continue;
                  requireUsd(LABEL, [g.localSpend.currency]);
                  spend.add(String(id), day, spendAmount(LABEL, g.localSpend.amount));
                }
              }
              if (rows.length < REPORT_PAGE) break;
            }
          }
    reads.push({
      platform: "apple",
      account_id: String(a.id),
      window,
      campaigns: campaigns.map((c) => {
        const b = dailyBudget(c);
        const amount = b?.amount != null && Number(b.amount) > 0 ? Number(b.amount) : null;
        return {
          object_id: String(c.id ?? ""), level: "campaign" as const, campaign_id: String(c.id ?? ""), name: c.name ?? null,
          budget_kind: amount == null ? ("none" as const) : ("daily" as const), budget_usd: amount,
          status: c.deleted ? "DELETED" : onOffStatus(c.status === "ENABLED" ? true : c.status === "PAUSED" ? false : null, c.status),
          currency: info.currency ?? "UNKNOWN",
        };
      }),
      spend: spend.toRows(window.until, 2),
    });
  }
  return reads;
}

