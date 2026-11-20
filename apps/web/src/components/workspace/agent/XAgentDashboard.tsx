"use client";

import type { XDraft } from "./xDraftTypes";

import { useMemo, useRef, useState } from "react";
import {
  Activity,
  AlignLeft,
  Calendar,
  Check,
  ChevronDown,
  CircleUserRound,
  ExternalLink,
  Eye,
  Heart,
  Image as ImageIcon,
  Link2,
  MessageSquare,
  Pin,
  RefreshCw,
  Repeat2,
  Sparkles,
  UserPlus,
  Users,
  CircleCheck,
  CircleX,
  CircleDashed,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { approveDecision } from "@/lib/approvals/approveDecision";
import { ActionSection } from "../actions/ActionSection";
import { platformFor } from "../actions/platforms";
import type { ActionHandlers, ActionItem, PlatformSpec } from "../actions/types";
import { storeUnresolved, useChannelActions } from "../actions/useChannelActions";
import { SummaryRow, type MetricDisplay } from "../metrics/SummaryRow";
import { useOpenStatic } from "../layout/shared";
import { legacyApprovalHandlers, xMetricsToMetrics } from "./legacyChannelActions";
import { publishPost, xPanelSections } from "./xStagedPosts";
import {
  DashboardControls, DashboardShell, EmptyState, Menu, btn, num, useAgentDashboard, useExternalRefresh, useRefreshingSignal,
} from "./dashboard-ui";

export type XPostRow = {
  id: string;
  external_post_id: string | null;
  url: string | null;
  text: string;
  format: string;
  kind?: string;
  posted_at: string | null;
  source: "zavi" | "account";
  status: string;
  thumb_url: string | null;
  media_type: string | null;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  bookmarks: number;
  link_clicks: number;
  profile_clicks: number;
  engagements: number;
  eng_rate: number | null;
  private_metrics_available: boolean;
};

export type XMetric = {
  key: "impressions" | "engagement_rate" | "profile_visits" | "link_clicks" | "new_follows" | "replies" | "likes" | "reposts";
  label: string;
  value: number | null;
  unit: "count" | "pct";
  delta: number | null;
  delta_unit: "pct" | "pp";
  basis: "period" | "totals" | "partial" | "none";
};

export type XAttention = {
  key: string;
  title: string;
  detail: string;
  mode: "manual" | "approval";
  status: "open" | "done";
  effort: string;
  decision_id: string | null;
  link: string | null;
  blocking: boolean;
};

export type { XDraft } from "./xDraftTypes";

export type XChecklistSignal = {
  key: string;
  label: string;
  status: "pass" | "fix" | "unknown";
  note: string;
  link: string | null;
};

export type XRange = { id: string; label: string; days: number };

export type XFormatTotal = { format: string; views: number; engagements: number };

export type XPayload = {
  generic?: boolean;
  drafts_ok?: boolean;
  connected: boolean;
  handle: string | null;
  account_name?: string | null;
  account_handle?: string | null;
  account_read_at?: string | null;
  window_days: number;
  formats?: XFormatTotal[];
  period?: { from: string; to: string };
  ranges?: XRange[];
  read_budget?: { used: number; cap: number; remaining: number };
  read: { read: boolean; reason?: string; error_code?: string };
  actions_waiting?: number;
  metrics: XMetric[];
  attention: XAttention[];
  drafts: XDraft[];
  top_posts: XPostRow[];
  checklist?: { signals: XChecklistSignal[]; passed: number; total: number };
  snapshot_days: number;
};

function normalize(d: XPayload): XPayload & { stale_backend: boolean } {
  const raw = d as Partial<XPayload>;
  return {
    ...d,
    read: raw.read ?? { read: false },
    metrics: Array.isArray(raw.metrics) ? raw.metrics : [],
    attention: Array.isArray(raw.attention) ? raw.attention : [],
    drafts: Array.isArray(raw.drafts) ? raw.drafts : [],
    top_posts: Array.isArray(raw.top_posts) ? raw.top_posts : [],
    stale_backend: !Array.isArray(raw.metrics),
  };
}

const ATTENTION_LIMIT = 4;

const DEFAULT_RANGES: XRange[] = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "14d", label: "Last 14 days", days: 14 },
  { id: "30d", label: "Last 30 days", days: 30 },
];

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function periodLabel(range: XRange, period?: { from: string; to: string }): string {
  if (!period) return range.label;
  const year = new Date(`${period.to}T00:00:00Z`).getUTCFullYear();
  return `${range.label}: ${shortDate(period.from)} – ${shortDate(period.to)}, ${year}`;
}

function tableDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "-";
}

function readNotice(d: XPayload): { tone: "info" | "warn"; text: string } | null {
  const code = d.read.error_code;
  if (!code) return null;
  const msg: Record<string, { tone: "info" | "warn"; text: string }> = {
    x_read_cap_reached: { tone: "info", text: "Today's X read allowance is used up, so these are the last numbers Zavi read. X updates them about once a day, so there is very little to miss. The allowance resets at midnight UTC." },
    x_read_cap_unavailable: { tone: "warn", text: "Zavi could not check this account's read allowance, so it did not read X. That is a fault on our side, not something you can fix." },
    x_out_of_credits: { tone: "warn", text: "Zavi's X reading allowance is used up for now; the numbers below are from the last read." },
    x_not_authorized: { tone: "warn", text: "X refused the read. Reconnect X in Settings." },
    x_token_refresh_failed: { tone: "warn", text: "X is connected, but this read could not refresh the access token. Reconnecting will not help; this is ours to fix." },
    x_rate_limited: { tone: "info", text: "X rate-limited this account. Nothing was charged, and the next read will pick it up." },
    x_snapshot_unavailable: { tone: "warn", text: "The daily snapshot table is not set up on this database yet, so Zavi is not reading X." },
  };
  return msg[code] ?? { tone: "warn", text: d.read.reason ?? "The last X read did not complete." };
}

const DISPLAY: Record<string, MetricDisplay> = {
  impressions: { label: "Impressions", icon: Eye },
  engagement_rate: { label: "Engagement rate", icon: Activity },
  profile_visits: { label: "Profile visits", icon: Users },
  link_clicks: { label: "Link clicks", icon: Link2 },
  new_follows: { label: "New follows", icon: UserPlus },
  replies: { label: "Replies", icon: MessageSquare },
  likes: { label: "Likes", icon: Heart },
  reposts: { label: "Reposts", icon: Repeat2 },
};

const CHECK_ICON: Record<string, typeof Pin> = {
  bio: AlignLeft,
  avatar: CircleUserRound,
  header: ImageIcon,
  pinned: Pin,
};

export function XAgentDashboard({
  variant = "panel",
  refreshTick,
  active,
  onRefreshingChange,
}: {
  variant?: "panel" | "analytics";
  refreshTick?: number;
  active?: boolean;
  onRefreshingChange?: (refreshing: boolean) => void;
} = {}) {
  const [rangeId, setRangeId] = useState("30d");
  const days = (DEFAULT_RANGES.find((r) => r.id === rangeId) ?? DEFAULT_RANGES[2]).days;
  const params = useMemo(() => ({ days: String(days) }), [days]);
  const state = useAgentDashboard<XPayload>("x_organic", { params });
  useExternalRefresh(state, refreshTick, active);
  useRefreshingSignal(state.refreshing, onRefreshingChange);
  const channel = useChannelActions("x_organic");
  const openStatic = useOpenStatic();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refetch = () => (state.refreshSilent ?? state.refresh)();

  const post = async (draft: XDraft, edited?: { text: string; thread?: string[] }): Promise<boolean> => {
    setBusy(draft.decision_id);
    setNotice(null);
    try {
      const ok = async (res: Response | null) => {
        if (!res) return false;
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string }; decision_id?: string };
        if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        return body;
      };
      if (draft.source === "step") {
        const text = edited?.text ?? draft.text;
        const thread = edited?.thread ?? draft.thread ?? undefined;
        const staged = await ok(
          await apiFetch("/api/social/propose", {
            method: "POST",
            body: JSON.stringify({ channel: draft.channel, payload: { text, ...(thread?.length ? { thread } : {}) } }),
            idempotent: true,
          }),
        );
        if (!staged || !staged.decision_id) throw new Error("Could not stage the post.");
        if (!(await ok(await approveDecision(staged.decision_id)))) return false;
        await approveDecision(draft.decision_id).catch(() => null);
      } else {
        if (!(await ok(await approveDecision(draft.decision_id, edited ? { payload_text: edited.text, thread: edited.thread ?? null } : {})))) return false;
      }
      setNotice("Posted. It publishes from your account now.");
      refetch();
      return true;
    } catch (e) {
      setNotice((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const markPosted = async (draft: XDraft): Promise<boolean> => {
    setBusy(draft.decision_id);
    setNotice(null);
    try {
      const res = await approveDecision(draft.decision_id);
      if (!res?.ok) throw new Error("Could not mark it as posted. Try again.");
      refetch();
      return true;
    } catch (e) {
      setNotice((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const publish = async (
    a: ActionItem,
    content: { text: string; thread: string[] | null },
    staged: XDraft | null = null,
  ): Promise<boolean> => {
    setBusy(a.id);
    setNotice(null);
    try {
      await publishPost({ channel: staged?.channel ?? "x", staged, content });
      setNotice("Posted. It publishes from your account now.");
      refetch();
      return true;
    } catch (e) {
      setNotice((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const didIt = async (item: XAttention) => {
    setBusy(item.key);
    try {
      const res = await apiFetch(`/api/channels/x_organic/checks/${encodeURIComponent(item.key)}/done`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      refetch();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <DashboardShell<XPayload>
      state={state}
      genericFallback={<EmptyState title="No X panel yet">Connect X in Settings and run the channel once.</EmptyState>}
      render={(raw) => (
        <Body
          d={normalize(raw)}
          analytics={variant === "analytics"}
          ownRefresh={refreshTick === undefined}
          busy={busy}
          notice={notice}
          rangeId={rangeId}
          setRangeId={setRangeId}
          refresh={state.refresh}
          refreshing={state.refreshing}
          onPost={post}
          onPosted={markPosted}
          onPublish={publish}
          onDidIt={didIt}
          onReview={() => openStatic("home")}
          channel={channel}
          setBusy={setBusy}
          setNotice={setNotice}
          refetch={refetch}
        />
      )}
    />
  );
}

function Body({
  analytics, ownRefresh, d, busy, notice, rangeId, setRangeId, refresh, refreshing, onPost, onPosted, onPublish, onDidIt, onReview, channel, setBusy, setNotice, refetch,
}: {
  analytics: boolean;
  ownRefresh: boolean;
  d: XPayload & { stale_backend: boolean };
  busy: string | null;
  notice: string | null;
  rangeId: string;
  setRangeId: (id: string) => void;
  refresh: () => void;
  refreshing: boolean;
  onPost: (draft: XDraft, edited?: { text: string; thread?: string[] }) => Promise<boolean>;
  onPosted: (draft: XDraft) => Promise<boolean>;
  onPublish: (
    a: ActionItem,
    content: { text: string; thread: string[] | null },
    staged?: XDraft | null,
  ) => Promise<boolean>;
  onDidIt: (item: XAttention) => Promise<void>;
  onReview: () => void;
  channel: ReturnType<typeof useChannelActions>;
  setBusy: (id: string | null) => void;
  setNotice: (n: string | null) => void;
  refetch: () => void;
}) {
  const ranges = d.ranges?.length ? d.ranges : DEFAULT_RANGES;
  const range = ranges.find((r) => r.id === rangeId) ?? ranges[ranges.length - 1];
  const budget = d.read_budget;
  const capped = !!budget && budget.cap > 0 && budget.remaining <= 0;
  const notice_ = readNotice(d);
  const [attentionOpen, setAttentionOpen] = useState(true);
  const published = useRef<Set<string>>(new Set());
  const [showAllAttention, setShowAllAttention] = useState(false);
  const basisNote = d.metrics.some((m) => m.basis === "totals")
    ? "First read today: these are lifetime totals of posts published in the window. From tomorrow they become what accrued in the window, like X's own dashboard."
    : d.metrics.some((m) => m.basis === "partial")
      ? "New follows are measured from the first day Zavi read the account inside this window."
      : null;

  const totals = d.top_posts.reduce(
    (acc, p) => ({ views: acc.views + p.views, likes: acc.likes + p.likes, replies: acc.replies + p.replies, reposts: acc.reposts + p.reposts, bookmarks: acc.bookmarks + p.bookmarks, eng: acc.eng + p.engagements }),
    { views: 0, likes: 0, replies: 0, reposts: 0, bookmarks: 0, eng: 0 },
  );
  const totalRate = totals.views > 0 ? `${Math.round((totals.eng / totals.views) * 10000) / 100}%` : "-";
  const openStatic = useOpenStatic();

  const switched = channel.store === "channel_actions";
  const storeUnknown = channel.store === "unknown";
  const storeFailed = storeUnresolved(channel);
  const sections = xPanelSections({
    switched,
    drafts: d.drafts,
    attention: d.attention,
    channelActions: channel.actions,
  });
  const actions = storeUnknown ? [] : sections.cards;
  const attentionRows = storeUnknown ? d.attention.filter((a) => a.mode === "manual") : sections.attention;
  const openAttention = attentionRows.filter((a) => a.status === "open");
  const waiting = openAttention.length + actions.length + (switched ? channel.more : 0);
  const metrics = channel.metrics.length ? channel.metrics : xMetricsToMetrics(d.metrics, d.period?.to ?? "");
  const draftById = new Map(d.drafts.map((x) => [x.decision_id, x]));
  const approvals = legacyApprovalHandlers({ setBusy, setNotice, refetch });
  const legacy: ActionHandlers = {
    ...approvals,
    onSetStatus: (a, status, opts) => {
      const draft = draftById.get(a.id);
      if (status === "acted") {
        if (published.current.has(a.id)) return;
        if (draft) return onPosted(draft);
      }
      return approvals.onSetStatus(a, status, opts);
    },
    ...(d.connected
      ? {
          onPublish: async (a: ActionItem, content: { text: string; thread: string[] | null }) => {
            const draft = draftById.get(a.id);
            if (!draft) return false;
            const edited =
              content.text === draft.text && (content.thread ?? null)?.join("\n") === (draft.thread ?? null)?.join("\n")
                ? undefined
                : { text: content.text, ...(content.thread?.length ? { thread: content.thread } : {}) };
            const ok = await onPost(draft, edited);
            if (ok) published.current.add(a.id);
            return ok;
          },
        }
      : {}),
  };
  const switchedHandlers: ActionHandlers = {
    ...channel.handlers,
    onSetStatus: (a, status, opts) => {
      if (!sections.stagedCardIds.has(a.id)) return channel.handlers.onSetStatus(a, status, opts);
      if (status === "acted" && published.current.has(a.id)) return;
      return approvals.onSetStatus(a, status, opts);
    },
    onRedo: (a, note, kind) =>
      sections.stagedCardIds.has(a.id) ? approvals.onRedo(a, note) : kind ? channel.handlers.onRedo(a, note, kind) : channel.handlers.onRedo(a, note),
    ...(d.connected
      ? {
          onPublish: async (a: ActionItem, content: { text: string; thread: string[] | null }) => {
            if (!sections.stagedCardIds.has(a.id) && d.drafts_ok === false) {
              setNotice("Zavi could not check what is already waiting to post. Try again.");
              return false;
            }
            const ok = await onPublish(a, content, sections.stagedFor.get(a.id) ?? null);
            if (ok && sections.stagedCardIds.has(a.id)) published.current.add(a.id);
            return ok;
          },
        }
      : {}),
  };
  const handlers: ActionHandlers = switched ? switchedHandlers : legacy;
  const cardBusy = switched ? channel.busyId ?? busy : busy;
  const platform: PlatformSpec = {
    ...platformFor("x_organic"),
    account: { name: d.account_name ?? d.handle ?? "Your account", handle: d.handle },
  };
  const message = notice ?? (switched ? channel.notice : null);

  return (
    <div className="space-y-8">
      {}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[16px] text-inkMuted">
          {d.handle ? <span className="font-medium text-ink">{d.handle}</span> : "X not connected"}
          {d.connected && !analytics && <> · {waiting} actions waiting</>}
        </p>
        <DashboardControls className="ml-auto" stack={false}>
          <Menu label={periodLabel(range, d.period)} icon={<Calendar className="h-4 w-4 text-inkMuted" aria-hidden />}>
            {(close) => (
              <ul>
                {ranges.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={r.id === rangeId}
                      className={`flex w-full px-3 py-2 text-left text-[16px] text-ink hover:bg-creamDeep ${r.id === rangeId ? "bg-bone font-semibold" : ""}`}
                      onClick={() => {
                        setRangeId(r.id);
                        close();
                      }}
                    >
                      {r.label}
                    </button>
                  </li>
                ))}
                <li className="border-t border-rule px-3 py-2 text-[12px] text-inkMuted">X keeps link clicks and profile visits for 30 days, so there is no longer window.</li>
              </ul>
            )}
          </Menu>
          <div className="flex flex-col items-end">
            {ownRefresh && <button
              type="button"
              onClick={refresh}
              disabled={refreshing || capped || !d.connected}
              title={capped ? "Today's X read allowance is used up" : "Read your account from X now"}
              className={`${btn.secondary} compact:shrink-0`}
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
              {refreshing ? "Reading X…" : "Refresh"}
            </button>}
            {budget && budget.cap > 0 && (
              <span className="mt-0.5 text-[11px] text-inkMuted" aria-live="polite">
                {budget.remaining === 0 ? "No reads left today" : `${budget.remaining} of ${budget.cap} reads left today`}
              </span>
            )}
          </div>
        </DashboardControls>
      </div>

      {d.stale_backend && (
        <p role="status" className="rounded-xl border border-rule bg-creamDeep px-4 py-3 text-[16px] text-ink">
          This panel was updated, but the server behind it has not been redeployed yet, so the numbers and drafts cannot load. Nothing is wrong with your account.
        </p>
      )}
      {notice_ && (
        <p role="status" className={`rounded-xl border px-4 py-3 text-[16px] text-ink ${notice_.tone === "warn" ? "border-red-400/40 bg-red-500/10" : "border-rule bg-creamDeep"}`}>
          {notice_.text}
        </p>
      )}
      {message && <p role="status" className="text-[16px] text-inkMuted">{message}</p>}

      {}
      <section className="space-y-4" aria-label="Headline numbers">
        <SummaryRow metrics={metrics} perRow={4} display={DISPLAY} />
        {basisNote && <p className="text-[13px] text-inkMuted">{basisNote}</p>}
      </section>

      {!analytics && (
        <>
      {}
      <ActionSection
        title="Drafts"
        actions={actions}
        platform={platform}
        handlers={handlers}
        busyId={cardBusy}
        more={switched ? channel.more : 0}
        onShowMore={switched ? channel.showAll : undefined}
        empty={
          storeFailed ? (
            <span>
              Zavi could not load your X actions just now, so none are shown rather than the wrong ones.{" "}
              <button type="button" onClick={channel.reload} className="font-medium text-ink underline underline-offset-2">
                Try again
              </button>
            </span>
          ) : storeUnknown ? (
            <span role="status" aria-busy="true">
              Reading what is waiting on this channel…
            </span>
          ) : d.connected ? (
            "No drafts waiting. Zavi drafts every day once the schedule is on."
          ) : (
            "No drafts yet. Run the X channel once and Zavi writes your week here. No X connection needed."
          )
        }
      />

      {}
      <section aria-label="Needs your attention">
        <div className="mb-3 flex items-center justify-between gap-3">
          <button type="button" aria-expanded={attentionOpen} onClick={() => setAttentionOpen((v) => !v)} className="flex w-full cursor-pointer items-center gap-2">
            <h2 className="text-[22px] font-semibold tracking-tight text-ink">Needs your attention</h2>
            <span className="rounded-md bg-bone px-2 py-0.5 text-[16px] font-medium text-inkMuted">{openAttention.length}</span>
            <ChevronDown className={`ml-auto h-5 w-5 text-inkMuted transition-transform ${attentionOpen ? "" : "-rotate-90"}`} aria-hidden />
          </button>
        </div>
        {attentionOpen && (
          <>
            {attentionRows.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-rule p-4 text-[16px] text-inkMuted">
                {d.connected ? "Nothing needs you right now." : "Connect X in Settings to see what needs attention."}
              </p>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-rule">
                {(showAllAttention ? attentionRows : attentionRows.slice(0, ATTENTION_LIMIT)).map((a) => {
                  const Icon = a.mode === "approval" ? Sparkles : CHECK_ICON[a.key] ?? Pin;
                  return (
                    <div key={a.key} className="flex items-start gap-3 border-b border-rule p-4 last:border-b-0">
                      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-inkMuted" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-semibold text-ink">{a.title}</p>
                        <p className="mt-0.5 text-[16px] leading-relaxed text-inkMuted">{a.detail}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="hidden text-[16px] text-inkLight sm:inline">
                          {a.mode === "approval" ? "Needs approval" : "On X"} · {a.effort}
                        </span>
                        {a.status === "done" ? (
                          <span className={btn.done}>
                            <Check className="h-4 w-4" aria-hidden />
                            Done
                          </span>
                        ) : a.mode === "approval" ? (
                          <button type="button" onClick={onReview} className={btn.secondary}>
                            Review
                          </button>
                        ) : (
                          <>
                            {a.link && (
                              <a href={a.link} target="_blank" rel="noopener noreferrer" className={btn.secondary}>
                                Open X
                                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                              </a>
                            )}
                            <button type="button" disabled={busy === a.key} onClick={() => void onDidIt(a)} className={btn.primary}>
                              {busy === a.key ? "…" : "Did it"}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {attentionRows.length > ATTENTION_LIMIT && (
              <button
                type="button"
                aria-expanded={showAllAttention}
                onClick={() => setShowAllAttention((v) => !v)}
                className="mt-2 inline-flex items-center gap-1 text-[16px] font-medium text-inkMuted underline-offset-2 hover:underline"
              >
                {showAllAttention ? "Show less" : "Show more"}
                <ChevronDown className={`h-4 w-4 transition-transform ${showAllAttention ? "rotate-180" : ""}`} aria-hidden />
              </button>
            )}
          </>
        )}
      </section>

        </>
      )}

      {}
      <section aria-label="Top posts">
        <h2 className="mb-1 text-[22px] font-semibold tracking-tight text-ink">Top posts {range.days <= 7 ? "this week" : "this period"}</h2>
        <p className="mb-3 text-[16px] text-inkMuted">What worked, so the next drafts lean the same way.</p>
        {d.top_posts.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rule bg-cream px-4 py-4">
            <p className="text-[16px] text-inkMuted">
              {d.connected ? "Nothing published in this window yet." : "Connect X to see your posts here."}
            </p>
            {!d.connected && (
              <button type="button" onClick={() => openStatic("brain")} className={`${btn.primary} shrink-0`}>
                Connect X
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-rule bg-cream">
            <table className="w-full min-w-[840px] text-[14px]">
              <thead>
                <tr className="border-b border-rule bg-creamDeep text-[16px] font-semibold text-inkMuted">
                  <th scope="col" className="px-4 py-2.5 text-left font-semibold">Post</th>
                  {["Views", "Likes", "Replies", "Reposts", "Bookmarks", "Eng. rate", "Posted"].map((h) => (
                    <th key={h} scope="col" className="px-2 py-2.5 text-right font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.top_posts.map((p) => (
                  <tr key={p.id} className="border-b border-rule last:border-b-0">
                    <td className="max-w-[420px] px-4 py-4">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="min-w-0 truncate font-medium text-ink">{p.text || "(no text)"}</p>
                        <span className={`shrink-0 rounded-md px-2 py-0.5 text-[13px] font-medium ${p.format === "thread" ? "bg-emerald-500/15 text-emerald-600" : "bg-bone text-inkMuted"}`}>
                          {p.format.charAt(0).toUpperCase() + p.format.slice(1)}
                        </span>
                        {p.source === "zavi" && <span className="shrink-0 rounded-md bg-emerald-500/15 px-2 py-0.5 text-[13px] font-medium text-emerald-600">Zavi</span>}
                      </div>
                    </td>
                    <td className="px-2 py-4 text-right font-semibold tabular-nums text-ink">{num(p.views)}</td>
                    <td className="px-2 py-4 text-right tabular-nums text-inkMuted">{num(p.likes)}</td>
                    <td className="px-2 py-4 text-right tabular-nums text-inkMuted">{num(p.replies)}</td>
                    <td className="px-2 py-4 text-right tabular-nums text-inkMuted">{num(p.reposts)}</td>
                    <td className="px-2 py-4 text-right tabular-nums text-inkMuted">{num(p.bookmarks)}</td>
                    <td className="px-2 py-4 text-right font-semibold tabular-nums text-ink">{p.eng_rate === null ? "-" : `${p.eng_rate}%`}</td>
                    <td className="px-2 py-4 text-right tabular-nums text-inkMuted">
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{tableDate(p.posted_at)}</a>
                      ) : (
                        tableDate(p.posted_at)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-rule bg-creamDeep font-semibold text-ink">
                  <td className="px-4 py-3">{d.top_posts.length} posts</td>
                  <td className="px-2 py-3 text-right tabular-nums">{num(totals.views)}</td>
                  <td className="px-2 py-3 text-right tabular-nums">{num(totals.likes)}</td>
                  <td className="px-2 py-3 text-right tabular-nums">{num(totals.replies)}</td>
                  <td className="px-2 py-3 text-right tabular-nums">{num(totals.reposts)}</td>
                  <td className="px-2 py-3 text-right tabular-nums">{num(totals.bookmarks)}</td>
                  <td className="px-2 py-3 text-right tabular-nums">{totalRate}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="mt-2 text-[13px] text-inkMuted">Numbers as reported by X, not independently audited.</p>
      </section>

      {}
      {!analytics && d.checklist && (
        <section aria-label="X profile checklist" className="overflow-hidden rounded-2xl border border-rule bg-cream">
          <div className="flex items-start justify-between gap-4 px-6 py-4">
            <div>
              <h2 className="text-[14px] font-semibold uppercase tracking-wide text-inkMuted">X profile checklist</h2>
              <p className="mt-1 text-[14px] text-inkMuted">Profile and posting signals Zavi checks daily</p>
            </div>
            <span className="rounded-full bg-bone px-4 py-2 text-[16px] font-semibold tabular-nums text-ink">
              {d.checklist.passed}/{d.checklist.total}
            </span>
          </div>
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-y border-rule text-[13px] font-semibold uppercase tracking-wide text-inkMuted">
                <th scope="col" className="px-6 py-3 text-left font-semibold">Signal</th>
                <th scope="col" className="px-6 py-3 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {d.checklist.signals.map((sig) => (
                <tr key={sig.key} className="border-b border-rule last:border-b-0">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      {sig.status === "pass" ? (
                        <CircleCheck className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
                      ) : sig.status === "fix" ? (
                        <CircleX className="h-5 w-5 shrink-0 text-amber-500" aria-hidden />
                      ) : (
                        <CircleDashed className="h-5 w-5 shrink-0 text-inkLight" aria-hidden />
                      )}
                      <span className="text-ink" title={sig.note}>{sig.label}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right font-semibold">
                    {sig.status === "pass" ? (
                      <span className="text-emerald-600">Pass</span>
                    ) : sig.status === "unknown" ? (
                      <span className="text-inkLight" title={sig.note}>No data yet</span>
                    ) : sig.link ? (
                      <a href={sig.link} target="_blank" rel="noopener noreferrer" className="text-amber-500 hover:underline" title={sig.note}>Fix</a>
                    ) : (
                      <span className="text-amber-500" title={sig.note}>Needs work</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
