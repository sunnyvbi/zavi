
import { getConnectorToken } from "@/services/connectors/core/token";
import type { AccountRead } from "@/services/decisions/ad-budget-reconcile";
import { DailySpend, addDays, dayChunks, ledgerConnected, onOffStatus, requireUsd, spendAmount, zoneDate } from "@/services/connectors/core/budget-ledger";
import { listSpotifyAdAccountsRaw } from "./client";
import { SPOTIFY_ADS_ACCESS_TOKEN_KEY, SPOTIFY_ADS_SLUG } from "./constants";
import { spotifyAdsGet } from "./http";

const LABEL = "Spotify Ads";
const MICROS = 1_000_000;
const PAGE = 50;
const MAX_PAGES = 80;
const REPORT_MAX_DAYS = 60;

type AdSet = {
  id: string; name?: string | null; status?: string | null; delivery?: string | null; campaign_id?: string | null;
  budget?: { micro_amount?: number | string | null; type?: string | null } | null;
};
type ReportRow = { entity_id?: string; start_time?: string; stats?: Array<{ field_type?: string; field_value?: number | string | null }> };

async function adSets(token: string, accountId: string): Promise<AdSet[]> {
  const out: AdSet[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await spotifyAdsGet<{ ad_sets?: AdSet[]; paging?: { total_results?: number } }>(token, `ad_accounts/${accountId}/ad_sets`, {
      limit: String(PAGE), offset: String(page * PAGE),
    });
    const rows = data.ad_sets ?? [];
    out.push(...rows);
    if (rows.length < PAGE || out.length >= (data.paging?.total_results ?? Infinity)) return out;
  }
  throw new Error(`${LABEL} has more ad sets than one read covers; spend is unknown.`);
}

export async function readSpotifyAccountsForBudget(tenantId: string, start: Date, now = new Date()): Promise<AccountRead[]> {
  if (!(await ledgerConnected(tenantId, SPOTIFY_ADS_SLUG, LABEL))) return [];
  const token = await getConnectorToken(tenantId, SPOTIFY_ADS_SLUG, SPOTIFY_ADS_ACCESS_TOKEN_KEY);
  if (!token) throw new Error(`${LABEL} is connected but its token is missing; reconnect it.`);
  const accounts = await listSpotifyAdAccountsRaw(token);
  requireUsd(LABEL, accounts.map((a) => a.currency));
  const reads: AccountRead[] = [];
  for (const acct of accounts) {
    const window = { since: start.toISOString().slice(0, 10), until: zoneDate(now) };
    const sets = await adSets(token, acct.id);
    const spend = new DailySpend();
    if (window.since <= window.until)
      for (const chunk of dayChunks(window.since, window.until, REPORT_MAX_DAYS)) {
        let continuation: string | undefined;
        for (let page = 0; ; page++) {
          if (page >= MAX_PAGES) throw new Error(`${LABEL} report too large for one read; spend is unknown.`);
          const params: Record<string, string> = continuation
            ? { continuation_token: continuation }
            : {
                entity_type: "AD_SET", fields: "SPEND", granularity: "DAY", limit: String(PAGE),
                report_start: `${chunk.since}T00:00:00Z`, report_end: `${addDays(chunk.until, 1)}T00:00:00Z`,
              };
          const data = await spotifyAdsGet<{ rows?: ReportRow[]; continuation_token?: string | null; paging?: { continuation_token?: string | null } }>(token, `ad_accounts/${acct.id}/aggregate_reports`, params);
          if (!Array.isArray(data.rows)) throw new Error(`${LABEL} report returned no rows array; spend is unknown.`);
          for (const r of data.rows) {
            const day = typeof r.start_time === "string" ? r.start_time.slice(0, 10) : "";
            if (!r.entity_id || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`${LABEL} report row has no ad set or day; spend is unknown.`);
            const v = r.stats?.find((s) => s.field_type === "SPEND")?.field_value;
            if (v == null) continue;
            spend.add(r.entity_id, day, spendAmount(LABEL, v));
          }
          continuation = data.continuation_token ?? data.paging?.continuation_token ?? undefined;
          if (!continuation) break;
        }
      }
    reads.push({
      platform: "spotify",
      account_id: acct.id,
      window,
      campaigns: sets.map((s) => {
        const amount = s.budget?.micro_amount != null && Number(s.budget.micro_amount) > 0 ? Number(s.budget.micro_amount) / MICROS : null;
        const on = s.delivery === "ON" ? true : s.delivery === "OFF" ? false : null;
        return {
          object_id: s.id, level: "ad_set" as const, campaign_id: s.campaign_id ?? null, name: s.name ?? null,
          budget_kind: amount == null ? ("none" as const) : s.budget?.type === "LIFETIME" ? ("lifetime" as const) : ("daily" as const),
          budget_usd: amount,
          status: onOffStatus(on, s.status),
          currency: acct.currency ?? "UNKNOWN",
        };
      }),
      spend: spend.toRows(window.until, 1),
    });
  }
  return reads;
}
