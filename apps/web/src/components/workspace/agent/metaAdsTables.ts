import { createElement } from "react";
import { MetaCampaignThumbnail } from "../actions/campaigns/MetaCampaignThumbnail";
import { BarChart3, CalendarDays } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ExtraCell, ExtraTableData } from "../actions/ExtraTable";
import type { ChannelChrome } from "./legacyChannelActions";
import { count, DEFAULT_RANGES, money, roas } from "./google-ads/types";
import { roasVerdict } from "../metrics/format";
import { openMetaCampaignEditor } from "../actions/managed-campaigns/meta/metaEditorApi";

type MetaCampaign = {
  channel: string;
  campaign_id: string;
  campaign_name: string;
  status?: string | null;
  spend_usd: number;
  conversions: number;
  revenue_usd: number;
  cpa_usd: number | null;
  manage_url: string | null;
  active_daily_budget_usd?: number | null;
};

type MetaDailyBudget = {
  total_daily_budget_usd: number | null;
  active_campaigns: number;
  today: { date: string | null; spend_usd: number; by_campaign?: Record<string, number> } | null;
  days: Array<{ date: string; spend_usd: number; by_campaign: Record<string, number> }>;
  campaigns: Array<{ campaign_id: string; campaign_name: string; status: string | null; daily_budget_usd: number | null }>;
  truncated: boolean;
  history_unreadable?: boolean;
};

type MetaTotals = {
  channel: string;
  connected: boolean;
  spend_usd: number;
  conversions: number;
  revenue_usd: number;
  roas: number | null;
  cpa_usd: number | null;
  ctr_percent: number | null;
};

type MetaPayload = {
  window?: string;
  connected?: { meta?: boolean };
  channels?: MetaTotals[];
  campaigns?: MetaCampaign[];
  meta_daily_budget?: MetaDailyBudget | null;
  channel_errors?: { meta?: { code: string; message: string } };
  served_last_good?: boolean;
  served_last_good_channels?: string[];
};

const asPayload = (payload: unknown): MetaPayload | null =>
  payload && typeof payload === "object" && "channels" in payload ? (payload as MetaPayload) : null;

const metaTotals = (d: MetaPayload) => d.channels?.find((c) => c.channel === "meta") ?? null;

const unread = (d: MetaPayload) =>
  Boolean(d.channel_errors?.meta) &&
  !(d.served_last_good_channels ? d.served_last_good_channels.includes("meta") : d.served_last_good === true) &&
  (d.campaigns ?? []).every((c) => c.channel !== "meta") &&
  !((metaTotals(d)?.spend_usd ?? 0) > 0);

const activeCampaigns = (d: MetaPayload) =>
  (d.campaigns ?? []).filter((c) => c.channel === "meta" && c.status === "ACTIVE");

export function metaKpis(payload: unknown): ChannelMetric[] {
  const d = asPayload(payload);
  const t = d ? metaTotals(d) : null;
  if (!d || !t || unread(d)) return [];
  const windowKind = d.window?.replace(/^last_/, "") ?? null;
  const rows: Array<[string, number | null, string]> = [
    ["spend", t.spend_usd, "usd"],
    ["cpa", t.cpa_usd, "usd"],
    ["conversions", t.conversions, "count"],
    ["conv_value", t.revenue_usd, "usd"],
    ["roas", t.roas, "ratio"],
    ["ctr", t.ctr_percent, "pct"],
  ];
  return rows.map(([key, value, unit]) => ({
    key,
    value: value ?? Number.NaN,
    unit,
    window_kind: windowKind,
    day: "",
    grounded: value !== null,
    prev_value: null,
    prev_day: null,
    ...(key === "roas" ? roasVerdict(value) : {}),
  }));
}

function statusCell(status: string | null | undefined): ExtraCell {
  if (status === "ACTIVE") return { text: "Active", chip: "good" };
  const label = status ? status.charAt(0) + status.slice(1).toLowerCase() : "Unknown";
  return { text: label, chip: "muted" };
}

export function metaCampaignTable(payload: unknown, opts: { canEdit?: boolean } = {}): ExtraTableData[] {
  const d = asPayload(payload);
  if (!d || !Array.isArray(d.campaigns)) return [];
  const rows = activeCampaigns(d);
  const paused = opts.canEdit ? d.campaigns.filter((c) => c.channel === "meta" && c.status === "PAUSED") : [];
  const editAction = (c: MetaCampaign, launch: boolean) =>
    opts.canEdit ? [{ label: launch ? "Launch…" : "Edit", onClick: () => openMetaCampaignEditor({ campaign_id: c.campaign_id }) }] : undefined;
  const cellsOf = (c: MetaCampaign, all: MetaCampaign[]): ExtraCell[] => [
    { text: c.campaign_name.split("\n")[0], href: c.manage_url, title: c.campaign_name, media: createElement(MetaCampaignThumbnail, { key: c.campaign_id, campaignId: c.campaign_id, campaignIds: all.map((campaign) => campaign.campaign_id).join(","), name: c.campaign_name }) },
    statusCell(c.status),
    budgetCell(c.active_daily_budget_usd),
    { text: money(c.spend_usd), strong: true },
    { text: count(c.conversions) },
    { text: money(c.cpa_usd, true) },
    { text: money(c.revenue_usd) },
  ];
  const spend = rows.reduce((a, c) => a + c.spend_usd, 0);
  const conversions = rows.reduce((a, c) => a + c.conversions, 0);
  const value = rows.reduce((a, c) => a + c.revenue_usd, 0);
  const breakdown = metaDailyBudgetTable(d);
  return [
    ...(breakdown ? [breakdown] : []),
    {
      title: "Active campaigns",
      icon: BarChart3,
      columns: [
        { label: "Campaign", align: "left" },
        { label: "Status", align: "left" },
        { label: "Daily budget" },
        { label: "Spend" },
        { label: "Conv." },
        { label: "CPA" },
        { label: "Conv. value" },
      ],
      rows: [
        ...rows.map((c) => ({ id: c.campaign_id, cells: cellsOf(c, rows), actions: editAction(c, false) })),
        ...paused.map((c) => ({ id: c.campaign_id, cells: cellsOf(c, paused), actions: editAction(c, true), tail: true })),
      ],
      ...(paused.length > 0
        ? {
            tailToggle: {
              show: (n: number) => `Show ${n} paused ${n === 1 ? "campaign" : "campaigns"}`,
              hide: "Hide paused campaigns",
              noneAbove: "No Meta campaign is active right now.",
            },
          }
        : {}),
      footer: rows.length
        ? [
            { text: `${rows.length} ${rows.length === 1 ? "campaign" : "campaigns"}` },
            { text: `ROAS ${roas(spend > 0 ? value / spend : null)}`, tone: "dim" },
            budgetCell(totalBudget(rows)),
            { text: money(spend) },
            { text: count(conversions) },
            { text: money(conversions > 0 ? spend / conversions : null, true) },
            { text: money(value) },
          ]
        : undefined,
      empty: unread(d) ? "Zavi could not read your Meta campaigns, so none are listed." : "No Meta campaign is active right now.",
      caption: "Numbers as reported by Meta Ads.",
    },
  ];
}

export function metaChrome(payload: unknown): ChannelChrome | null {
  const d = asPayload(payload);
  if (!d) return null;
  const error = d.channel_errors?.meta;
  const n = activeCampaigns(d).length;
  return {
    connected: d.connected?.meta === true,
    ranges: DEFAULT_RANGES,
    period: null,
    account: metaTotals(d) && !unread(d) ? { name: null, sub: `${n} active ${n === 1 ? "campaign" : "campaigns"}` } : null,
    problem: error
      ? {
          text: /token|auth|permission/i.test(error.code)
            ? "Meta stopped accepting Zavi's access, so these numbers could not be read. Reconnect to bring them back."
            : "Zavi could not read your Meta Ads account just now. Try Refresh in a minute.",
          reconnect: /token|auth|permission/i.test(error.code),
        }
      : null,
    plan: null,
  };
}

export function metaCampaignLinks(payload: unknown): Record<string, string> {
  const d = asPayload(payload);
  const out: Record<string, string> = {};
  for (const c of d?.campaigns ?? []) {
    if (c.channel === "meta" && c.manage_url) out[c.campaign_name.split("\n")[0]] = c.manage_url;
  }
  return out;
}

function budgetCell(usd: number | null | undefined): ExtraCell {
  if (usd === undefined) return { text: "-", tone: "dim" };
  if (usd === null) return { text: "-", tone: "dim", title: "Not read, or the campaign has a lifetime budget" };
  return { text: `${money(usd)} / day` };
}

function totalBudget(rows: MetaCampaign[]): number | null | undefined {
  if (rows.some((c) => c.active_daily_budget_usd === undefined)) return undefined;
  if (rows.some((c) => c.active_daily_budget_usd === null)) return null;
  return rows.reduce((a, c) => a + (c.active_daily_budget_usd ?? 0), 0);
}

const BREAKDOWN_CAMPAIGN_COLUMNS = 4;

function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function pctOf(spend: number, budget: number | null): ExtraCell {
  if (budget === null || !(budget > 0)) return { text: "-", tone: "dim" };
  const pct = Math.round((spend / budget) * 100);
  return { text: `${pct}%`, tone: pct > 110 ? "bad" : "dim" };
}

export function metaDailyBudgetTable(d: MetaPayload): ExtraTableData | null {
  const b = d.meta_daily_budget;
  if (!b || unread(d)) return null;
  const shown = b.campaigns.slice(0, BREAKDOWN_CAMPAIGN_COLUMNS);
  const shownIds = new Set(shown.map((c) => c.campaign_id));
  const hasOther = b.campaigns.length > shown.length;
  const budget = b.total_daily_budget_usd;
  const split = (byCampaign: Record<string, number> | null): ExtraCell[] => {
    const cells: ExtraCell[] = shown.map((c) => {
      if (!byCampaign) return { text: "", tone: "dim" };
      const v = byCampaign[c.campaign_id] ?? 0;
      return v > 0 ? { text: money(v) } : { text: "$0", tone: "dim" };
    });
    if (hasOther) {
      const other = byCampaign
        ? Object.entries(byCampaign).reduce((a, [id, v]) => (shownIds.has(id) ? a : a + v), 0)
        : null;
      cells.push(other === null ? { text: "", tone: "dim" } : { text: money(other), tone: other > 0 ? undefined : "dim" });
    }
    return cells;
  };
  const rows = [];
  if (b.today) {
    rows.push({
      id: "today",
      cells: [
        { text: "Today", strong: true, sub: "so far" },
        { text: money(b.today.spend_usd), strong: true },
        { text: budget === null ? "-" : money(budget), tone: budget === null ? ("dim" as const) : undefined },
        pctOf(b.today.spend_usd, budget),
        ...split(b.today.by_campaign ?? null),
      ],
    });
  }
  for (const day of b.days) {
    rows.push({
      id: day.date,
      cells: [
        { text: dayLabel(day.date) },
        { text: money(day.spend_usd), strong: true },
        { text: budget === null ? "-" : money(budget), tone: "dim" as const },
        pctOf(day.spend_usd, budget),
        ...split(day.by_campaign),
      ],
    });
  }
  const headline =
    budget === null
      ? `${b.active_campaigns} active ${b.active_campaigns === 1 ? "campaign" : "campaigns"}, some budgets could not be read`
      : `${money(budget)} / day across ${b.active_campaigns} active ${b.active_campaigns === 1 ? "campaign" : "campaigns"}`;
  return {
    id: "meta_daily_budget",
    title: `Daily budget: ${headline}`,
    icon: CalendarDays,
    columns: [
      { label: "Day", align: "left" },
      { label: "Spend" },
      { label: "Budget" },
      { label: "Used" },
      ...shown.map((c) => ({ label: c.campaign_name.length > 22 ? `${c.campaign_name.slice(0, 21)}…` : c.campaign_name })),
      ...(hasOther ? [{ label: "Other" }] : []),
    ],
    rows,
    pageSize: 14,
    empty: b.history_unreadable || !b.today ? "Zavi could not read Meta spend just now. Refresh in a minute." : "No Meta spend in this range yet.",
    caption: [
      "Meta reports only each campaign's budget today, so past days are compared with today's budget.",
      b.today ? "Today's spend is in your ad account's time zone and keeps rising until the day ends." : "Zavi could not read today's spend.",
      b.history_unreadable ? "Zavi could not read the earlier days' spend, so they are not shown." : null,
      b.truncated ? "Meta returned only part of the per-day numbers for this range." : null,
    ]
      .filter(Boolean)
      .join(" "),
  };
}
