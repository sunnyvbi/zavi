"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiFetch } from "@/lib/api";
import { useRealtimeChannel } from "@/lib/workspace/useRealtimeChannel";
import { useDashboardOpenSource } from "@/lib/workspace/dashboardOpenSource";
import { useWorkspace, useWorkspaceOptional } from "@/components/workspace/WorkspaceShell";
import { readWithRetry } from "@/lib/workspace/channelRead";
import { cx } from "../layout/shared";
import { ChannelCachedLine, useChannelReadCachedAt } from "../layout/ChannelRefresh";
import { InlineLoading } from "../InlineLoading";
import { InlineStatusRow } from "../InlineStatusRow";
import { NextChevron } from "@/components/ui/NextChevron";
import {
  channelCacheAge,
  clearChannelReadCache,
  readChannelCacheEntry,
  writeChannelCache,
} from "@/lib/workspace/channelReadCache";
export { Menu } from "../../ui/Menu";

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
export function ratio(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `${n.toFixed(2)}×`;
}
export function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return `${Math.round(n)}%`;
}
export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
export function ago(iso: string | null | undefined): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "-";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export type DashboardState<T> = {
  data: T | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => void;
  refreshSilent?: () => void;
  reread?: () => void;
  newRowIds: Set<string>;
  cachedAt?: number | null;
  cachedLineAt?: number | null;
};

export type AgentDashboardActiveRun = {
  run_id: string;
  status?: string | null;
  enqueued_at?: string | null;
  started_at?: string | null;
};

type AgentRunLoadingCopy = {
  title?: string;
  subtitle?: string;
  steps?: string[];
  asideTitle?: string;
  aside?: ReactNode;
};

type ThreadEventRow = { kind?: string; body?: unknown };

const HIGHLIGHT_MS = 4000;
const LIVE_REFRESH_DELAYS_MS = [400, 2500];

export function __resetAgentDashCache(): void {
  clearChannelReadCache();
}
const AGENT_DASH_TTL_MS = 5 * 60 * 1000;

export function useRefreshingSignal(
  refreshing: boolean,
  onRefreshingChange?: (refreshing: boolean) => void,
) {
  useEffect(() => {
    onRefreshingChange?.(refreshing);
  }, [refreshing, onRefreshingChange]);
}

export function useExternalRefresh(
  state: { refresh: () => void },
  refreshTick = 0,
  active = true,
) {
  const lastTick = useRef(refreshTick);
  useEffect(() => {
    if (refreshTick === lastTick.current) return;
    lastTick.current = refreshTick;
    if (active) state.refresh();
  }, [refreshTick, active, state]);
}

export function useAgentDashboard<T>(
  slug: string,
  opts?: {
    getRowIds?: (data: T) => string[];
    params?: Record<string, string>;
  },
): DashboardState<T> {
  const tenantName = useWorkspaceOptional()?.tenantName;
  const paramString = new URLSearchParams(
    Object.entries(opts?.params ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  ).toString();
  const cacheKeyRef = useRef(`dash:${tenantName ?? "_"}:${slug}:${paramString}`);
  cacheKeyRef.current = `dash:${tenantName ?? "_"}:${slug}:${paramString}`;
  const [data, setData] = useState<T | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const showOwnCachedLine = useChannelReadCachedAt(cachedAt);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newRowIds, setNewRowIds] = useState<Set<string>>(() => new Set());
  const openSource = useDashboardOpenSource();

  const dataRef = useRef<T | null>(null);
  const getRowIdsRef = useRef(opts?.getRowIds);
  useEffect(() => {
    getRowIdsRef.current = opts?.getRowIds;
  }, [opts?.getRowIds]);
  const highlightTimer = useRef<number | null>(null);
  const liveTimers = useRef<number[]>([]);
  const seqRef = useRef(0);

  const rowIdsOf = (d: T | null): string[] => {
    const fn = getRowIdsRef.current;
    if (!d || !fn) return [];
    try {
      return fn(d);
    } catch {
      return [];
    }
  };

  const load = useCallback(
    async (mode: "initial" | "manual" | "live" | "reread") => {
      const seq = ++seqRef.current;
      if (mode === "manual" || mode === "reread") setRefreshing(true);
      else if (mode === "initial" && dataRef.current === null) setLoading(true);
      if (mode !== "live" && mode !== "reread") setError(null);
      try {
        const base =
          mode === "manual"
            ? "refresh=1&meter=1"
            : mode === "live"
              ? "refresh=1"
              : mode === "reread"
                ? "refresh=1&scope=selection"
              : openSource === "summon"
                ? "source=summon"
                : "";
        const query = [base, paramString].filter(Boolean).join("&");
        const path = `/api/agents/${slug}/dashboard${query ? `?${query}` : ""}`;
        const res =
          mode === "initial"
            ? await readWithRetry(path, { read: "dashboard", slug })
            : await apiFetch(path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = (await res.json()) as T;
        if (seq !== seqRef.current) return;
        if (mode === "live" && dataRef.current !== null) {
          const prevIds = new Set(rowIdsOf(dataRef.current));
          const added = rowIdsOf(next).filter((id) => !prevIds.has(id));
          if (added.length > 0) {
            setNewRowIds(new Set(added));
            if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
            highlightTimer.current = window.setTimeout(
              () => setNewRowIds(new Set()),
              HIGHLIGHT_MS,
            );
          }
        }
        dataRef.current = next;
        setData(next);
        setError(null);
        writeChannelCache(cacheKeyRef.current, next);
        setCachedAt(null);
      } catch (e) {
        if (mode !== "live" && mode !== "reread" && seq === seqRef.current)
          setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [slug, openSource, paramString],
  );

  const refreshSilent = useCallback(() => void load("live"), [load]);
  const reread = useCallback(() => void load("reread"), [load]);

  useEffect(() => {
    setNewRowIds(new Set());
    const hit = readChannelCacheEntry<T>(cacheKeyRef.current);
    if (hit !== null) {
      dataRef.current = hit.data;
      setData(hit.data);
      setCachedAt(hit.at);
      setLoading(false);
    } else {
      dataRef.current = null;
      setCachedAt(null);
    }
    void load("initial");
  }, [load]);

  const scheduleLiveRefresh = useCallback(() => {
    for (const t of liveTimers.current) window.clearTimeout(t);
    liveTimers.current = LIVE_REFRESH_DELAYS_MS.map((ms) =>
      window.setTimeout(() => void load("live"), ms),
    );
  }, [load]);

  useRealtimeChannel<ThreadEventRow>({
    table: "thread_event",
    scopeKey: `agent_slug:${slug}`,
    filter: `agent_slug=eq.${slug}`,
    onInsert: (row) => {
      if (row.kind !== "run_end") return;
      const status = (row.body as { status?: string } | null)?.status;
      if (status === "success") scheduleLiveRefresh();
    },
  });

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const age = channelCacheAge(cacheKeyRef.current);
      if (age === null || age >= AGENT_DASH_TTL_MS) void load("live");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  useEffect(() => {
    return () => {
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
      for (const t of liveTimers.current) window.clearTimeout(t);
    };
  }, []);

  return {
    data,
    loading,
    refreshing,
    error,
    refresh: () => void load("manual"),
    refreshSilent,
    reread,
    newRowIds,
    cachedAt,
    cachedLineAt: showOwnCachedLine ? cachedAt : null,
  };
}

export function DashboardHeader({
  title,
  subtitle,
  onRefresh,
  refreshing,
}: {
  title: string;
  subtitle?: string;
  onRefresh?: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <h2 className="text-[16px] font-semibold text-[#0e0f11]">{title}</h2>
        {subtitle ? (
          <p className="text-[12px] text-[#595959]">{subtitle}</p>
        ) : null}
      </div>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="shrink-0 cursor-pointer rounded-cta border border-[#e5e7eb] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#1f1f1f] transition-colors hover:bg-[#f7f4ee] disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      )}
    </div>
  );
}

export function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#e5e7eb] bg-white px-4 py-3">
      <div className="text-[12px] uppercase tracking-wide text-[#8a8a8a]">
        {label}
      </div>
      <div className="mt-1 text-[20px] font-semibold tabular-nums text-[#0e0f11]">
        {value}
      </div>
    </div>
  );
}

export function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function KpiStrip({ children }: { children: React.ReactNode }) {
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const columns = width === 0 ? 0 : width >= 620 ? 4 : width >= 300 ? 2 : 1;
  return (
    <div
      ref={ref}
      className={cx("grid gap-3", columns === 0 && "grid-cols-[repeat(auto-fit,minmax(150px,1fr))]")}
      style={columns === 0 ? undefined : { gridTemplateColumns: `repeat(${columns}, minmax(0,1fr))` }}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-[#595959]">
      {children}
    </h3>
  );
}

const DEFAULT_RUN_STEPS = [
  "Reading the latest workspace context",
  "Working through the agent task",
  "Preparing the dashboard update",
];

function runStatusLabel(status: string | null | undefined): string {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  return "Running";
}

export function AgentRunLoadingScreen({
  agentSlug,
  activeRun,
  title,
  subtitle,
  steps = DEFAULT_RUN_STEPS,
  asideTitle = "What happens next",
  aside,
  onComplete,
}: {
  agentSlug: string;
  activeRun: AgentDashboardActiveRun;
  title?: string;
  subtitle?: string;
  steps?: string[];
  asideTitle?: string;
  aside?: ReactNode;
  onComplete?: () => void;
}) {
  const statusText = runStatusLabel(activeRun.status);
  return (
    <section
      role="status"
      aria-live="polite"
      className="flex min-h-[520px] flex-col overflow-hidden rounded-xl border border-[#e5e7eb] bg-white"
    >
      <div className="border-b border-[#f0f0f0] px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-[#595959]">
            Agent working
          </div>
          <span className="inline-flex items-center rounded-full border border-[#e5e7eb] bg-[#f7f4ee] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#6b6b6b]">
            {statusText}
          </span>
        </div>
        <h2 className="mt-3 text-[22px] font-semibold tracking-normal text-[#0e0f11]">
          {title ?? "Working on this dashboard"}
        </h2>
        {subtitle ? (
          <p className="mt-1 max-w-[760px] text-[13px] leading-5 text-[#595959]">
            {subtitle}
          </p>
        ) : null}
      </div>

      <div className="grid flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col justify-center gap-5 px-4 py-8">
          <div className="max-w-[720px] rounded-xl border border-[#f0f0f0] bg-[#fbfaf7] px-4 py-4">
            <InlineStatusRow
              key={activeRun.run_id}
              agentSlug={agentSlug}
              runId={activeRun.run_id}
              onComplete={() => {
                window.setTimeout(() => {
                  onComplete?.();
                }, 1500);
              }}
            />
          </div>

          <div className="grid max-w-[720px] gap-3 sm:grid-cols-3">
            {steps.slice(0, 3).map((label) => (
              <div
                key={label}
                className="rounded-xl border border-[#f0f0f0] bg-white px-4 py-3"
              >
                <div className="h-1.5 w-16 animate-pulse rounded-full bg-[#0e0f11]" />
                <div className="mt-3 text-[12px] font-semibold text-[#0e0f11]">
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>

        <aside className="border-t border-[#f0f0f0] bg-[#fbfaf7] px-4 py-4 lg:border-l lg:border-t-0">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-[#595959]">
            {asideTitle}
          </div>
          <div className="mt-2 text-[13px] leading-5 text-[#595959]">
            {aside ?? (
              <p>
                This dashboard will refresh automatically when the run finishes.
                You can leave this page and come back; the run stays attached to
                the agent.
              </p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

export type AttentionItem = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
  decision_id?: string | null;
  is_money?: boolean;
};

function openApprovalsTab(openTab: ReturnType<typeof useWorkspace>["openTab"], decisionId: string | null) {
  openTab({
    kind: "needs-you",
    title: "Needs you",
    payload: { kind: "needs-you", ...(decisionId ? { decision: decisionId } : {}) },
    dirty: false,
    pinned: false,
  });
}

export function AttentionCard({
  item,
  onActed,
}: {
  item: AttentionItem;
  onActed?: () => void;
}) {
  const { openTab } = useWorkspace();
  const isHigh = item.severity === "high";

  const decisionId = item.decision_id ?? null;
  const canInline = decisionId !== null && item.is_money === false;
  const deepLink = decisionId !== null && !canInline;

  const [acting, setActing] = useState<null | "approve" | "reject">(null);
  const [done, setDone] = useState<null | "approved" | "rejected">(null);
  const [failed, setFailed] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);

  const act = useCallback(
    async (action: "approve" | "reject") => {
      if (decisionId === null) return;
      setActing(action);
      setFailed(false);
      try {
        const res = await apiFetch(`/api/approvals/${decisionId}/${action}`, {
          method: "POST",
        });
        if (!res.ok) {
          setFailed(true);
          return;
        }
        setDone(action === "approve" ? "approved" : "rejected");
        onActed?.();
      } catch {
        setFailed(true);
      } finally {
        setActing(null);
      }
    },
    [decisionId, onActed],
  );

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        isHigh
          ? "border-[#f1c0bc] bg-[#fdf2f1]"
          : "border-[#f0e2c0] bg-[#fdfaf0]"
      }`}
    >
      <div className="text-[13px] font-semibold text-[#1f1f1f]">
        {item.title}
      </div>
      <div className="mt-0.5 text-[12px] text-[#595959]">{item.detail}</div>

      {done ? (
        <div className="mt-1.5 text-[12px] font-medium text-[#2e7d32]">
          {done === "approved" ? "Approved ✓" : "Rejected"}
        </div>
      ) : canInline ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={acting !== null}
            onClick={() => {
              setConfirmReject(false);
              void act("approve");
            }}
            className="flex h-8 cursor-pointer items-center justify-center rounded-cta bg-[#0e0f11] px-3 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {acting === "approve" ? "…" : "Approve"}
          </button>
          {confirmReject ? (
            <button
              type="button"
              disabled={acting !== null}
              onClick={() => void act("reject")}
              className="flex h-8 cursor-pointer items-center justify-center rounded-cta border border-[#f1c0bc] bg-white px-3 text-[12px] font-semibold text-[#c0392b] transition-colors hover:bg-[#fdf2f1] disabled:opacity-50"
            >
              {acting === "reject" ? "…" : "Confirm reject"}
            </button>
          ) : (
            <button
              type="button"
              disabled={acting !== null}
              onClick={() => setConfirmReject(true)}
              className="flex h-8 cursor-pointer items-center justify-center rounded-cta border border-[#e5e7eb] bg-white px-3 text-[12px] font-semibold text-[#1f1f1f] transition-colors hover:bg-[#f7f4ee] disabled:opacity-50"
            >
              Reject
            </button>
          )}
          {failed ? (
            <span className="text-[11px] text-[#c0392b]">
              Couldn&apos;t update. Try again.
            </span>
          ) : null}
        </div>
      ) : deepLink ? (
        <button
          type="button"
          onClick={() => openApprovalsTab(openTab, decisionId)}
          className="mt-2 text-[12px] font-semibold text-[#1f1f1f] hover:underline"
        >
          Open in Needs you <NextChevron />
        </button>
      ) : (
        <div className="mt-1.5 text-[12px] italic text-[#8a8a8a]">
          Ask in chat → “{item.ask}”
        </div>
      )}
    </div>
  );
}

const ATTENTION_VISIBLE = 3;

export function AttentionList({
  items,
  onActed,
}: {
  items: AttentionItem[];
  onActed?: () => void;
}) {
  const { openTab } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const ranked = [...items].sort(
    (a, b) =>
      (a.severity === "high" ? 0 : 1) - (b.severity === "high" ? 0 : 1),
  );
  const visible = expanded ? ranked : ranked.slice(0, ATTENTION_VISIBLE);
  const overflow = ranked.length - visible.length;
  return (
    <section>
      <SectionTitle>Needs your attention</SectionTitle>
      <div className="flex flex-col gap-2">
        {visible.map((a, i) => (
          <AttentionCard key={i} item={a} onActed={onActed} />
        ))}
      </div>
      {overflow > 0 ? (
        (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-2 text-[12px] font-medium text-[#595959] hover:text-[#1f1f1f]"
          >
            Show more
          </button>
        )
      ) : null}
    </section>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-[#d8d2c4] bg-white px-6 py-8 text-center">
      <div className="text-[16px] font-semibold text-[#1f1f1f]">{title}</div>
      {children ? (
        <p className="mx-auto mt-1 max-w-md text-[12px] text-[#595959]">
          {children}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function DashboardMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#e5e7eb] bg-white px-4 py-6 text-center text-[13px] text-[#595959]">
      {children}
    </div>
  );
}

export const STRIPE_GATE_HEADLINE =
  "Connect Stripe to unblock Ads + Growth + Operator payback";
export const STRIPE_LIMITED_AGENTS = 3;

export function StripeGate({ note }: { note?: string }) {
  return (
    <EmptyState title={STRIPE_GATE_HEADLINE}>
      One Stripe connection lights up all three: performance-marketer&apos;s
      real payback/ROAS, growth-lead&apos;s revenue-per-signup cohorts, and the
      operator&apos;s live revenue reads. {STRIPE_LIMITED_AGENTS} agents stay
      limited until it&apos;s connected.{note ? ` ${note}` : ""} Connect under
      Settings → Connections, or ask the agent in chat to walk you through it.
    </EmptyState>
  );
}

export function Pill({
  tone,
  children,
}: {
  tone: "neutral" | "good" | "warn" | "bad";
  children: React.ReactNode;
}) {
  const cls =
    tone === "good"
      ? "bg-[#eaf6ec] text-[#2e7d32]"
      : tone === "warn"
        ? "bg-[#fdfaf0] text-[#9a7b1a]"
        : tone === "bad"
          ? "bg-[#fdf2f1] text-[#c0392b]"
          : "bg-[#f1f0ec] text-[#595959]";
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

export function DashboardShell<T extends { generic?: boolean }>({
  title,
  subtitle,
  agentSlug,
  state,
  genericFallback,
  activeRun,
  getActiveRun,
  running,
  onActiveRunComplete,
  render,
  showRefresh = true,
}: {
  title?: string;
  subtitle?: string;
  showRefresh?: boolean;
  agentSlug?: string;
  state: DashboardState<T>;
  genericFallback: React.ReactNode;
  activeRun?: AgentDashboardActiveRun | null;
  getActiveRun?: (data: T) => AgentDashboardActiveRun | null;
  running?: AgentRunLoadingCopy;
  onActiveRunComplete?: () => void;
  render: (data: T) => React.ReactNode;
}) {
  const { data, loading, refreshing, error, refresh } = state;
  const payloadActiveRun =
    data && !data.generic
      ? (getActiveRun
          ? getActiveRun(data)
          : ((data as { active_run?: AgentDashboardActiveRun | null })
              .active_run ?? null))
      : null;
  const resolvedActiveRun = activeRun ?? payloadActiveRun;
  return (
    <div className="flex flex-col gap-5">
      {title ? (
        <DashboardHeader
          title={title}
          subtitle={subtitle}
          onRefresh={showRefresh ? refresh : undefined}
          refreshing={refreshing}
        />
      ) : null}
      {state.cachedLineAt ? <ChannelCachedLine at={state.cachedLineAt} /> : null}
      {loading ? (
        <div className="rounded-xl border border-[#e5e7eb] bg-white">
          <InlineLoading label={`Loading ${title ? title.toLowerCase() : "dashboard"}…`} />
        </div>
      ) : error ? (
        <DashboardMessage>
          Couldn&apos;t load this dashboard ({error}).{" "}
          <button
            type="button"
            onClick={refresh}
            className="cursor-pointer font-semibold text-[#1f1f1f] underline"
          >
            Retry
          </button>
        </DashboardMessage>
      ) : !data || data.generic ? (
        genericFallback
      ) : resolvedActiveRun ? (
        <AgentRunLoadingScreen
          agentSlug={agentSlug ?? (data as { agent_slug?: string }).agent_slug ?? ""}
          activeRun={resolvedActiveRun}
          title={running?.title ?? `Working on ${title ? title.toLowerCase() : "this"}`}
          subtitle={running?.subtitle}
          steps={running?.steps}
          asideTitle={running?.asideTitle}
          aside={running?.aside}
          onComplete={() => {
            onActiveRunComplete?.();
            refresh();
          }}
        />
      ) : (
        render(data)
      )}
    </div>
  );
}

export const btn = {
  primary: "cursor-pointer rounded-cta border border-ink bg-ink px-3 py-1.5 text-[16px] font-semibold text-cream hover:bg-inkSoft disabled:opacity-50",
  secondary: "inline-flex cursor-pointer items-center gap-2 rounded-cta border border-rule bg-cream px-3 py-1.5 text-[16px] font-semibold text-inkSoft hover:bg-creamDeep disabled:opacity-50",
  done: "inline-flex items-center gap-2 rounded-cta border border-transparent bg-emerald-500/15 px-3 py-1.5 text-[16px] font-semibold text-emerald-600",
};

export const tileClass = "rounded-2xl border border-rule bg-cream px-4 py-3";

export function DashboardControls({
  children,
  className,
  stack = true,
}: {
  children: ReactNode;
  className?: string;
  stack?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2${
        stack ? " compact:w-full compact:min-w-0 compact:flex-wrap compact:justify-start" : ""
      }${className ? ` ${className}` : ""}`}
    >
      {children}
    </div>
  );
}

