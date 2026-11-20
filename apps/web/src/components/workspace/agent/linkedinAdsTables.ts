import { adThumbnail, campaignThumbnail } from "../actions/campaigns/campaignMedia";
import { BarChart3 } from "lucide-react";
import type { ChannelMetric } from "@/lib/workspace/channelActionsApi";
import type { ExtraCell, ExtraRow, ExtraRowAction, ExtraTableData } from "../actions/ExtraTable";
import { apiFetch } from "@/lib/api";
import type { ChannelChrome } from "./legacyChannelActions";
import { count, DEFAULT_RANGES, type GadsRange } from "./google-ads/types";
import { formatCurrency } from "../metrics/currency";

type LinkedinAdsTotals = {
  spend: number | null;
  impressions: number;
  clicks: number;
  conversions: number;
  leads?: number;
  conversion_value?: number | null;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
};

type LinkedinAdsCampaign = {
  id: string;
  ad_account_id?: string;
  currency: string | null;
  name: string;
  status: string;
  campaign_group?: { id: string; name: string } | null;
  daily_budget?: number | null;
  ad_delivery?: "serving" | "rejected" | "in_review" | "out_of_budget" | "held" | "no_ads" | "unread" | null;
  ads_not_running?: number;
  spend: number;
  impressions?: number;
  clicks: number;
  conversions: number;
  leads?: number | null;
  conversion_value?: number | null;
  cpa: number | null;
  url: string | null;
};

type LinkedinOtherCampaigns = {
  kind: "ended" | "removed";
  name: string;
  currency: string | null;
  spend: number;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  leads?: number | null;
  conversion_value?: number | null;
  cpa: number | null;
};

type LinkedinAdsGroup = {
  id: string;
  ad_account_id: string;
  name: string;
  status: string | null;
  total_budget: { amount: number; currency: string } | null;
  run_end_at: string | null;
  is_default: boolean;
  campaign_count: number;
};

type LinkedinAdsAd = {
  id: string;
  campaign_id: string;
  ad_account_id: string;
  name: string;
  intended_status: string | null;
  is_serving: boolean | null;
  review_status: string | null;
  hold_reasons: string[];
};

type LinkedinAdsPayload = {
  platform: "linkedin_ads";
  connected: boolean;
  own_connected?: boolean;
  error_code: string | null;
  wallet_error_code?: string | null;
  wallet_offered?: boolean;
  held_elsewhere?: string[];
  own_error_code?: string | null;
  account_errors?: { id: string; name: string; reason: string }[];
  retry_at?: string | null;
  left_out_spend?: { now: number; before: number } | null;
  window_days: number;
  ranges?: GadsRange[];
  period?: { from: string; to: string };
  prev_period?: { from: string; to: string };
  account: { id?: string | null; name: string | null; account_count: number; campaign_count: number; active_count: number; currency: string | null } | null;
  totals?: LinkedinAdsTotals | null;
  prev_totals?: LinkedinAdsTotals | null;
  campaigns?: LinkedinAdsCampaign[];
  other_campaigns?: LinkedinOtherCampaigns[];
  groups?: LinkedinAdsGroup[];
  ads?: LinkedinAdsAd[];
};

export function isLinkedinAdsPayload(payload: unknown): payload is LinkedinAdsPayload {
  return !!payload && typeof payload === "object" && (payload as { platform?: unknown }).platform === "linkedin_ads";
}

export const LINKEDIN_DAILY_LIMIT_TEXT = "LinkedIn's daily allowance of requests for this LinkedIn connection is used up, so these numbers could not be read. It resets at 00:00 UTC (5:30 AM IST). Try Refresh after that.";
export const LINKEDIN_WALLET_READ_FAILED_TEXT = "Zavi could not read the LinkedIn campaigns your shared ads balance pays for just now, so their spend, results and rows are missing here. Try Refresh in a minute.";
export const LINKEDIN_ADS_BILLING_HOLD = "LinkedIn has paused this ad account for billing, so campaigns on it cannot run. Add or fix the payment method in LinkedIn Campaign Manager, then come back and refresh.";
export const MANAGED_ACCOUNT_BILLING_HOLD = "LinkedIn has paused Zavi's managed ad account for billing, so it cannot run ads right now. Zavi is sorting it out and there is nothing you need to fix. Use your own LinkedIn ad account meanwhile.";
export const LINKEDIN_WALLET_DAILY_LIMIT_TEXT = "Zavi's shared LinkedIn login has used up LinkedIn's daily allowance, so the campaigns your shared ads balance pays for are missing here. It resets at 00:00 UTC. Try Refresh after that.";
const walletMissing = (p: LinkedinAdsPayload) => !!p.wallet_error_code || !!p.error_code?.startsWith("linkedin_ads_wallet_");

function retryTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : null;
}

function walletText(p: LinkedinAdsPayload): string {
  const code = p.wallet_error_code ?? p.error_code;
  if (code === "linkedin_ads_wallet_daily_limit") return LINKEDIN_WALLET_DAILY_LIMIT_TEXT;
  if (code === "linkedin_ads_wallet_rate_limited") {
    const at = retryTime(p.retry_at);
    return `LinkedIn asked Zavi to slow down, so the campaigns your shared ads balance pays for are missing here. ${at ? `Zavi will read them again at ${at}. Try Refresh after that.` : "Wait a minute, then try Refresh."}`;
  }
  return LINKEDIN_WALLET_READ_FAILED_TEXT;
}

const zeroed = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const RATIO_KEYS = new Set(["cpl", "cpc"]);
const spendText = (v: number | null, currency: string | null | undefined) => formatCurrency(v, currency, typeof v === "number" && Math.abs(v) < 1000 && !Number.isInteger(v));

export function linkedinAdsKpis(payload: unknown): ChannelMetric[] {
  if (!isLinkedinAdsPayload(payload) || !payload.connected || payload.error_code || walletMissing(payload) || !payload.totals) return [];
  const t = payload.totals;
  const currency = payload.account?.currency;
  const moneyUnit = currency === "USD" ? "usd" : `currency:${currency}`;
  const p = payload.prev_totals ?? null;
  const day = payload.period?.to ?? "";
  const prevDay = payload.prev_period?.to ?? null;
  const leads = zeroed(t.leads);
  const previousLeads = p ? zeroed(p.leads) : null;
  const running = (payload.campaigns ?? []).filter((campaign) => campaign.status.toUpperCase() === "ACTIVE");
  const dailyBudget = running.reduce((sum, campaign) => sum + zeroed(campaign.daily_budget), 0);
  const notes: Record<string, string> = {
    ...(t.ctr != null ? { clicks: `${t.ctr.toFixed(2)}% click-through rate` } : {}),
    budget: `A day, across ${running.length} active ${running.length === 1 ? "campaign" : "campaigns"}`,
  };
  const rows: Array<[string, string, number | null, number | null]> = [
    ["spend", moneyUnit, t.spend, p?.spend ?? null],
    ["leads", "count", leads, previousLeads],
    ["cpl", moneyUnit, leads > 0 && t.spend != null ? t.spend / leads : null, previousLeads && p?.spend != null ? p.spend / previousLeads : null],
    ["clicks", "count", t.clicks, p?.clicks ?? null],
    ["cpc", moneyUnit, t.cpc, p?.cpc ?? null],
    ["budget", moneyUnit, dailyBudget, null],
  ];
  return rows.map(([key, unit, value, prevRaw]) => {
    const unavailable = !currency && unit === moneyUnit;
    const noRatio = !unavailable && value == null && RATIO_KEYS.has(key);
    return {
      key,
      value: unavailable || noRatio ? Number.NaN : zeroed(value),
      unit,
      window_kind: `${payload.window_days}d`,
      day,
      grounded: !unavailable && !noRatio,
      prev_value: !unavailable && !noRatio && prevRaw != null ? zeroed(prevRaw) : null,
      prev_day: prevRaw != null ? prevDay : null,
      ...(notes[key] && !unavailable ? { note: notes[key] } : {}),
      ...(unavailable ? { unmeasured: "Totals need a single currency" } : noRatio ? { unmeasured: true as const } : {}),
    };
  });
}

const STOPPED_BY_ADS: Record<"rejected" | "in_review" | "out_of_budget" | "held" | "no_ads", ExtraCell> = {
  rejected: { text: "Ads rejected", chip: "bad", title: "LinkedIn rejected this campaign's ads, so it is not delivering. Check them in LinkedIn Campaign Manager." },
  in_review: { text: "Ads in review", chip: "warn", title: "LinkedIn is still reviewing this campaign's ads, so it is not delivering yet." },
  out_of_budget: { text: "Out of budget", chip: "warn", title: "This campaign has reached a budget LinkedIn enforces, so its ads are not delivering. Check its total budget in LinkedIn Campaign Manager." },
  held: { text: "Ads on hold", chip: "warn", title: "LinkedIn is holding this campaign's ads, so it is not delivering. Check them in LinkedIn Campaign Manager." },
  no_ads: { text: "No ad running", chip: "warn", title: "This campaign is on, but none of its ads is switched on, so it is not delivering." },
};

function statusCell(c: Pick<LinkedinAdsCampaign, "status" | "ad_delivery" | "ads_not_running">): ExtraCell {
  const { status, ad_delivery: delivery } = c;
  const pill = status ? linkedinCampaignPill(c) : null;
  if (!pill) return { text: status ? (status.charAt(0) + status.slice(1).toLowerCase()).replace(/_/g, " ") : "Unknown", chip: "muted" };
  if (status.toUpperCase() !== "ACTIVE") return { text: pill.label, chip: "muted" };
  if (delivery && delivery !== "serving" && delivery !== "unread") return STOPPED_BY_ADS[delivery];
  if (delivery !== "serving") return { text: pill.label, chip: "muted", ...(pill.title ? { title: pill.title } : {}) };
  return { text: pill.label, chip: (c.ads_not_running ?? 0) > 0 ? "warn" : "good" };
}

const WALLET_STILL_SHOWS = "Campaigns Zavi runs from your shared wallet still show.";
export const LINKEDIN_OWN_CONNECTION_LOST_TEXT = `Your own LinkedIn connection stopped working, so your own ad accounts are missing here. ${WALLET_STILL_SHOWS} Reconnect to bring your accounts back.`;

function ownProblem(code: string, retryAt: string | null | undefined): { text: string; reconnect: boolean } {
  if (code === "linkedin_ads_token_revoked") return { text: LINKEDIN_OWN_CONNECTION_LOST_TEXT, reconnect: true };
  if (code === "linkedin_ads_forbidden")
    return { text: `LinkedIn did not let Zavi read your own ad accounts, so they are missing here. ${WALLET_STILL_SHOWS} Ask an account admin in LinkedIn Campaign Manager to give your LinkedIn user a role, or reconnect with a LinkedIn user who already has one.`, reconnect: true };
  if (code === "linkedin_ads_daily_limit")
    return { text: `LinkedIn's daily allowance of requests for your own LinkedIn connection is used up, so your own ad accounts are missing here. ${WALLET_STILL_SHOWS} It resets at 00:00 UTC (5:30 AM IST). Try Refresh after that.`, reconnect: false };
  if (code === "linkedin_ads_account_not_active")
    return { text: "Your chosen LinkedIn ad account is not active in LinkedIn yet. Add a payment method to it in LinkedIn Campaign Manager, then try Refresh.", reconnect: false };
  if (code === "linkedin_ads_account_closed")
    return { text: "Your chosen LinkedIn ad account is closed in LinkedIn. Choose another one in Settings, under Ad account and shared wallet.", reconnect: false };
  if (code === "linkedin_ads_rate_limited") {
    const at = retryTime(retryAt);
    return { text: `LinkedIn is limiting requests, so your own ad accounts are missing here. ${WALLET_STILL_SHOWS} ${at ? `Zavi will read them again at ${at}. Try Refresh after that.` : "Wait a minute, then try Refresh."}`, reconnect: false };
  }
  return { text: `Zavi could not read your own LinkedIn ad accounts just now, so they are missing here. ${WALLET_STILL_SHOWS} Try Refresh in a minute.`, reconnect: false };
}

function accountErrorsText(errors: LinkedinAdsPayload["account_errors"]): string | null {
  const list = (errors ?? []).filter((e) => e && typeof e.reason === "string" && e.reason.trim());
  if (!list.length) return null;
  const lead = list.length === 1 ? "Zavi could not read one of your LinkedIn ad accounts, so the totals here leave it out." : `Zavi could not read ${list.length} of your LinkedIn ad accounts, so the totals here leave them out.`;
  return [lead, ...list.map((e) => `${e.name || e.id}: ${e.reason.trim()}`)].join(" ");
}

export type LinkedinCampaignState = Pick<LinkedinAdsCampaign, "status" | "ad_delivery" | "ads_not_running">;

export function linkedinCampaignStates(payload: unknown): Record<string, LinkedinCampaignState> {
  if (!isLinkedinAdsPayload(payload) || !payload.connected || payload.error_code) return {};
  return Object.fromEntries((payload.campaigns ?? []).map((c) => [c.id, { status: c.status, ad_delivery: c.ad_delivery ?? null, ads_not_running: c.ads_not_running ?? 0 }]));
}

export function linkedinCampaignPill(state: LinkedinCampaignState): { label: string; title?: string } | null {
  const status = state.status.toUpperCase();
  if (status === "PAUSED" || status === "DRAFT") return { label: "Paused" };
  if (["COMPLETED", "ARCHIVED", "CANCELED", "CANCELLED", "REMOVED"].includes(status)) return { label: "Ended" };
  if (status !== "ACTIVE") return null;
  const delivery = state.ad_delivery;
  if (delivery && delivery !== "serving" && delivery !== "unread") {
    const stopped = STOPPED_BY_ADS[delivery];
    return { label: stopped.text, title: stopped.title };
  }
  if (delivery !== "serving") return { label: "Active", title: "Zavi could not read this campaign's ads just now, so it cannot say they are delivering." };
  const notRunning = state.ads_not_running ?? 0;
  if (notRunning > 0) return { label: `Live, ${notRunning} ${notRunning === 1 ? "ad" : "ads"} not running` };
  return { label: "Live" };
}

const blockedByAds = (c: LinkedinAdsCampaign) => !!c.ad_delivery && c.ad_delivery in STOPPED_BY_ADS;

export type LinkedinPauseCtx = {
  canPause: boolean;
  onFiled?: () => void;
  propose?: (campaignId: string, accountId: string) => Promise<unknown>;
  proposeResume?: (campaignId: string, accountId: string) => Promise<unknown>;
  proposeCard?: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  approve?: (actionId: string) => Promise<unknown>;
};

export const PAUSE_DONE_NOTE = "Pausing this campaign in LinkedIn now.";
export const RESUME_DONE_NOTE = "Restarting this campaign in LinkedIn now.";
export const ARCHIVE_FILED_NOTE = "Zavi filed an archive for this campaign. It is waiting for you in Next steps.";
export const COPY_DONE_NOTE = "Copying this campaign in LinkedIn as a paused campaign now.";
export const GROUP_PAUSE_DONE_NOTE = "Pausing this campaign group in LinkedIn now.";
export const GROUP_RESUME_DONE_NOTE = "Restarting this campaign group in LinkedIn now.";
export const GROUP_COPY_DONE_NOTE = "Copying this campaign group in LinkedIn as a paused group now.";
export const AD_OFF_DONE_NOTE = "Turning this ad off in LinkedIn now.";
export const AD_ON_DONE_NOTE = "Turning this ad on in LinkedIn now.";

type ChangeKind = "pause" | "resume" | "archive" | "copy" | "group_pause" | "group_resume" | "group_copy" | "ad_off" | "ad_on";
const FAIL_WORD: Record<ChangeKind, string> = { pause: "the pause", resume: "the restart", archive: "the archive", copy: "the copy", group_pause: "the pause", group_resume: "the restart", group_copy: "the copy", ad_off: "the change", ad_on: "the change" };
const WAITING = "It is waiting in Next steps.";

async function postChange(path: string, body: Record<string, unknown>, failWord: string): Promise<unknown> {
  let res: Response;
  try {
    res = await apiFetch(`/api/channels/linkedin_ads/${path}`, { method: "POST", body: JSON.stringify(body) });
  } catch {
    throw new Error("Couldn't reach Zavi. Check your connection.");
  }
  if (res.ok) return res.json().catch(() => null);
  const json = (await res.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null;
  const message = json?.error?.code === "not_found" ? null : json?.error?.message;
  throw new Error(typeof message === "string" && message.trim() ? message : `Zavi couldn't make ${failWord}. Try again in a moment.`);
}

async function approveFiled(actionId: string): Promise<void> {
  let res: Response;
  try {
    res = await apiFetch(`/api/channel-actions/${encodeURIComponent(actionId)}/approve`, { method: "POST", body: JSON.stringify({ request_id: `row:${actionId}` }) });
  } catch {
    throw new Error(`Couldn't reach Zavi. ${WAITING}`);
  }
  if (res.ok) return;
  const json = (await res.json().catch(() => null)) as { error?: { message?: unknown } | string } | null;
  const err = json?.error;
  const message = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : "";
  throw new Error(`${message.trim() || "Zavi couldn't make the change."} ${WAITING}`);
}

async function actNow(ctx: LinkedinPauseCtx, file: () => Promise<unknown>): Promise<void> {
  const filed = (await file()) as { action_id?: unknown } | null | undefined;
  const id = filed && typeof filed.action_id === "string" ? filed.action_id : null;
  if (!id) throw new Error(`Zavi couldn't start the change. ${WAITING}`);
  try {
    if (ctx.approve) await ctx.approve(id).catch((e: unknown) => {
      throw new Error(`${e instanceof Error && e.message ? e.message : "Zavi couldn't make the change."} ${WAITING}`);
    });
    else await approveFiled(id);
  } catch (e) {
    ctx.onFiled?.();
    throw e;
  }
}

const proposeChange = (kind: "pause" | "resume", campaignId: string, accountId: string) =>
  postChange(`campaigns/${encodeURIComponent(campaignId)}/propose-${kind}`, { account_id: accountId }, FAIL_WORD[kind]);
const proposePause = (campaignId: string, accountId: string) => proposeChange("pause", campaignId, accountId);
const proposeResume = (campaignId: string, accountId: string) => proposeChange("resume", campaignId, accountId);

const inFlight: Record<ChangeKind, Map<string, Promise<string>>> = {
  pause: new Map(),
  resume: new Map(),
  archive: new Map(),
  copy: new Map(),
  group_pause: new Map(),
  group_resume: new Map(),
  group_copy: new Map(),
  ad_off: new Map(),
  ad_on: new Map(),
};

type Wording = { label: string; busy: string; title: string; note: string };

function rowAct(kind: ChangeKind, key: string, words: Wording, run: () => Promise<unknown>, ctx: LinkedinPauseCtx): ExtraRowAction {
  return {
    label: words.label,
    busyLabel: words.busy,
    retryLabel: "Try again",
    toast: true,
    title: words.title,
    onClick: () => {
      const map = inFlight[kind];
      const current = map.get(key);
      if (current) return current;
      const promise = (async () => {
        try {
          await run();
        } finally {
          map.delete(key);
        }
        ctx.onFiled?.();
        return words.note;
      })();
      map.set(key, promise);
      return promise;
    },
  };
}

const direct = (ctx: LinkedinPauseCtx, file: () => Promise<unknown>) => () => actNow(ctx, file);
const cardCall = (ctx: LinkedinPauseCtx, kind: ChangeKind, path: string, body: Record<string, unknown>) => () => (ctx.proposeCard ? ctx.proposeCard(path, body) : postChange(path, body, FAIL_WORD[kind]));
const cardNow = (ctx: LinkedinPauseCtx, kind: ChangeKind, path: string, body: Record<string, unknown>) => direct(ctx, cardCall(ctx, kind, path, body));

function pauseAction(c: LinkedinAdsCampaign, accountId: string, ctx: LinkedinPauseCtx): ExtraRowAction {
  return rowAct(
    "pause",
    c.id,
    { label: "Pause", busy: "Pausing…", title: `Pause "${c.name}" in LinkedIn now.`, note: PAUSE_DONE_NOTE },
    direct(ctx, () => (ctx.propose ?? proposePause)(c.id, accountId)),
    ctx,
  );
}

function resumeAction(c: LinkedinAdsCampaign, accountId: string, ctx: LinkedinPauseCtx): ExtraRowAction {
  const ended = c.status === "COMPLETED";
  return rowAct(
    "resume",
    c.id,
    { label: "Restart", busy: "Restarting…", title: `Restart "${c.name}" in LinkedIn now${ended ? " for another 30 days" : ""}. It starts spending again.`, note: RESUME_DONE_NOTE },
    direct(ctx, () => (ctx.proposeResume ?? proposeResume)(c.id, accountId)),
    ctx,
  );
}

function archiveAction(c: LinkedinAdsCampaign, accountId: string, ctx: LinkedinPauseCtx): ExtraRowAction {
  const path = `campaigns/${encodeURIComponent(c.id)}/propose-archive`;
  return rowAct(
    "archive",
    c.id,
    {
      label: "Ask Zavi to archive",
      busy: "Asking Zavi…",
      title: `Ask Zavi to archive "${c.name}". It leaves LinkedIn's active lists and cannot spend; nothing changes until you approve it in Next steps.`,
      note: ARCHIVE_FILED_NOTE,
    },
    cardCall(ctx, "archive", path, { account_id: accountId, mode: "archive" }),
    ctx,
  );
}

function copyAction(c: LinkedinAdsCampaign, accountId: string, ctx: LinkedinPauseCtx): ExtraRowAction {
  const path = `campaigns/${encodeURIComponent(c.id)}/propose-duplicate`;
  return rowAct(
    "copy",
    c.id,
    { label: "Copy", busy: "Copying…", title: `Copy "${c.name}" in LinkedIn as a paused campaign with paused copies of its ads.`, note: COPY_DONE_NOTE },
    cardNow(ctx, "copy", path, { account_id: accountId }),
    ctx,
  );
}

const RESTARTABLE = new Set(["PAUSED", "COMPLETED"]);
const ARCHIVABLE = new Set(["PAUSED", "COMPLETED", "DRAFT"]);
const COPYABLE = new Set(["ACTIVE", "PAUSED", "COMPLETED", "DRAFT"]);

function rowAction(c: LinkedinAdsCampaign, ctx: LinkedinPauseCtx | undefined): { actions: ExtraRowAction[] } | Record<string, never> {
  if (!ctx?.canPause || !c.ad_account_id) return {};
  const account = c.ad_account_id;
  const actions: ExtraRowAction[] = [];
  if (c.status === "ACTIVE") actions.push(pauseAction(c, account, ctx));
  if (RESTARTABLE.has(c.status)) actions.push(resumeAction(c, account, ctx));
  if (ARCHIVABLE.has(c.status)) actions.push(archiveAction(c, account, ctx));
  if (COPYABLE.has(c.status)) actions.push(copyAction(c, account, ctx));
  return actions.length ? { actions } : {};
}

type Shown = { spend: number; impressions: number | null; clicks: number | null; conversions: number | null; leads: number | null; conversion_value: number | null };
const OTHER_GROUP = "Other";
const UNKNOWN = "–";
const addKnown = (a: number | null, b: number | null | undefined) => (a === null || b === null || b === undefined ? null : a + b);
const sumShown = (rows: Shown[]) =>
  rows.reduce<Shown>((t, r) => ({ spend: t.spend + r.spend, impressions: addKnown(t.impressions, r.impressions), clicks: addKnown(t.clicks, r.clicks), conversions: addKnown(t.conversions, r.conversions), leads: addKnown(t.leads, r.leads), conversion_value: addKnown(t.conversion_value, r.conversion_value) }), {
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    leads: 0,
    conversion_value: 0,
  });
const countCell = (v: number | null | undefined): ExtraCell => ({ text: v == null ? UNKNOWN : count(v) });
const cpaOf = (s: Shown) => (s.conversions !== null && s.conversions > 0 ? s.spend / s.conversions : null);
const reachCells = (s: Shown, currency: string | null | undefined): ExtraCell[] => [
  countCell(s.impressions),
  { text: s.clicks !== null && s.impressions ? `${((s.clicks / s.impressions) * 100).toFixed(2)}%` : UNKNOWN },
  { text: formatCurrency(currency && s.leads !== null && s.leads > 0 ? s.spend / s.leads : null, currency, true) },
];
const REACH_COLUMNS = [{ label: "Impressions" }, { label: "Click-through rate" }, { label: "Cost per lead" }];
const shownOf = (c: LinkedinAdsCampaign | LinkedinOtherCampaigns): Shown => ({ spend: c.spend, impressions: c.impressions ?? null, clicks: c.clicks ?? null, conversions: c.conversions ?? null, leads: c.leads ?? null, conversion_value: c.conversion_value ?? null });

type GroupBucket = { id: string; name: string; campaigns: LinkedinAdsCampaign[] };

export function linkedinCampaignGroupBuckets(campaigns: LinkedinAdsCampaign[]): GroupBucket[] {
  const buckets = new Map<string, GroupBucket>();
  for (const c of campaigns) {
    const key = c.campaign_group ? `group:${c.campaign_group.id}` : "other";
    const b = buckets.get(key) ?? { id: key, name: c.campaign_group?.name ?? OTHER_GROUP, campaigns: [] };
    b.campaigns.push(c);
    buckets.set(key, b);
  }
  const list = [...buckets.values()];
  if (list.length === 1 && list[0].id === "other") return [];
  return list.sort((a, b) => Number(a.id === "other") - Number(b.id === "other") || sumShown(b.campaigns.map(shownOf)).spend - sumShown(a.campaigns.map(shownOf)).spend);
}

const DASH = "—";

function dailyBudgetText(amount: number | null | undefined, currency: string | null | undefined): string {
  return amount != null && amount > 0 && currency ? `${spendText(amount, currency)} / day` : DASH;
}

function runningBudget(campaigns: LinkedinAdsCampaign[], currency: string | null | undefined): string {
  const live = campaigns.filter((c) => c.status === "ACTIVE" && c.daily_budget != null && c.daily_budget > 0);
  if (!live.length || !currency || live.some((c) => c.currency !== currency)) return DASH;
  return dailyBudgetText(live.reduce((t, c) => t + (c.daily_budget ?? 0), 0), currency);
}

function groupRow(b: GroupBucket, currency: string | null | undefined, campaignIds: string): ExtraRow {
  const s = sumShown(b.campaigns.map(shownOf));
  const n = b.campaigns.length;
  const title = b.id === "other" ? "Ad sets whose LinkedIn campaign group is archived, canceled or could not be read." : `LinkedIn campaign group ${b.name}: its ad sets, added up.`;
  return {
    id: b.id,
    cells: [
      { text: b.name, strong: true, title, ...(b.campaigns[0] ? { media: campaignThumbnail("linkedin_ads", b.campaigns[0], b.campaigns[0].id, b.name, campaignIds) } : {}) },
      { text: `${n} ${n === 1 ? "ad set" : "ad sets"}`, chip: "muted" },
      { text: runningBudget(b.campaigns, currency), title: "Daily budgets of the ad sets that are on, added up." },
      { text: spendText(s.spend, currency), strong: true },
      countCell(s.clicks),
      countCell(s.conversions),
      countCell(s.leads),
      { text: formatCurrency(cpaOf(s), currency, true) },
      { text: s.conversion_value === null ? UNKNOWN : spendText(s.conversion_value, currency) },
      ...reachCells(s, currency),
    ],
  };
}

export function linkedinAdsCampaignTable(payload: unknown, ctx?: LinkedinPauseCtx): ExtraTableData[] {
  if (!isLinkedinAdsPayload(payload) || !payload.connected || payload.error_code || !payload.totals) return [];
  const rows = payload.campaigns ?? [];
  const others = payload.other_campaigns ?? [];
  const currency = payload.account?.currency;
  const shown = sumShown([...rows, ...others].map(shownOf));
  const active = payload.account?.active_count ?? rows.filter((c) => c.status === "ACTIVE" && !blockedByAds(c)).length;
  const leftOut = payload.left_out_spend;
  const notes = [
    walletMissing(payload) ? walletText(payload) : currency ? null : "Campaign amounts use each ad account's currency. Monetary totals require a single known currency.",
    leftOut && leftOut.now > 0 ? `${spendText(leftOut.now, "USD")} of spend from campaigns no longer in LinkedIn is left out of this range: LinkedIn only gave Zavi a monthly total for them, so Zavi cannot split it by day.` : null,
    leftOut && leftOut.before > 0 ? `${spendText(leftOut.before, "USD")} of spend from campaigns no longer in LinkedIn is left out of the comparison range for the same reason.` : null,
  ].filter((n): n is string => !!n);
  const otherRows: ExtraRow[] = others.map((o) => ({
    id: `other:${o.kind}:${o.currency ?? ""}`,
    cells: [
      { text: o.name },
      o.kind === "ended"
        ? { text: "Ended", chip: "muted", title: "Archived, canceled and older campaigns that spent in this range, added up." }
        : { text: "Removed", chip: "muted", title: "Campaigns LinkedIn no longer lists. Zavi kept the spend it recorded for them." },
      { text: DASH },
      { text: spendText(o.spend, o.currency), strong: true },
      countCell(o.clicks),
      countCell(o.conversions),
      countCell(o.leads),
      { text: o.cpa == null ? UNKNOWN : formatCurrency(o.cpa, o.currency, true) },
      { text: o.conversion_value == null ? UNKNOWN : spendText(o.conversion_value, o.currency) },
      ...reachCells(shownOf(o), o.currency),
    ],
  }));
  const campaignIds = rows.map((campaign) => campaign.id).join(",");
  const adSetRow = (c: LinkedinAdsCampaign): ExtraRow => ({
    id: c.id,
    ...rowAction(c, ctx),
    cells: [
      { text: c.name, href: c.url, sub: c.campaign_group?.name ?? undefined, media: campaignThumbnail("linkedin_ads", c, c.id, c.name, campaignIds) },
      statusCell(c),
      { text: dailyBudgetText(c.daily_budget, c.currency) },
      { text: spendText(c.spend, c.currency), strong: true },
      countCell(c.clicks),
      countCell(c.conversions),
      countCell(c.leads),
      { text: formatCurrency(c.cpa, c.currency, true) },
      { text: c.conversion_value == null ? UNKNOWN : spendText(c.conversion_value, c.currency) },
      ...reachCells(shownOf(c), c.currency),
    ],
  });
  const buckets = linkedinCampaignGroupBuckets(rows);
  const adSetRows = rows.map(adSetRow);
  const footerCount = (v: number | null): ExtraCell => ({ text: v === null ? UNKNOWN : count(v) });
  const totals: ExtraCell[] = [
    { text: runningBudget(rows, currency) },
    { text: spendText(shown.spend, currency) },
    footerCount(shown.clicks),
    footerCount(shown.conversions),
    footerCount(shown.leads),
    { text: formatCurrency(currency ? cpaOf(shown) : null, currency, true) },
    { text: shown.conversion_value === null ? UNKNOWN : spendText(shown.conversion_value, currency) },
    ...reachCells(shown, currency),
  ];
  const groupRows = buckets.map((b) => groupRow(b, currency, campaignIds));
  return [
    {
      title: buckets.length ? "Campaigns and ad sets" : "Campaigns",
      icon: BarChart3,
      ...(buckets.length
        ? {
            views: [
              {
                id: "campaigns",
                label: "Campaigns",
                data: {
                  columns: [
                    { label: "Campaign", align: "left" as const },
                    { label: "Ad sets", align: "left" as const },
                    { label: "Daily budget" },
                    { label: "Spend" },
                    { label: "Clicks" },
                    { label: "Conv." },
                    { label: "Leads" },
                    { label: "CPA" },
                    { label: "Conv. value" },
                    ...REACH_COLUMNS,
                  ],
                  rows: [...groupRows, ...otherRows],
                  footer: [{ text: `${buckets.filter((b) => b.id !== "other").length} ${buckets.filter((b) => b.id !== "other").length === 1 ? "campaign" : "campaigns"}` }, { text: `${rows.length} ${rows.length === 1 ? "ad set" : "ad sets"}` }, ...totals],
                  empty: "No LinkedIn campaign in this account yet.",
                  pageSize: 10,
                },
              },
              { id: "ad_sets", label: "Ad sets" },
            ],
          }
        : {}),
      columns: [
        { label: "Ad set", align: "left" },
        { label: "Status", align: "left" },
        { label: "Daily budget" },
        { label: "Spend" },
        { label: "Clicks" },
        { label: "Conv." },
        { label: "Leads" },
        { label: "CPA" },
        { label: "Conv. value" },
        ...REACH_COLUMNS,
      ],
      rows: [...adSetRows, ...otherRows],
      footer: [{ text: `${active} active of ${rows.length}` }, { text: "" }, ...totals],
      empty: "No LinkedIn campaign in this account yet.",
      pageSize: 10,
      caption: notes.length ? notes.join(" ") : undefined,
    },
  ];
}

function groupStatusCell(g: LinkedinAdsGroup): ExtraCell {
  const status = (g.status ?? "").toUpperCase();
  const title = g.is_default ? "LinkedIn's default campaign group. LinkedIn does not let anyone pause, edit or copy it." : undefined;
  if (status === "ACTIVE") return { text: "Active", chip: "good", ...(title ? { title } : {}) };
  if (status === "PAUSED") return { text: "Paused", chip: "muted", ...(title ? { title } : {}) };
  if (!status) return { text: "Unknown", chip: "muted" };
  return { text: status.charAt(0) + status.slice(1).toLowerCase(), chip: "muted", ...(title ? { title } : {}) };
}

const dayText = (iso: string | null): string => {
  if (!iso) return "No end date";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : UNKNOWN;
};

function groupActions(g: LinkedinAdsGroup, ctx: LinkedinPauseCtx | undefined): { actions: ExtraRowAction[] } | Record<string, never> {
  if (!ctx?.canPause || g.is_default) return {};
  const actions: ExtraRowAction[] = [];
  const statusPath = `groups/${encodeURIComponent(g.id)}/propose-status`;
  if (g.status === "ACTIVE")
    actions.push(
      rowAct(
        "group_pause",
        g.id,
        { label: "Pause", busy: "Pausing…", title: `Pause the campaign group "${g.name}" in LinkedIn now, so every campaign in it stops spending.`, note: GROUP_PAUSE_DONE_NOTE },
        cardNow(ctx, "group_pause", statusPath, { account_id: g.ad_account_id, status: "PAUSED" }),
        ctx,
      ),
    );
  if (g.status === "PAUSED")
    actions.push(
      rowAct(
        "group_resume",
        g.id,
        { label: "Restart", busy: "Restarting…", title: `Restart the campaign group "${g.name}" in LinkedIn now. Its active campaigns start spending again.`, note: GROUP_RESUME_DONE_NOTE },
        cardNow(ctx, "group_resume", statusPath, { account_id: g.ad_account_id, status: "ACTIVE" }),
        ctx,
      ),
    );
  actions.push(
    rowAct(
      "group_copy",
      g.id,
      { label: "Copy", busy: "Copying…", title: `Copy the campaign group "${g.name}" in LinkedIn with paused copies of its campaigns and their ads.`, note: GROUP_COPY_DONE_NOTE },
      cardNow(ctx, "group_copy", `groups/${encodeURIComponent(g.id)}/propose-duplicate`, { account_id: g.ad_account_id }),
      ctx,
    ),
  );
  return { actions };
}

export function linkedinAdsGroupTable(payload: unknown, ctx?: LinkedinPauseCtx): ExtraTableData[] {
  if (!isLinkedinAdsPayload(payload) || !payload.connected || payload.error_code || !payload.totals || !Array.isArray(payload.groups)) return [];
  const campaigns = payload.campaigns ?? [];
  const spendOf = (g: LinkedinAdsGroup) => campaigns.filter((c) => c.campaign_group?.id === g.id).reduce((t, c) => t + c.spend, 0);
  const currencyOf = (g: LinkedinAdsGroup) => campaigns.find((c) => c.campaign_group?.id === g.id)?.currency ?? g.total_budget?.currency ?? payload.account?.currency ?? null;
  const hasBudget = payload.groups.some((g) => g.total_budget);
  const hasEnd = payload.groups.some((g) => g.run_end_at);
  const campaignIds = campaigns.map((c) => c.id).join(",");
  const firstAdSet = (g: LinkedinAdsGroup) => campaigns.find((c) => c.campaign_group?.id === g.id);
  const groupMedia = (g: LinkedinAdsGroup) => {
    const c = firstAdSet(g);
    return c ? { media: campaignThumbnail("linkedin_ads", c, c.id, g.name, campaignIds) } : {};
  };
  const rows: ExtraRow[] = [...payload.groups]
    .sort((a, b) => Number(b.status === "ACTIVE") - Number(a.status === "ACTIVE") || spendOf(b) - spendOf(a))
    .map((g) => ({
      id: g.id,
      ...groupActions(g, ctx),
      cells: [
        { text: g.name, strong: true, ...(g.is_default ? { sub: "Default group" } : {}), ...groupMedia(g) },
        groupStatusCell(g),
        { text: g.campaign_count > 0 ? String(g.campaign_count) : "—" },
        ...(hasBudget ? [{ text: g.total_budget ? spendText(g.total_budget.amount, g.total_budget.currency) : "No cap" }] : []),
        ...(hasEnd ? [{ text: g.run_end_at ? dayText(g.run_end_at) : "—" }] : []),
        { text: spendText(spendOf(g), currencyOf(g)), strong: true },
      ],
    }));
  return [
    {
      title: "Campaign groups",
      icon: BarChart3,
      columns: [
        { label: "Group", align: "left" },
        { label: "Status", align: "left" },
        { label: "Ad sets" },
        ...(hasBudget ? [{ label: "Budget" }] : []),
        ...(hasEnd ? [{ label: "Ends" }] : []),
        { label: "Spend" },
      ],
      rows,
      empty: "No campaign group in this account yet.",
      narrow: true,
      pageSize: 10,
    },
  ];
}

function adStatusCell(a: LinkedinAdsAd): ExtraCell {
  const status = (a.intended_status ?? "").toUpperCase();
  if (status === "PAUSED") return { text: "Off", chip: "muted" };
  if (status === "DRAFT") return { text: "Draft", chip: "muted" };
  if (status !== "ACTIVE") return { text: status ? status.charAt(0) + status.slice(1).toLowerCase() : "Unknown", chip: "muted" };
  const review = a.review_status ?? "";
  if (/REJECT/i.test(review) || a.hold_reasons.some((r) => /REJECT/i.test(r))) return { text: "Rejected", chip: "bad", title: "LinkedIn rejected this ad, so it is not serving." };
  if (/PENDING|NEEDS_REVIEW/i.test(review) || a.hold_reasons.some((r) => /REVIEW/i.test(r))) return { text: "In review", chip: "warn", title: "LinkedIn is still reviewing this ad." };
  if (a.hold_reasons.some((r) => /BUDGET/i.test(r))) return { text: "Out of budget", chip: "warn", title: "This ad is on, but a budget LinkedIn enforces stops it from serving." };
  if (a.is_serving === false || a.hold_reasons.length) return { text: "On hold", chip: "warn", title: `This ad is on, but LinkedIn is holding it${a.hold_reasons.length ? ` (${a.hold_reasons.join(", ")})` : ""}.` };
  if (a.is_serving === true || /APPROVED/i.test(review)) return { text: "On", chip: "good" };
  return { text: "On", chip: "muted", title: "Zavi could not read whether this ad is serving." };
}

export function linkedinAdsAdsTable(payload: unknown, ctx?: LinkedinPauseCtx): ExtraTableData[] {
  if (!isLinkedinAdsPayload(payload) || !payload.connected || payload.error_code || !payload.totals || !Array.isArray(payload.ads)) return [];
  const campaigns = new Map((payload.campaigns ?? []).map((c) => [c.id, c]));
  const liveAds = new Map<string, number>();
  for (const a of payload.ads) if (a.intended_status === "ACTIVE") liveAds.set(a.campaign_id, (liveAds.get(a.campaign_id) ?? 0) + 1);
  const actionsOf = (a: LinkedinAdsAd): { actions: ExtraRowAction[] } | Record<string, never> => {
    if (!ctx?.canPause) return {};
    const campaign = campaigns.get(a.campaign_id);
    const path = `ads/${encodeURIComponent(a.id)}/propose-status`;
    const body = (status: "ACTIVE" | "PAUSED") => ({ account_id: a.ad_account_id, campaign_id: a.campaign_id, status });
    if (a.intended_status === "ACTIVE") {
      if (campaign?.status === "ACTIVE" && (liveAds.get(a.campaign_id) ?? 0) <= 1) return {};
      return {
        actions: [
          rowAct("ad_off", a.id, { label: "Turn off", busy: "Turning off…", title: `Turn off the ad "${a.name}" in LinkedIn now.`, note: AD_OFF_DONE_NOTE }, cardNow(ctx, "ad_off", path, body("PAUSED")), ctx),
        ],
      };
    }
    if (a.intended_status === "PAUSED" || a.intended_status === "DRAFT")
      return {
        actions: [
          rowAct("ad_on", a.id, { label: "Turn on", busy: "Turning on…", title: `Turn on the ad "${a.name}" in LinkedIn now. It serves and spends again.`, note: AD_ON_DONE_NOTE }, cardNow(ctx, "ad_on", path, body("ACTIVE")), ctx),
        ],
      };
    return {};
  };
  const adCampaignIds = [...new Set(payload.ads.map((a) => a.campaign_id))].sort().join(",");
  const rows: ExtraRow[] = [...payload.ads]
    .sort((a, b) => Number(b.intended_status === "ACTIVE") - Number(a.intended_status === "ACTIVE") || a.name.localeCompare(b.name))
    .map((a) => ({
      id: a.id,
      ...actionsOf(a),
      cells: [{ text: a.name, strong: true, media: adThumbnail("linkedin_ads", a.id, a.name, adCampaignIds, a.campaign_id) }, { text: campaigns.get(a.campaign_id)?.name ?? UNKNOWN }, adStatusCell(a)],
    }));
  return [
    {
      title: "Ads",
      icon: BarChart3,
      columns: [
        { label: "Ad", align: "left" },
        { label: "Ad set", align: "left" },
        { label: "Status", align: "left" },
      ],
      rows,
      empty: (payload.campaigns ?? []).some((c) => c.ad_delivery === "unread") ? "Zavi could not read this account's ads from LinkedIn just now. Refresh to try again." : "No ad in a running ad set. Zavi lists the ads of ad sets that are on.",
      pageSize: 10,
      caption: "Ads of ad sets that are on. Turning an ad off is refused when it is the only ad that is on in a running ad set.",
    },
  ];
}

export function linkedinAdsChrome(payload: unknown): ChannelChrome | null {
  if (!isLinkedinAdsPayload(payload) || typeof payload.connected !== "boolean") return null;
  const a = payload.account;
  const n = a?.active_count ?? 0;
  const own = !payload.error_code && payload.own_error_code ? ownProblem(payload.own_error_code, payload.retry_at) : null;
  const retryAt = retryTime(payload.retry_at);
  const skipped = accountErrorsText(payload.account_errors);
  return {
    connected: payload.connected,
    ranges: payload.ranges?.length ? payload.ranges : DEFAULT_RANGES,
    period: payload.period ?? null,
    account: a ? { name: a.name, sub: `${n} active ${n === 1 ? "campaign" : "campaigns"}` } : null,
    problem:
      payload.error_code === "linkedin_ads_token_revoked"
        ? {
            text: "LinkedIn Ads stopped accepting Zavi's access, so these numbers could not be read. Reconnect to bring them back.",
            reconnect: true,
          }
        : payload.error_code === "linkedin_ads_forbidden"
          ? {
              text: "LinkedIn did not let Zavi read this ad account. Ask an account admin in LinkedIn Campaign Manager to give your LinkedIn user a role on it, or reconnect with a LinkedIn user who already has one.",
              reconnect: true,
            }
          : own
            ? own
          : payload.error_code === "linkedin_ads_daily_limit"
            ? { text: LINKEDIN_DAILY_LIMIT_TEXT, reconnect: false }
            : payload.error_code === "linkedin_ads_rate_limited"
            ? { text: `LinkedIn Ads is limiting requests. ${retryAt ? `Zavi will read it again at ${retryAt}. Try Refresh after that.` : "Wait a minute, then try Refresh."}`, reconnect: false }
            : walletMissing(payload)
              ? { text: walletText(payload), reconnect: false }
            : payload.connected && payload.own_connected === false
              ? { text: "Your LinkedIn account is not connected, so this page shows only the campaigns Zavi runs from your shared wallet. Connect LinkedIn to see your own ad accounts here too.", reconnect: true, firstConnect: true }
              : payload.error_code
                ? { text: "Zavi could not read your LinkedIn Ads account just now. Try Refresh in a minute.", reconnect: false }
                : skipped
                  ? { text: skipped, reconnect: false }
                : payload.connected && !a
                  ? payload.held_elsewhere?.length
                    ? { text: `${payload.held_elsewhere.length === 1 ? `Your LinkedIn ad account ${payload.held_elsewhere[0]} is` : `Your LinkedIn ad accounts ${payload.held_elsewhere.join(", ")} are`} already connected to another Zavi workspace, so you cannot use ${payload.held_elsewhere.length === 1 ? "it" : "them"} here. An ad account runs in one workspace at a time. Open that workspace to see its campaigns and numbers, or disconnect LinkedIn Ads there first.${payload.wallet_offered ? " You can still run ads here from your shared wallet, in Settings." : ""}`, reconnect: false }
                  : payload.wallet_offered
                    ? { text: "Choose how to run LinkedIn ads to get started. Use your own LinkedIn ad account, or let Zavi run them and pay from your shared wallet. You need one, not both.", reconnect: false, settings: "Set up ads account" }
                    : { text: "Connect your ad account to get started. LinkedIn is connected, but this workspace has no ad account yet, so Zavi cannot show numbers or run campaigns.", reconnect: false, settings: "Connect ad account" }
                  : null,
    plan: null,
  };
}

export function linkedinAdsAccountId(payload: unknown): string | null {
  if (!isLinkedinAdsPayload(payload)) return null;
  const id = payload.account?.id;
  return typeof id === "string" && /^\d+$/.test(id) ? id : null;
}

export function linkedinAdsCampaignLinks(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isLinkedinAdsPayload(payload)) return out;
  for (const c of payload.campaigns ?? []) if (c.name && c.url) out[c.name] = c.url;
  return out;
}
