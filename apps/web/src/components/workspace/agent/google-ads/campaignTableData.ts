import { formatCurrency } from "../../metrics/currency";
import { BarChart3, CalendarDays } from "lucide-react";
import { openGoogleCampaignEditor } from "../../actions/managed-campaigns/google/googleEditorApi";
import { campaignThumbnail } from "../../actions/campaigns/campaignMedia";
import type { ExtraCell, ExtraColumn, ExtraTableData } from "../../actions/ExtraTable";
import { count, money, roas, type GadsDailyBudget, type GadsPayload } from "./types";

const GADS_COLUMNS: readonly ExtraColumn[] = [
  { label: "Campaign", align: "left" },
  { label: "Status", align: "left" },
  { label: "Spend" },
  { label: "Conv." },
  { label: "CPA" },
  { label: "Conv. value" },
];

function gadsStatusCell(c: GadsPayload["campaigns"][number]): ExtraCell {
  if (c.status === "ENABLED" && c.limited_by_budget) {
    return { text: "Limited", chip: "warn", title: "Limited by budget" };
  }
  if (c.status === "ENABLED") return { text: "Enabled", chip: "good" };
  const label = c.status ? c.status.charAt(0) + c.status.slice(1).toLowerCase() : "Unknown";
  return { text: label, chip: "muted" };
}

const VIDEO_COLUMNS: readonly ExtraColumn[] = [{ label: "Views" }, { label: "View rate" }, { label: "Cost per view" }];

const pctCell = (v: number | null | undefined): ExtraCell => ({ text: typeof v === "number" ? `${v}%` : "-" });

export function gadsCampaignTable(d: GadsPayload, opts: { canEdit?: boolean } = {}): ExtraTableData {
  const t = d.totals;
  const video = d.platform === "youtube_ads";
  const budgets = d.campaigns.some((c) => c.daily_budget !== undefined);
  const editor = opts.canEdit === true;
  const channel = video ? "youtube_ads" : "google_ads";
  const budgetCells = (v: number | null | undefined, shared?: boolean): ExtraCell[] => (budgets ? [budgetCell(v, shared)] : []);
  const editAction = (id: string, launch: boolean, channelType?: string | null) =>
    editor && channelType !== "VIDEO" ? [{ label: launch ? "Launch…" : "Edit", onClick: () => openGoogleCampaignEditor({ campaign_id: id }, channel) }] : undefined;
  const paused = editor ? (d.paused_campaigns ?? []) : [];
  const dashCells = (n: number): ExtraCell[] => Array.from({ length: n }, () => ({ text: "-", tone: "dim" as const }));
  const formatMoney = (value: number | null, ratio = false) => "currency" in d ? formatCurrency(value, d.currency, ratio) : money(value, ratio);
  const videoCells = (v: { views?: number | null; view_rate?: number | null; cpv?: number | null }): ExtraCell[] =>
    video ? [{ text: typeof v.views === "number" ? count(v.views) : "-" }, pctCell(v.view_rate), { text: formatMoney(v.cpv ?? null, true) }] : [];
  return {
    title: "Campaign performance",
    icon: BarChart3,
    columns: [
      ...GADS_COLUMNS.slice(0, 2),
      ...(budgets ? [{ label: "Daily budget" }] : []),
      GADS_COLUMNS[2],
      ...(video ? VIDEO_COLUMNS : []),
      ...GADS_COLUMNS.slice(3),
    ],
    rows: [
      ...d.campaigns.map((c) => ({
        id: c.id,
        cells: [
          { text: c.name, href: c.url, media: campaignThumbnail(video ? "youtube_ads" : "google_ads", c, c.id, c.name, d.campaigns.map((campaign) => campaign.id).join(",")) },
          gadsStatusCell(c),
          ...budgetCells(c.daily_budget, c.budget_shared),
          { text: formatMoney(c.spend), strong: true },
          ...videoCells(c),
          { text: count(c.conversions) },
          { text: formatMoney(c.cpa, true) },
          { text: formatMoney(c.conv_value) },
        ],
        actions: editAction(c.id, c.status === "PAUSED", c.channel_type),
      })),
      ...paused.map((c) => ({
        id: c.id,
        cells: [{ text: c.name, href: c.url }, { text: "Paused", chip: "muted" as const }, ...budgetCells(c.daily_budget), { text: formatMoney(0), strong: true }, ...dashCells(3)],
        actions: editAction(c.id, true),
        tail: true,
      })),
    ],
    ...(paused.length > 0
      ? {
          tailToggle: {
            show: (n: number) => `Show ${n} paused ${n === 1 ? "campaign" : "campaigns"}`,
            hide: "Hide paused campaigns",
            noneAbove: "No campaign spent or ran in this period.",
          },
        }
      : {}),
    footer: t
      ? [
          { text: `${t.campaigns} ${t.campaigns === 1 ? "campaign" : "campaigns"}` },
          { text: `ROAS ${roas(t.roas)}`, tone: "dim" },
          ...budgetCells(d.daily_budget ? d.daily_budget.total_daily_budget_usd : budgets ? null : undefined),
          { text: formatMoney(t.spend) },
          ...videoCells(t),
          { text: count(t.conversions) },
          { text: formatMoney(t.cpa, true) },
          { text: formatMoney(t.conv_value) },
        ]
      : undefined,
    empty: d.error_code ? "Zavi could not read your campaigns just now." : "No campaign spent or ran in this period.",
    caption: d.campaigns_note ?? "Numbers as reported by Google Ads.",
  };
}

function budgetCell(usd: number | null | undefined, shared?: boolean): ExtraCell {
  if (usd === undefined || usd === null) return { text: "-", tone: "dim", title: usd === null ? "Not read" : undefined };
  return { text: `${money(usd)} / day`, ...(shared ? { sub: "shared", title: "A budget several campaigns share" } : {}) };
}

const BREAKDOWN_CAMPAIGN_COLUMNS = 4;

function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function pctOf(spend: number, budget: number | null): ExtraCell {
  if (budget === null || !(budget > 0)) return { text: "-", tone: "dim" };
  const pct = Math.round((spend / budget) * 100);
  return { text: `${pct}%`, tone: pct > 150 ? "bad" : "dim" };
}

export function gadsDailyBudgetTable(d: GadsPayload): ExtraTableData | null {
  const b: GadsDailyBudget | null | undefined = d.daily_budget;
  if (!b || d.error_code) return null;
  const yt = d.platform === "youtube_ads";
  const shown = b.campaigns.slice(0, BREAKDOWN_CAMPAIGN_COLUMNS);
  const shownIds = new Set(shown.map((c) => c.campaign_id));
  const hasOther = b.campaigns.length > shown.length;
  const budget = b.total_daily_budget_usd;
  const split = (byCampaign: Record<string, number>): ExtraCell[] => {
    const cells: ExtraCell[] = shown.map((c) => {
      const v = byCampaign[c.campaign_id] ?? 0;
      return v > 0 ? { text: money(v) } : { text: "$0", tone: "dim" };
    });
    if (hasOther) {
      const other = Object.entries(byCampaign).reduce((a, [id, v]) => (shownIds.has(id) ? a : a + v), 0);
      cells.push({ text: money(other), tone: other > 0 ? undefined : "dim" });
    }
    return cells;
  };
  const budgetText: ExtraCell = { text: budget === null ? "-" : money(budget), tone: "dim" };
  const rows = [
    ...(b.today
      ? [{ id: "today", cells: [{ text: "Today", strong: true, sub: "so far" }, { text: money(b.today.spend_usd), strong: true }, budgetText, pctOf(b.today.spend_usd, budget), ...split(b.today.by_campaign)] }]
      : []),
    ...b.days.map((day) => ({ id: day.date, cells: [{ text: dayLabel(day.date) }, { text: money(day.spend_usd), strong: true }, budgetText, pctOf(day.spend_usd, budget), ...split(day.by_campaign)] })),
  ];
  const n = b.active_campaigns;
  const headline =
    budget === null
      ? `${n} enabled ${n === 1 ? "campaign" : "campaigns"}, some budgets could not be read`
      : `${money(budget)} / day across ${n} enabled ${n === 1 ? "campaign" : "campaigns"}`;
  return {
    id: "gads_daily_budget",
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
    empty:
      b.history_unreadable || !b.today
        ? `Zavi could not read ${yt ? "YouTube Ads" : "Google Ads"} spend just now. Refresh in a minute.`
        : yt ? "No YouTube Ads spend in this range yet." : "No Google Ads spend in this range yet.",
    caption: [
      "Google reports only each campaign's budget today, so past days are compared with today's budget. A budget several campaigns share is counted once.",
      yt ? "Video and Demand Gen campaigns only; Demand Gen can also run on Discover and Gmail." : null,
      "Google may spend up to twice a daily budget on a busy day and evens it out over the month.",
      b.today ? "Today's spend is in your account's time zone and keeps rising until the day ends." : "Zavi could not read today's spend.",
      b.history_unreadable ? "Zavi could not read the earlier days' spend, so they are not shown." : null,
    ]
      .filter(Boolean)
      .join(" "),
  };
}
