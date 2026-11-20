
import { fbGet, fbGetAllPages, metaAdsCreds } from "@/services/tools/meta-ads/_client";
import { fetchMetaDailySeries, mapMetaDailyRow } from "@/services/tools/meta-ads/daily_series";
import { gadsSearch } from "@/services/tools/google-ads/_client";
import { fetchGoogleDailySeries } from "@/services/tools/google-ads/daily_series";
import type { ResolvedWindow } from "@/services/analytics/metric-time";
import { div, failFrom, sumByDate, sumByKey } from "./shared";
import type { FetchOk, FetchResult, MetricFetchCtx, MetricImpl, Parts } from "./types";

type MetaInsightRow = Parameters<typeof mapMetaDailyRow>[0];

function tzCaveat(platform: string, accountTz: string | null, tz: string): string[] {
  if (!accountTz) return [`${platform} did not report its account time zone, so day edges may not match ${tz}.`];
  return accountTz === tz
    ? []
    : [`${platform} reports days in the ad account's time zone (${accountTz}), not ${tz}, so day edges differ.`];
}

export async function fetchMetaAds(ctx: MetricFetchCtx, w: ResolvedWindow): Promise<FetchResult> {
  const time_range = { since: w.since, until: w.until };
  try {
    const creds = await metaAdsCreds(ctx.tenant_id);
    const info = (await fbGet(ctx.tenant_id, creds.ad_account_id, { fields: "currency,timezone_name" })) as {
      currency?: string;
      timezone_name?: string;
    };
    const raw = await fbGetAllPages<MetaInsightRow>(ctx.tenant_id, `${creds.ad_account_id}/insights`, {
      level: "account",
      time_range: JSON.stringify(time_range),
      time_increment: 1,
      limit: 500,
      fields: "date_start,spend,impressions,clicks,ctr,cpm,actions,action_values",
    });
    const daily = sumByDate(
      raw.map((r) => {
        const m = mapMetaDailyRow(r);
        return {
          date: m.date,
          parts: {
            spend: m.spend_usd,
            clicks: m.clicks,
            impressions: m.impressions,
            conversions: m.conversions,
            conv_value: m.purchase_value_usd,
          },
        };
      }),
    );
    const out: FetchOk = {
      ok: true,
      daily,
      currency: info.currency ? info.currency.toUpperCase() : null,
      row_count: raw.length,
      truncated: false,
      caveats: tzCaveat("Meta", info.timezone_name ?? null, w.tz),
      params: { source: "meta.insights", level: "account", time_increment: 1, time_range, account_timezone: info.timezone_name ?? null },
    };
    if (ctx.breakdown === "campaign") {
      const byCampaign = await fetchMetaDailySeries(ctx.tenant_id, { level: "campaign", time_range, all_pages: true });
      out.breakdown = sumByKey(
        byCampaign.rows.map((r) => ({
          key: r.campaign_name || r.campaign_id,
          parts: {
            spend: r.spend_usd,
            clicks: r.clicks,
            impressions: r.impressions,
            conversions: r.conversions,
            conv_value: r.purchase_value_usd,
          },
        })),
        "spend",
      );
    }
    if (!out.currency) {
      return { ok: false, reason: "read_failed", message: "Meta did not report the ad account's currency." };
    }
    return out;
  } catch (e) {
    return failFrom(e, "Meta Ads");
  }
}

type GadsCustomerRow = { customer?: { currencyCode?: string; timeZone?: string } };
type GadsDayRow = {
  segments?: { date?: string };
  metrics?: {
    costMicros?: string;
    clicks?: string;
    impressions?: string;
    conversions?: string;
    conversionsValue?: string;
  };
};

export async function fetchGoogleAds(ctx: MetricFetchCtx, w: ResolvedWindow): Promise<FetchResult> {
  try {
    const cust = ((await gadsSearch(
      ctx.tenant_id,
      "SELECT customer.currency_code, customer.time_zone FROM customer LIMIT 1",
    )) as GadsCustomerRow[])[0]?.customer;
    const raw = (await gadsSearch(
      ctx.tenant_id,
      `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM customer WHERE segments.date BETWEEN '${w.since}' AND '${w.until}'`,
    )) as GadsDayRow[];
    const daily = sumByDate(
      raw.map((r) => ({
        date: r.segments?.date ?? "",
        parts: {
          spend: Number(r.metrics?.costMicros ?? 0) / 1_000_000,
          clicks: Number(r.metrics?.clicks ?? 0),
          impressions: Number(r.metrics?.impressions ?? 0),
          conversions: Number(r.metrics?.conversions ?? 0),
          conv_value: Number(r.metrics?.conversionsValue ?? 0),
        },
      })),
    );
    if (!cust?.currencyCode) {
      return { ok: false, reason: "read_failed", message: "Google Ads did not report the account currency." };
    }
    const out: FetchOk = {
      ok: true,
      daily,
      currency: cust.currencyCode.toUpperCase(),
      row_count: raw.length,
      truncated: false,
      caveats: tzCaveat("Google Ads", cust.timeZone ?? null, w.tz),
      params: { source: "google_ads.customer", segment: "date", since: w.since, until: w.until, account_timezone: cust.timeZone ?? null },
    };
    if (ctx.breakdown === "campaign") {
      const byCampaign = await fetchGoogleDailySeries(ctx.tenant_id, {
        custom_range: { since: w.since, until: w.until },
      });
      out.breakdown = sumByKey(
        byCampaign.rows.map((r) => ({
          key: r.campaign_name || r.campaign_id,
          parts: {
            spend: r.spend_usd,
            clicks: r.clicks,
            impressions: r.impressions,
            conversions: r.conversions,
            conv_value: r.conversions_value_usd,
          },
        })),
        "spend",
      );
    }
    return out;
  } catch (e) {
    return failFrom(e, "Google Ads");
  }
}

function adFamily(fetch: MetricImpl["fetch"], prefix: "meta" | "google"): Record<string, MetricImpl> {
  return {
    [`${prefix}_ad_spend`]: { value: (p) => p.spend ?? 0, fetch },
    [`${prefix}_clicks`]: { value: (p) => p.clicks ?? 0, fetch },
    [`${prefix}_cpc`]: { value: (p) => div(p.spend, p.clicks), fetch },
    [`${prefix}_conversions`]: { value: (p) => p.conversions ?? 0, fetch },
    [`${prefix}_cpa`]: { value: (p) => div(p.spend, p.conversions), fetch },
    [`${prefix}_roas`]: { value: (p) => div(p.conv_value, p.spend), fetch },
  };
}

export async function fetchAdSpendTotal(
  ctx: MetricFetchCtx,
  w: ResolvedWindow,
  deps: { meta: typeof fetchMetaAds; google: typeof fetchGoogleAds } = { meta: fetchMetaAds, google: fetchGoogleAds },
): Promise<FetchResult> {
  const inner = { ...ctx, breakdown: undefined };
  const [meta, google] = await Promise.all([deps.meta(inner, w), deps.google(inner, w)]);
  const platforms: Array<{ name: string; r: FetchResult }> = [
    { name: "Meta", r: meta },
    { name: "Google Ads", r: google },
  ];
  const connected = platforms.filter((p) => !(p.r.ok === false && p.r.reason === "not_connected"));
  if (connected.length === 0) {
    return { ok: false, reason: "not_connected", message: "No ad account is connected (Meta or Google Ads)." };
  }
  const failed = connected.find((p) => p.r.ok === false);
  if (failed && failed.r.ok === false) {
    return {
      ok: false,
      reason: failed.r.reason,
      message: `${failed.r.message} Total ad spend is not given without it, because it would understate spend.`,
    };
  }
  const oks = connected.map((p) => ({ name: p.name, r: p.r as FetchOk }));
  const currencies = [...new Set(oks.map((p) => p.r.currency))];
  if (currencies.length > 1) {
    return {
      ok: false,
      reason: "currency_mismatch",
      message: `The ad accounts use different currencies (${oks.map((p) => `${p.name} ${p.r.currency}`).join(", ")}). No FX conversion is done, so no total is given.`,
    };
  }
  const rows: Array<{ date: string; parts: Parts }> = [];
  for (const p of oks) for (const d of p.r.daily ?? []) rows.push({ date: d.date, parts: { spend: d.parts.spend ?? 0 } });
  const caveats = oks.flatMap((p) => p.r.caveats);
  for (const p of platforms) {
    if (p.r.ok === false && p.r.reason === "not_connected") caveats.push(`${p.name} is not connected, so it is not in this total.`);
  }
  const out: FetchOk = {
    ok: true,
    daily: sumByDate(rows),
    currency: currencies[0] ?? null,
    row_count: oks.reduce((n, p) => n + p.r.row_count, 0),
    truncated: false,
    caveats,
    params: { platforms: oks.map((p) => ({ platform: p.name, ...p.r.params })) },
  };
  if (ctx.breakdown === "platform") {
    out.breakdown = oks.map((p) => ({
      key: p.name,
      parts: { spend: (p.r.daily ?? []).reduce((s, d) => s + (d.parts.spend ?? 0), 0) },
    }));
  }
  return out;
}

export const adMetrics: Record<string, MetricImpl> = {
  ...adFamily(fetchMetaAds, "meta"),
  ...adFamily(fetchGoogleAds, "google"),
  ad_spend_total: { value: (p) => p.spend ?? 0, fetch: (ctx, w) => fetchAdSpendTotal(ctx, w) },
};
