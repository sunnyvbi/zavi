"use client";

import { useEffect, useMemo, useState } from "react";
import { CircleDollarSign, ReceiptText, Target, Wallet, Percent, MousePointerClick, Gauge, CalendarDays, ChartLine, Heart, Plus, Rocket, Video } from "lucide-react";
import { MonthlyPlan } from "../../agent/google-ads/MonthlyPlan";
import { BoostPostModal } from "../topActions/BoostPostModal";
import { campaignFetch } from "../managed-campaigns/api";
import { openMetaCampaignEditor } from "../managed-campaigns/meta/metaEditorApi";
import { openGoogleCampaignEditor } from "../managed-campaigns/google/googleEditorApi";
import { openNewTiktokCampaign, openTiktokCampaign } from "../tiktok-campaigns/openCampaign";
import { formatCurrency } from "../../metrics/currency";
import { useChannelPage } from "../../layout/channelPage";
import { LevelTabs, tableEditButton, tablePrimaryButton } from "../managed-campaigns/tableParts";
import { CampaignMetricTile } from "../managed-campaigns/CampaignMetricTile";
import { REDDIT_COLUMNS, STANDARD_COLUMNS, TIKTOK_COLUMNS, VIDEO_COLUMNS, X_COLUMNS } from "./columns";
import { TOP_ACTION_OPEN_EVENT } from "../topActions/api";
import { PaidCampaignTable } from "./PaidCampaignTable";
import { useCampaignSwitch } from "./useCampaignSwitch";
import { spanLabel, type CustomSpan } from "../dateRange";
import { paidAnalyticsModel, type AnalyticsMetric, type AnalyticsRow, type PaidAnalyticsKind } from "./model";

const icons = { spend: CircleDollarSign, cpa: ReceiptText, conversions: Target, conv_value: Wallet, roas: Percent, ctr: MousePointerClick, pacing: Gauge, views: Video, view_rate: Percent, cpv: ReceiptText, cpm: ChartLine, clicks: MousePointerClick, impressions: ChartLine, engagements: Heart, cpc: ReceiptText };
const button = "rounded-full border border-rule bg-cream px-4 py-2 text-sm font-semibold text-ink hover:bg-creamDeep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
const READ_ONLY_GOOGLE_CAMPAIGN_TYPES = new Set(["VIDEO", "UNKNOWN", "UNSPECIFIED"]);
const number = (n: number | null) => n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
function metricValue(metric: AnalyticsMetric, currency: string | null) {
  if (metric.value == null) return "—";
  if (metric.unit === "money") return formatCurrency(metric.value, currency, metric.key === "cpa" || metric.precise);
  if (metric.unit === "pct" && metric.precise) return `${metric.value.toFixed(2)}%`;
  return `${metric.unit === "ratio" ? metric.value.toFixed(2) : number(metric.value)}${metric.unit === "ratio" ? "×" : metric.unit === "pct" ? "%" : ""}`;
}
const META_LEVELS = [["campaigns", "Campaigns"], ["groups", "Ad sets"], ["ads", "Ads"]] as const;
const GOOGLE_LEVELS = [["campaigns", "Campaigns"], ["groups", "Ad groups"], ["ads", "Ads"]] as const;
const CREATE = { campaigns: "Create campaign", groups: "Create ad group", ads: "Create ad" } as const;
type Detail = { rows: AnalyticsRow[]; currency: string | null; complete: boolean };

export function PaidAnalytics({ kind, payload, days, custom = null, canEdit, refreshing, channelName, onChanged }: { kind: PaidAnalyticsKind; payload: unknown; days: number; custom?: CustomSpan | null; canEdit: boolean; refreshing: boolean; channelName: string; onChanged: () => void }) {
  const model = useMemo(() => paidAnalyticsModel(kind, payload), [kind, payload]);
  const page = useChannelPage();
  const active = !page || page.active === "analytics";
  const [level, setLevel] = useState<"campaigns" | "groups" | "ads">("campaigns");
  const [campaignId, setCampaignId] = useState("");
  const [detail, setDetail] = useState<{ key: string; data: Detail } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [boostOpen, setBoostOpen] = useState(false);
  const video = kind === "youtube";
  const tiktok = kind === "tiktok";
  const reddit = kind === "reddit";
  const x = kind === "x" || reddit;
  const tiles = video || tiktok || x;
  const slug = kind === "meta" ? "meta_ads" : tiktok ? "tiktok_ads" : reddit ? "reddit_ads" : x ? "x_ads" : video ? "youtube_ads" : "google_ads";
  const campaign = model.rows.find(row => row.id === campaignId) ?? model.rows[0];
  const since = model.period?.from;
  const until = model.period?.to;
  const key = [slug, level, campaign?.id, since, until, retry].join(":");
  useEffect(() => {
    if (!active || level === "campaigns" || !campaign || !since || !until || refreshing) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    const params = new URLSearchParams({ campaign_id: campaign.id, level, since, until, ...(campaign.advertiserId ? { advertiser_id: campaign.advertiserId } : {}) });
    void campaignFetch<Detail>(`/api/channels/${slug}/analytics/entities?${params}`).then(data => {
      if (!cancelled) setDetail({ key, data });
    }).catch(() => {
      if (!cancelled) setError({ key, message: "These results could not be read. Try again." });
    });
    return () => { cancelled = true; };
  }, [active, level, campaign?.id, since, until, slug, key, refreshing]);
  const result = detail?.key === key ? detail.data : null;
  const currentError = error?.key === key ? error.message : null;
  const rows = level === "campaigns" ? model.rows : result?.rows ?? [];
  const currency = level === "campaigns" ? model.currency : result?.currency ?? null;
  const openTiktok = (target: { campaign_id: string } | "new") => {
    if (target === "new") return openNewTiktokCampaign();
    const advertiser_id = model.rows.find(row => row.id === target.campaign_id)?.advertiserId;
    if (advertiser_id) openTiktokCampaign({ advertiser_id, campaign_id: target.campaign_id });
  };
  const openEditor = (target: { campaign_id: string; create?: "group" | "ad" } | "new") => tiktok ? openTiktok(target) : kind === "meta" ? openMetaCampaignEditor(target) : video ? openGoogleCampaignEditor(target, "youtube_ads") : openGoogleCampaignEditor(target);
  const edit = (id: string) => openEditor({ campaign_id: id });
  const editable = (row: AnalyticsRow) => x ? false : tiktok ? !!row.advertiserId : kind === "meta" || (!!row.channelType && !READ_ONLY_GOOGLE_CAMPAIGN_TYPES.has(row.channelType));
  const nested = (kind === "meta" || kind === "google") && level !== "campaigns";
  const create = () => x ? void window.dispatchEvent(new CustomEvent(TOP_ACTION_OPEN_EVENT, { detail: { slug, key: "create_new_ad" } })) : openEditor(nested && campaign ? { campaign_id: campaign.id, create: level === "groups" ? "group" : "ad" } : "new");
  const createLabel = kind === "meta" && level === "groups" ? "Create ad set" : CREATE[level];
  const needsCampaign = nested && !campaign;
  const wide = tiles && model.metrics.length === 6;
  const budgetHelp = `${model.activeCount == null ? "Current budget unavailable" : `Across ${model.budgetCounted == null ? "" : `${model.budgetCounted} of `}${model.activeCount} active ${model.activeCount === 1 ? "campaign" : "campaigns"}`}${model.budgetPartial ? " · Partial account read" : ""}`;
  const canChangeBudget = canEdit && model.rows.some(editable);
  const toggleBudget = () => setBudgetOpen(!budgetOpen);
  const toggle = useCampaignSwitch({ kind, rows: model.rows, currency: model.currency, onChanged });
  return <div className="min-w-0 space-y-7" data-testid="paid-analytics">
    <p className="text-base text-inkMuted">{custom ? `${spanLabel(model.period ? { since: model.period.from, until: model.period.to } : custom)}` : `In the last ${days} days, complete days only`}</p>
    {tiles ? <section aria-label={`${channelName} metrics`} className={`grid grid-cols-1 gap-4 [@container(min-width:480px)]:grid-cols-2 ${wide ? "[@container(min-width:900px)]:grid-cols-4" : "[@container(min-width:900px)]:grid-cols-3"}`}>
      {model.metrics.map(metric => <CampaignMetricTile key={metric.key} metricKey={metric.key} icon={icons[metric.key as keyof typeof icons]} label={metric.label} value={metricValue(metric, model.currency)} help={metric.help ?? ""} />)}
      <CampaignMetricTile className={wide ? "[@container(min-width:900px)]:col-start-4 [@container(min-width:900px)]:row-span-2 [@container(min-width:900px)]:row-start-1" : ""} metricKey="daily_budget" icon={CalendarDays} label="Daily budget" value={formatCurrency(model.budget, model.currency)} suffix={model.budget == null ? undefined : "a day"} help={budgetHelp} action={canChangeBudget ? <button type="button" className={`${tableEditButton} shrink-0`} onClick={toggleBudget} aria-expanded={budgetOpen}>Change</button> : undefined} />
    </section> : <dl className="grid grid-cols-1 gap-3 [@container(min-width:480px)]:grid-cols-2 [@container(min-width:900px)]:grid-cols-4">
      {model.metrics.map((metric, index) => {
        const Icon = icons[metric.key as keyof typeof icons];
        return <div key={metric.key} data-metric={metric.key} className={`min-w-0 rounded-2xl border border-rule bg-cream p-5 shadow-sm ${index > 2 ? "[@container(min-width:900px)]:row-start-2" : ""}`}>
          <dt className="flex items-center gap-2 text-sm text-inkMuted"><Icon aria-hidden className="h-5 w-5 shrink-0" />{metric.label}</dt>
          <dd className="mt-4 break-words text-3xl font-semibold tracking-tight text-ink">{metricValue(metric, model.currency)}</dd>
          {metric.key === "roas" && metric.value != null && <p className="mt-2 text-sm text-inkMuted">{model.currency ? formatCurrency(metric.value, model.currency, true) : metric.value.toFixed(2)} back per {model.currency ? formatCurrency(1, model.currency) : "1"} spent</p>}
          {metric.key === "pacing" && model.pacing && model.currency === "USD" && <p className="mt-2 text-sm text-inkMuted">{formatCurrency(model.pacing.spend, model.currency)} of {formatCurrency(model.pacing.plan, model.currency)} · day {model.pacing.days_elapsed} of {model.pacing.days_in_month}</p>}
        </div>;
      })}
      <div className="flex min-w-0 flex-col rounded-2xl border border-rule bg-cream p-5 shadow-sm [@container(min-width:900px)]:col-start-4 [@container(min-width:900px)]:row-start-1 [@container(min-width:900px)]:row-span-2">
        <dt className="flex items-center gap-2 text-sm text-inkMuted"><CalendarDays aria-hidden className="h-5 w-5" />Daily budget</dt>
        <dd className="mt-4 text-3xl font-semibold tracking-tight text-ink">{formatCurrency(model.budget, model.currency)}<span className="text-base font-normal"> a day</span></dd>
        <p className="mt-3 text-sm text-inkMuted">{budgetHelp}</p>
        {canChangeBudget && <button type="button" className={`${button} mt-6 self-start [@container(min-width:900px)]:mt-auto`} onClick={toggleBudget} aria-expanded={budgetOpen}>Change</button>}
      </div>
    </dl>}
    {model.pacing && model.currency === "USD" && canEdit && <MonthlyPlan slug={slug} p={model.pacing} onSaved={onChanged} />}
    {budgetOpen && <section aria-label="Choose a campaign budget" className="rounded-2xl border border-rule bg-cream p-4">
      <p className="mb-3 text-sm text-inkMuted">Choose a campaign to review its budget in the editor.</p>
      <ul className="space-y-2">{model.rows.filter(editable).map(row => <li key={row.id} className="flex items-center justify-between gap-3"><span className="text-sm text-ink">{row.name}</span><button type="button" className={button} onClick={() => edit(row.id)}>Review budget</button></li>)}</ul>
    </section>}
    <section className="min-w-0 overflow-hidden rounded-2xl border border-ca-border bg-ca-bg" aria-label="Campaign results">
      <div className="flex flex-wrap items-center gap-3 p-4">
        <LevelTabs tab={level} levels={kind === "meta" ? META_LEVELS : GOOGLE_LEVELS} label="Campaign views" onTab={setLevel} />
        {level !== "campaigns" && model.rows.length > 0 && <label className="flex min-w-0 items-center gap-2 text-ca-action text-ca-secondary">Campaign<select aria-label="Campaign for detailed results" value={campaign?.id ?? ""} onChange={e => setCampaignId(e.target.value)} className="min-w-0 max-w-64 rounded-lg border border-ca-strong bg-ca-bg p-2 text-ca-xdark">{model.rows.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
        {canEdit && <div className="ml-auto flex flex-wrap items-center gap-2">
          {kind === "meta" && <button type="button" className={tableEditButton} onClick={() => setBoostOpen(true)}><Rocket aria-hidden className="size-4" />Boost a post</button>}
          <button type="button" className={tablePrimaryButton} onClick={create} disabled={needsCampaign} title={needsCampaign ? "Create a campaign first" : undefined}><Plus aria-hidden className="size-4" />{createLabel}</button>
        </div>}
      </div>
      {canEdit && !nested && level !== "campaigns" && <p role="note" className="px-5 pb-3 text-ca-action text-ca-secondary">On {channelName}, a new {level === "groups" ? "ad group" : "ad"} is created together with a new campaign.</p>}
      {toggle.error && <p role="alert" className="px-5 pb-3 text-ca-action text-ca-danger">{toggle.error}</p>}
      {toggle.notice && <p role="status" className="px-5 pb-3 text-ca-action text-ca-success">{toggle.notice}</p>}
      {level !== "campaigns" && !since && <p role="status" className="px-5 pb-3 text-ca-action text-ca-secondary">Refresh the account report to load its date range.</p>}
      {level !== "campaigns" && campaign && since && !result && !currentError && <p role="status" className="sr-only">Loading campaign details…</p>}
      {currentError && <p role="alert" className="px-5 pb-3 text-ca-action text-ca-secondary">{currentError} <button type="button" className="underline" onClick={() => setRetry(n => n + 1)}>Try again</button></p>}
      {result && !result.complete && <p role="status" className="px-5 pb-3 text-ca-action text-ca-secondary">Partial provider report. More results may exist; these rows are not account totals.</p>}
      <div className="overflow-x-auto" role="tabpanel" aria-label={`${level === "campaigns" ? "Campaign" : level === "ads" ? "Ad" : kind === "meta" ? "Ad set" : "Ad group"} results`}>
        <PaidCampaignTable campaigns={level === "campaigns"} columns={reddit ? REDDIT_COLUMNS : x ? X_COLUMNS : tiktok ? TIKTOK_COLUMNS : video && level === "campaigns" ? VIDEO_COLUMNS : STANDARD_COLUMNS} video={model.video} rows={rows} loading={level !== "campaigns" && !!campaign && !!since && !result && !currentError} currency={currency} canEdit={canEdit} parent={campaign} budget={model.budget} roas={model.metrics.find(m => m.key === "roas")?.value ?? null} pending={toggle.pending} awaiting={toggle.awaiting} stateOf={toggle.stateOf} editable={editable} onFlip={row => void toggle.flip(row)} onEdit={edit} switchNote={x ? `Switch it in ${channelName}, or ask Zavi in chat.` : undefined} />
      </div>
      {rows.length === 0 && (level === "campaigns" || result) && <p className="p-8 text-center text-ca-action text-ca-secondary">{model.readable ? "No results were returned for this selection." : "Account results are unavailable. Try Refresh."}</p>}
    </section>
    {boostOpen && <BoostPostModal channelName={channelName} onClose={() => setBoostOpen(false)} onChanged={onChanged} />}
    <p className="!mt-2 text-ca-action text-ca-secondary">Numbers as reported by {kind === "meta" ? "Meta Ads" : tiktok ? "TikTok Ads" : reddit ? "Reddit Ads" : x ? "X Ads" : "Google Ads"}.{model.currency ? ` Amounts in ${model.currency}.` : " Account currency has not been confirmed."}</p>
  </div>;
}
