
import { z } from "zod";
import { getChatgptAdsApiKey } from "@/services/connectors/chatgpt-ads/key-provider";
import {
  getChatgptAdsCampaignInsights,
  getChatgptAdsConversionInsights,
  listChatgptAdsCampaigns,
  type ChatgptAdsInsightRow,
} from "@/services/connectors/chatgpt-ads/client";
import { chatgptAdsGet } from "@/services/connectors/chatgpt-ads/http";
import { purchaseWindow } from "@/services/connectors/chatgpt-ads/purchases";
import {
  assertOwnedRows,
  normalizeCampaignName,
  ownsCampaignName,
  resolveTenantCampaignPrefix,
} from "@/services/connectors/chatgpt-ads/tenant-scope";
import { type ToolSpec } from "@/services/tools/types";
import { readFundingContext } from "@/services/ads-wallet/funding-context";
import { readProposalReadiness } from "@/services/channels/chatgpt-ads/proposal-readiness";
import { readRecentChatgptCreations } from "@/services/connectors/chatgpt-ads/recent-creations";
import { remainingWalletRequest } from "@/services/channels/chatgpt-ads/wallet-request";

const DEFAULT_DAYS = 14;

const MAX_CAMPAIGNS = 50;

const inputSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .default(DEFAULT_DAYS)
    .describe("Complete days in the ad account timezone, ending yesterday. Default 14, maximum 90."),
});

export type CampaignReport = {
  id: string;
  name: string;
  status: string | null;
  updated_at?: number;
  bidding_type?: string;
  budget?: { lifetime_spend_limit_micros?: number; daily_spend_limit_micros?: number };
  start_time?: number | null;
  end_time?: number | null;
  impressions?: number;
  clicks?: number;
  spend?: number;
  ctr?: number;
  cpc?: number;
  conversions?: number;
  click_through_conversions?: number;
  view_through_conversions?: number;
  period_covered?: string;
  period_unconfirmed?: boolean;
  requested_period_confirmed?: boolean;
};

export function confirmsRequestedPeriod(rows: ChatgptAdsInsightRow[], period: ReturnType<typeof purchaseWindow>): boolean {
  if (rows.length !== 1) return false;
  const row = rows[0];
  if (!Number.isSafeInteger(row.start_time) || !Number.isSafeInteger(row.end_time) || row.end_time! <= row.start_time!) return false;
  if (row.timezone && row.timezone !== period.timezone) return false;
  try {
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone: period.timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    const stamp = (seconds: number) => {
      const parts = format.formatToParts(new Date(seconds * 1000));
      const get = (key: string) => parts.find(p => p.type === key)?.value;
      return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
    };
    const next = new Date(Date.parse(`${period.to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return stamp(row.start_time!) === `${period.from} 00:00:00`
      && [`${next} 00:00:00`, `${period.to} 23:59:59`].includes(stamp(row.end_time!));
  } catch { return false; }
}

function sumOf(rows: ChatgptAdsInsightRow[], key: "impressions" | "clicks" | "spend"): number | undefined {
  const present = rows.map((r) => r[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (present.length === 0 || present.length !== rows.length) return undefined;
  return present.reduce((a, b) => a + b, 0);
}

function collapse(rows: ChatgptAdsInsightRow[]): Omit<CampaignReport, "id" | "name" | "status"> {
  const out: Omit<CampaignReport, "id" | "name" | "status"> = {};
  const impressions = sumOf(rows, "impressions");
  const clicks = sumOf(rows, "clicks");
  const spend = sumOf(rows, "spend");
  if (impressions !== undefined) out.impressions = impressions;
  if (clicks !== undefined) out.clicks = clicks;
  if (spend !== undefined) out.spend = spend;

  if (rows.length === 1) {
    if (typeof rows[0].ctr === "number") out.ctr = rows[0].ctr;
    if (typeof rows[0].cpc === "number") out.cpc = rows[0].cpc;
  }

  const readable = rows.map((r) => r.readable_time).filter((v): v is string => typeof v === "string");
  if (readable.length === 1) out.period_covered = readable[0];
  else if (readable.length > 1) out.period_covered = `${readable[0]} to ${readable[readable.length - 1]}`;

  return out;
}

export async function readChatgptPerformance(tenantId: string, requestedDays = DEFAULT_DAYS, log: (message: string, meta: Record<string, unknown>) => void = () => {}, now = new Date()) {
  const { days } = inputSchema.parse({ days: requestedDays });

  const prefix = await resolveTenantCampaignPrefix(tenantId);
  const apiKey = await getChatgptAdsApiKey();

  const listed = await listChatgptAdsCampaigns(apiKey);
  const all = listed.campaigns;
  const pages_exhausted = listed.pages_exhausted || listed.unreadable_campaigns > 0;

  const mine = all.filter((c) => ownsCampaignName(c.name, prefix));
  const recent_creations = await readRecentChatgptCreations(tenantId, apiKey, prefix, mine);

  const claimed = all.filter((c) => normalizeCampaignName(c.name).startsWith(prefix));
  const unclaimable = claimed.length - mine.length;
  const unclaimableNote =
    unclaimable > 0
      ? {
          names_unclaimable: unclaimable,
          names_unclaimable_note:
            `${unclaimable} campaign name(s) start with this workspace's prefix but could not be ` +
            "claimed: a name may not carry a second `--` after the prefix, because that is " +
            "ambiguous with a longer workspace's name. They are NOT counted below. Say that " +
            "those campaigns exist and need renaming; never report this as nothing running.",
        }
      : {};

  if (mine.length === 0 && pages_exhausted) {
    return {
      source: "chatgpt_ads_api",
      recent_creations,
      unverified: true,
      campaign_name_prefix: prefix,
      ...unclaimableNote,
      message:
        "The campaign list in Zavi's ad account could not be read in full (the page budget ran " +
        "out while more campaigns were still listed), and none of the part that was read belongs " +
        "to this workspace. This is NOT a finding that Zavi runs nothing here and NOT zero spend: " +
        "report the read as incomplete, and use the operator-pasted snapshot if there is one.",
    };
  }

  if (mine.length === 0) {
    return {
      source: "chatgpt_ads_api",
      recent_creations,
      ...(unclaimable === 0 && recent_creations.status === "read" && recent_creations.complete && recent_creations.campaigns.length === 0 ? { no_campaigns_for_tenant: true } : {}),
      no_campaigns_in_current_inventory: unclaimable === 0,
      ...(unclaimable > 0 ? { unverified: true } : {}),
      campaign_name_prefix: prefix,
      ...unclaimableNote,
      message:
        unclaimable > 0
          ? `Campaign name(s) in Zavi's ad account start with ${prefix}… but none could be claimed ` +
            "unambiguously, so nothing could be read for this workspace. Do NOT say Zavi runs " +
            "nothing here and do NOT report zero spend: say the campaigns need renaming, and use " +
            "the operator-pasted snapshot if there is one."
          : "No ChatGPT ad campaigns were returned for this workspace in the current inventory. " +
            "This does not prove that a campaign was never created: archived objects can be omitted. " +
            (recent_creations.campaigns.length ? "Read recent_creations for recorded campaign references and their verified current state; do not propose a duplicate based only on this list. "
              : recent_creations.status !== "read" || !recent_creations.complete ? "Creation history could not be read completely; past creation is unknown. " : "No applied creation appears in the checked history. ") +
            "This is not a measured zero-spend result. A new campaign can still be prepared when requested.",
    };
  }

  const truncated = mine.length > MAX_CAMPAIGNS || pages_exhausted;
  const selected = mine.slice(0, MAX_CAMPAIGNS);
  const ownedIds = new Set(selected.map((c) => c.id));
  const account = await chatgptAdsGet<{ timezone: string; currency_code?: string }>(apiKey, "/ad_account");
  const period = purchaseWindow(days, account.timezone, now);
  const timeRange = JSON.stringify({ type: "date_range", since: period.from, until: period.to, timezone: period.timezone });

  const reportingWarnings: string[] = [];
  const perCampaign: Array<{ campaign: typeof selected[number]; rows: ChatgptAdsInsightRow[] }> = [];
  for (let i = 0; i < selected.length; i += 5) {
    perCampaign.push(...await Promise.all(selected.slice(i, i + 5).map(async c => ({
      campaign: c, rows: await getChatgptAdsCampaignInsights(apiKey, c.id, timeRange).catch(() => { reportingWarnings.push("Delivery metrics are unavailable for one or more campaigns."); return []; }),
    }))));
  }

  const flattened = perCampaign.flatMap(({ campaign, rows }) =>
    rows.map((r) => ({ campaign_id: campaign.id, row_campaign_id: r.campaign_id ?? null, row: r })),
  );
  const { kept, dropped } = assertOwnedRows(flattened, ownedIds);
  const rowsById = new Map<string, ChatgptAdsInsightRow[]>();
  for (const k of kept) {
    const list = rowsById.get(k.campaign_id) ?? [];
    list.push(k.row);
    rowsById.set(k.campaign_id, list);
  }

  const conversionRows = await getChatgptAdsConversionInsights(apiKey, [...ownedIds], timeRange).catch(() => { reportingWarnings.push("Conversion reporting is unavailable."); return []; });
  const conversionsById = new Map(
    conversionRows.filter((r) => ownedIds.has(r.entity_id)).map((r) => [r.entity_id, r]),
  );

  const campaigns: CampaignReport[] = selected.map((c) => {
    const confirmed = confirmsRequestedPeriod(rowsById.get(c.id) ?? [], period);
    const line: CampaignReport = {
      id: c.id,
      name: c.name,
      status: c.status ?? null,
      updated_at: c.updated_at,
      bidding_type: c.bidding_type,
      budget: c.budget,
      start_time: c.start_time,
      end_time: c.end_time,
      ...collapse(rowsById.get(c.id) ?? []),
      requested_period_confirmed: confirmed,
      ...(!confirmed ? { period_unconfirmed: true } : {}),
    };
    const conv = conversionsById.get(c.id);
    if (conv) {
      if (typeof conv.conversions === "number") line.conversions = conv.conversions;
      if (typeof conv.click_through_conversions === "number") {
        line.click_through_conversions = conv.click_through_conversions;
      }
      if (typeof conv.view_through_conversions === "number") {
        line.view_through_conversions = conv.view_through_conversions;
      }
    }
    return line;
  });

  const totals: Record<string, number> = {};
  for (const key of ["impressions", "clicks", "spend", "conversions", "click_through_conversions", "view_through_conversions"] as const) {
    const present = campaigns
      .map((c) => c[key])
      .filter((v): v is number => typeof v === "number");
    if (present.length > 0 && present.length === campaigns.length) totals[key] = present.reduce((a, b) => a + b, 0);
  }

  log("read chatgpt ads performance", {
    campaigns: campaigns.length,
    days,
    dropped_rows: dropped,
  });

  return {
    source: "chatgpt_ads_api",
    recent_creations,
    account: "zavi_shared_openai_ad_account",
    currency: account.currency_code ?? null,
    campaign_name_prefix: prefix,
    period: { ...period, time_range: timeRange },
    campaign_count: campaigns.length,
    ...unclaimableNote,
    ...(truncated
      ? {
          truncated: true,
          truncation_note:
            `More than ${MAX_CAMPAIGNS} campaigns match this workspace; only the first ${MAX_CAMPAIGNS} ` +
            "were read, so the total below is partial. Say so if you quote it.",
        }
      : {}),
    ...(dropped > 0
      ? {
          rows_dropped: dropped,
          rows_dropped_note:
            `${dropped} insight row(s) the API returned did not match the campaigns asked for and ` +
            "were dropped, so the total below may understate these campaigns. Say so if you quote it.",
        }
      : {}),
    ...(campaigns.some((c) => c.period_unconfirmed)
      ? {
          period_unconfirmed: true,
          period_unconfirmed_note:
            "The returned reporting bounds do not confirm the complete requested window. These figures " +
            "may cover a different or shorter interval. Do not quote a figure marked " +
            "period_unconfirmed with a date range.",
        }
      : {}),
    campaigns,
    reporting_warning: [...new Set(reportingWarnings)].join(" ") || undefined,
    totals_across_your_campaigns_only: totals,
    note:
      "These figures come from Zavi's OpenAI Ads Manager account, covering only the campaigns Zavi " +
      "runs for this workspace. A metric absent from a campaign line was not returned by the API; " +
      "do not fill it in or derive it.",
  };
}

export const chatgptAdsReadPerformanceTool: ToolSpec = {
  name: "chatgpt_ads_read_performance",
  effect: "read",
  description:
    "Read REAL performance for the ChatGPT ad campaigns Zavi runs for this workspace inside Zavi's " +
    "OpenAI Ads Manager account. Returns per-campaign impressions, clicks, spend, CTR, CPC and " +
    "attributed conversions (click-through and view-through separately) for the requested window, " +
    "plus a total across those campaigns and a fresh zavi_ads_wallet balance/reservations snapshot in USD cents. " +
    "That wallet is not the provider account balance or permission to spend; unavailable funding stays unknown. " +
    "Read-only; never edits, pauses or spends. Returns an " +
    "explicit no_campaigns_for_tenant signal only when current inventory and checked creation history are empty. " +
    "recent_creations reconciles recorded launches with current state; archived campaigns can be absent from the list. " +
    "A missing campaign is not proof it was never created. Preparing a new campaign still requires a proposal.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { days } = inputSchema.parse(input);
    const [performance, wallet] = await Promise.all([
      readChatgptPerformance(ctx.tenant_id, days, (message, meta) => ctx.log(message, meta)),
      readFundingContext(ctx.tenant_id),
    ]);
    const [readiness, remaining, ask] = await Promise.all([
      readProposalReadiness(ctx.tenant_id, undefined, wallet),
      remainingWalletRequest(ctx).catch(() => false),
      import("@/services/approvals/approval-envelope").then((m) => m.founderAskFor(ctx, "chatgpt_ads")).catch(() => null),
    ]);
    return { ...performance, zavi_ads_wallet: wallet, proposal_readiness: readiness,
      ...(ask?.plan && ask.source === "ask" ? { founder_direct_ask: { line: ask.line, next_step: "The founder asked for this ad directly. Propose it now with the propose_new_campaign tool, leaving the campaign budget, start_time and end_time out on a USD account (the server sets them from the ask; on a non-USD account send them). Any pending card for it is closed automatically. Do not point the founder at the old card." } } : {}),
      ...(remaining ? { requested_budget: { source: "founder_remaining_wallet_request", available_cents: wallet.status === "read" ? wallet.available_cents : null, top_up_authorized: false,
        next_step: readiness.open_proposals.some(p => p.status === "pending" && p.funding?.status === "covered")
          ? "Review the funded pending proposal on this channel."
          : !readiness.complete ? "The current proposal list could not be fully checked. Refresh it before proposing another campaign or claiming no funded proposal exists."
          : readiness.wallet_daily_plan ? "Propose a campaign using wallet_daily_plan; replace an unfunded proposal rather than recommending its approval." : "No verified daily plan fits the current wallet; do not claim the existing proposal is funded.",
      } } : {}),
    };
  },
};
