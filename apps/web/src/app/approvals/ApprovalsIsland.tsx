"use client";

import { BusinessControlsApprovalCard } from "@/components/workspace/actions/BusinessControlsApprovalCard";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { approveDecision } from "@/lib/approvals/approveDecision";
import { datetimeLocalToFutureIso, toDatetimeLocal } from "@/lib/datetimeLocal";
import { FeedbackInline } from "@/components/feedback/FeedbackInline";
import { Markdown } from "@/components/workspace/Markdown";
import { ProposalSummary } from "@/components/agents/ProposalCard";
import {
  ProposalDiff,
  parseProposalChanges,
} from "@/components/agents/ProposalDiff";
import {
  agentLabelForSlug,
  decisionTitle,
  handlerPreview,
  isHighStakesDecision,
  isAcknowledgeOnly,
  daysOpen,
  approveExtrasFor,
  outcomeUnknownRows,
  needsFullCard,
} from "./approvalsHelpers";
import { PendingQueueSkeleton } from "./ApprovalsSkeletons";
import { decisionConsequence } from "./decisionCopy";
import { expectedScheduledAtFor, loadedScheduleGuard, refineTarget, scheduleMovedNotice } from "./approvalsHelpers";
import { PostPreview } from "@/components/workspace/PostPreview";
import { followPostInToast } from "@/components/workspace/actions/topActions/postToast";
import { useWorkspaceOptional } from "@/components/workspace/WorkspaceShell";
import { createBrowserSupabase } from "@/lib/supabase";
import { getActiveTenantId } from "@/lib/active-tenant-client";

import type { Decision } from "./approvalDecision";

const REFINE_SEED_KEY = "praxis:refine-seed:";

function buildRefineSeed(d: Decision): string {
  const { verbLabel } = decisionTitle(d.decision_class, d.body);
  const preview = handlerPreview(d.handler, d.body);
  const label = (preview || verbLabel || d.decision_class).replace(/^[\s→·–—-]+/, "");
  return `Let's revise your proposed action: ${label}. I'd change: `;
}

type BrainCitation = { note_id: string; title: string };
function parseBrainCitations(body: unknown): BrainCitation[] {
  const c = (body as { brain_citations?: unknown })?.brain_citations;
  if (!Array.isArray(c)) return [];
  return c.filter(
    (x): x is BrainCitation =>
      !!x &&
      typeof (x as BrainCitation).note_id === "string" &&
      typeof (x as BrainCitation).title === "string",
  );
}

const UNWIRED_HANDLERS = new Set<string>([
  "gmail.send",
  "stripe.refund",
]);

function isUnwired(handler: string | null): boolean {
  return !!handler && UNWIRED_HANDLERS.has(handler);
}

function isFounderTask(body: Record<string, unknown>): boolean {
  return (body as { surface_kind?: unknown })?.surface_kind === "founder_task";
}

function renderedMarkdownOf(body: Record<string, unknown>): string | null {
  const rm = (body as { rendered_markdown?: unknown })?.rendered_markdown;
  return typeof rm === "string" && rm.trim().length > 0 ? rm : null;
}

function isAdsDecisionClass(cls: string): boolean {
  return cls.startsWith("meta_ads.") || cls.startsWith("google_ads.");
}
type AdsAutopilotPlatform = "meta_ads" | "google_ads";
function adsPlatformOf(cls: string): AdsAutopilotPlatform | null {
  if (cls.startsWith("meta_ads.")) return "meta_ads";
  if (cls.startsWith("google_ads.")) return "google_ads";
  return null;
}

function AdsAutopilotPanel({
  platform,
  busy,
  onEnable,
}: {
  platform: AdsAutopilotPlatform;
  busy: boolean;
  onEnable: (maxDailyBudgetUsd: number) => Promise<string | null>;
}) {
  const [budget, setBudget] = useState<string>("50");
  const [err, setErr] = useState<string | null>(null);
  const platformLabel = platform === "meta_ads" ? "Meta" : "Google";
  const parsed = Number(budget);
  const valid = Number.isFinite(parsed) && parsed > 0;

  return (
    <div className="mt-3 rounded-lg border border-ink/10 bg-bone/60 p-3">
      <div className="text-[12px] font-semibold text-ink mb-2">
        {platformLabel} ads autopilot
      </div>
      <ul className="space-y-1.5 text-[12px] text-ink">
        <li className="flex items-center gap-2 flex-wrap">
          <span className="text-inkMuted">Budget changes up to</span>
          <span className="inline-flex items-center rounded-md border border-ink/15 bg-white px-1.5">
            <span className="text-inkMuted text-[12px]">$</span>
            <input
              type="number"
              min={1}
              inputMode="decimal"
              value={budget}
              onChange={(e) => {
                setBudget(e.target.value);
                setErr(null);
              }}
              disabled={busy}
              aria-label="Daily budget cap in dollars"
              className="w-16 bg-transparent px-1 py-0.5 text-[12px] text-ink outline-none disabled:opacity-50"
            />
          </span>
          <span className="text-inkMuted">/day, included</span>
        </li>
        <li className="text-inkMuted">Pause underperformers: included</li>
        <li className="text-inkMuted">Resume / restart: always asks</li>
      </ul>
      {err && <div className="mt-2 text-[11px] text-rose-700">{err}</div>}
      <button
        onClick={async () => {
          if (!valid) {
            setErr("Enter a positive daily budget.");
            return;
          }
          setErr(null);
          const e = await onEnable(parsed);
          if (e) setErr(e);
        }}
        disabled={busy || !valid}
        className="mt-2 inline-flex items-center rounded-cta bg-ink text-white px-3 py-1.5 text-[12px] font-medium hover:bg-inkSoft shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? "…" : `Enable ads autopilot up to $${valid ? parsed : budget}`}
      </button>
    </div>
  );
}

export function SocialSchedulePanel({
  initial,
  busy,
  notice,
  onApproveAt,
}: {
  initial: string | null;
  busy: boolean;
  notice?: string | null;
  onApproveAt: (iso: string | null, expected?: string | null) => void;
}) {
  const [value, setValue] = useState<string>(() => {
    if (!initial) return "";
    const d = new Date(initial);
    return Number.isNaN(d.getTime()) ? "" : toDatetimeLocal(d);
  });
  const [picked, setPicked] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="mt-3 rounded-lg border border-ink/10 bg-bone/60 p-3">
      <div className="text-[12px] font-semibold text-ink mb-2">Schedule</div>
      {notice && <div className="mb-2 text-[12px] text-amber-800">{notice}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="datetime-local"
          value={value}
          min={toDatetimeLocal(new Date())}
          onChange={(e) => {
            setValue(e.target.value);
            setPicked(true);
            setErr(null);
          }}
          disabled={busy}
          aria-label="Publish at"
          className="rounded-md border border-ink/15 bg-white px-2 py-1 text-[12px] text-ink outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => {
            if (!value.trim()) {
              setErr("Pick a time, or use Approve to publish now.");
              return;
            }
            const parsed = datetimeLocalToFutureIso(value);
            if ("error" in parsed) {
              setErr(parsed.error);
              return;
            }
            setErr(null);
            onApproveAt(parsed.iso, expectedScheduledAtFor(picked, initial));
          }}
          disabled={busy}
          className="inline-flex items-center rounded-cta bg-ink text-white px-3 py-1.5 text-[12px] font-medium hover:bg-inkSoft shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "…" : "Approve at this time"}
        </button>
        {initial && (
          <button
            type="button"
            onClick={() => onApproveAt(null)}
            disabled={busy}
            className="text-[12px] text-inkMuted underline disabled:opacity-50"
          >
            Approve &amp; publish now instead
          </button>
        )}
      </div>
      {err && <div className="mt-2 text-[11px] text-rose-700">{err}</div>}
    </div>
  );
}

export function ApprovalsIsland({
  isActive,
  selectedDecisionId,
}: {
  isActive?: boolean;
  selectedDecisionId?: string;
} = {}) {
  const router = useRouter();
  const workspaceTenantId = useWorkspaceOptional()?.tenantId;
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [failed, setFailed] = useState<Decision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [movedNotice, setMovedNotice] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, { text: string; thread?: string[] }>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [allowlistedClass, setAllowlistedClass] = useState<string | null>(null);

  async function copyDrafts(id: string, md: string) {
    try {
      await navigator.clipboard?.writeText(md);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
    }
  }

  async function load() {
    try {
      const [res, failedRes, dispatchingRes] = await Promise.all([
        apiFetch("/api/approvals"),
        apiFetch("/api/approvals?status=dispatch_failed"),
        apiFetch("/api/approvals?status=dispatching"),
      ]);
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = r?.error?.message ?? `HTTP ${res.status}`;
        throw new Error(message);
      }
      setDecisions((r.decisions ?? []) as Decision[]);
      const failedRows: Decision[] = [];
      if (failedRes.ok) {
        const fr = await failedRes.json().catch(() => ({}));
        failedRows.push(...((fr.decisions ?? []) as Decision[]));
      }
      if (dispatchingRes.ok) {
        const dr = await dispatchingRes.json().catch(() => ({}));
        failedRows.push(...outcomeUnknownRows((dr.decisions ?? []) as Decision[]));
      }
      setFailed(failedRows);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  useEffect(() => {
    void load();
    function onVisibility() {
      if (!document.hidden) void load();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const didMountRef = useRef(false);
  useEffect(() => {
    if (isActive === undefined) return;
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (isActive) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  async function decide(
    id: string,
    action: "approve" | "reject",
    opts?: {
      alwaysAllow?: boolean;
      decisionClass?: string;
      scheduledAt?: string | null;
      expectedScheduledAt?: string | null;
    },
  ) {
    const target = decisions.find((decision) => decision.id === id);
    const isPinterest =
      target?.decision_class === "social.publish.v2" && target.body?.channel === "pinterest_pin";
    const followPinterest = async () => {
      const tenantId = workspaceTenantId ?? (await getActiveTenantId(createBrowserSupabase()).catch(() => null));
      return followPostInToast(id, "Pinterest", undefined, tenantId);
    };
    setBusy(id);
    try {
      const res =
        action === "approve"
          ? await approveDecision(id, {
              ...(target ? approveExtrasFor(target) : {}),
              ...(opts?.alwaysAllow ? { always_allow: true } : {}),
              ...(opts?.scheduledAt !== undefined ? { scheduled_at: opts.scheduledAt } : {}),
              ...(opts?.expectedScheduledAt !== undefined ? { expected_scheduled_at: opts.expectedScheduledAt } : {}),
              ...(edits[id]
                ? { payload_text: edits[id].text, thread: edits[id].thread?.length ? edits[id].thread : null }
                : {}),
            })
          : await apiFetch(`/api/approvals/${id}/reject`, { method: "POST" });
      if (!res) return;
      const r = await res.json().catch(() => ({}));
      if (res.status === 409 && r?.error?.code === "schedule_changed") {
        const current = typeof r.error.current_scheduled_at === "string" ? r.error.current_scheduled_at : null;
        setDecisions((list) =>
          list.map((x) => (x.id === id ? { ...x, body: { ...(x.body ?? {}), scheduled_at: current } } : x)),
        );
        setMovedNotice((m) => ({ ...m, [id]: scheduleMovedNotice(current) }));
        return;
      }
      if (!res.ok) {
        const message = r?.error?.message ?? `HTTP ${res.status}`;
        if (action === "approve" && isPinterest && res.status < 500) {
          setError(message);
          return;
        }
        throw new Error(message);
      }
      setDecisions((d) => d.filter((x) => x.id !== id));
      if (action === "approve" && isPinterest) {
        void followPinterest().then((out) => {
          if (out.state === "approval_uncertain") void load();
        });
      }
      if (opts?.alwaysAllow && r?.allowlisted === true && opts.decisionClass) {
        setAllowlistedClass(opts.decisionClass);
        window.setTimeout(
          () => setAllowlistedClass((c) => (c === opts.decisionClass ? null : c)),
          4000,
        );
      }
    } catch (e) {
      if (action === "approve" && isPinterest) {
        setDecisions((d) => d.filter((x) => x.id !== id));
        setError("Could not confirm the Pinterest approval. Zavi is checking the original pin; do not post it again yet.");
        void followPinterest().then((out) => {
          if (out.state === "approval_uncertain") void load();
        });
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(null);
    }
  }

  async function enableAdsAutopilot(
    d: Decision,
    platform: AdsAutopilotPlatform,
    maxDailyBudgetUsd: number,
  ): Promise<string | null> {
    setBusy(d.id);
    try {
      const res = await apiFetch("/api/approvals/ads-autopilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          enabled: true,
          max_daily_budget_usd: maxDailyBudgetUsd,
        }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) {
        return r?.error?.message ?? `HTTP ${res.status}`;
      }
      const ar = await apiFetch(`/api/approvals/${d.id}/approve`, { method: "POST" });
      const arJson = await ar.json().catch(() => ({}));
      if (!ar.ok) {
        return arJson?.error?.message ?? `Approve failed (HTTP ${ar.status})`;
      }
      setDecisions((list) => list.filter((x) => x.id !== d.id));
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      setBusy(null);
    }
  }

  async function refine(d: Decision) {
    if (!d.agent_slug) return;
    setBusy(d.id);
    try {
      const res = await apiFetch(`/api/approvals/${d.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ refine: true }),
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
      setDecisions((list) => list.filter((x) => x.id !== d.id));
      const target = refineTarget(d.channel_slug ?? d.agent_slug);
      try {
        sessionStorage.setItem(REFINE_SEED_KEY + target.agent, target.seedPrefix + buildRefineSeed(d));
      } catch {
      }
      router.push(
        d.thread_id
          ? `/workspace/${encodeURIComponent(d.thread_id)}`
          : target.agent === "operator"
            ? "/workspace"
            : `/workspace?agent=${encodeURIComponent(target.agent)}`,
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  const orderedDecisions = useMemo(() => {
    const high: Decision[] = [];
    const rest: Decision[] = [];
    for (const d of decisions) {
      (isHighStakesDecision(d.decision_class, d.handler, d.body)
        ? high
        : rest
      ).push(d);
    }
    return [...high, ...rest];
  }, [decisions]);

  useEffect(() => {
    if (!selectedDecisionId || !loaded || decisions.length === 0) return;
    const el = document.getElementById(`approval-${selectedDecisionId}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selectedDecisionId, loaded, decisions]);

  const header = (
    <div className="flex items-center justify-between gap-2 mb-2">
      <div className="text-[11px] font-mono text-inkMuted">
        {decisions.length > 0
          ? `${decisions.length} pending`
          : loaded
            ? "Queue empty"
            : "Loading…"}
      </div>
      <button
        onClick={() => void refresh()}
        disabled={refreshing}
        className="inline-flex items-center rounded-cta border border-ink/10 bg-white px-2.5 py-1 text-[12px] font-medium text-ink hover:border-ink/30 hover:bg-bone disabled:opacity-50"
      >
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );

  const errorBanner = error ? (
    <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-800">
      {error}
    </div>
  ) : null;

  if (!loaded && decisions.length === 0) {
    return (
      <div>
        {errorBanner}
        <PendingQueueSkeleton />
      </div>
    );
  }

  if (decisions.length === 0) {
    return (
      <div>
        {header}
        {errorBanner}
        <div className="rounded-xl border border-dashed border-ink/15 bg-white/60 p-4 mb-3 opacity-70 select-none shadow-[0_1px_2px_rgba(25,25,25,0.04)]">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <div className="font-mono text-[13px] font-semibold text-ink">
                dispute_decision · sample
              </div>
              <div className="text-[12px] text-inkMuted font-mono mt-0.5">
                support-lead · 4h ago · autonomy = approval
              </div>
            </div>
            <span className="shrink-0 inline-flex items-center rounded-full border border-ink/10 bg-white px-2 py-0.5 text-[11px] font-mono uppercase tracking-[0.14em] text-inkMuted">
              proposed
            </span>
          </div>
          <div className="text-[13px] text-inkMuted leading-[1.5]">
            Refund $48.50 to guest · charge ch_3R…7AbC ·{" "}
            <span className="text-inkMuted">2 agents agreed.</span>
          </div>
          <div className="mt-3 flex gap-2">
            {}
            <span
              className="inline-flex items-center rounded-md border border-dashed border-ink/15 bg-bone px-3 py-1 text-[12px] italic text-inkMuted cursor-not-allowed"
              title="Sample row. Real decisions arrive here when an agent files one."
              aria-disabled="true"
            >
              Approve (sample)
            </span>
            <span
              className="inline-flex items-center rounded-md border border-dashed border-ink/15 bg-bone px-3 py-1 text-[12px] italic text-inkMuted cursor-not-allowed"
              title="Sample row. Real decisions arrive here when an agent files one."
              aria-disabled="true"
            >
              Reject (sample)
            </span>
          </div>
        </div>
        <p className="text-[12px] text-inkMuted text-center leading-[1.55] max-w-md mx-auto">
          Sample row: this is what your queue looks like when an agent files
          a side-effect that needs your nod. Auto-classes fire on their own;
          forbidden classes never reach the list.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {header}
      {errorBanner}
      {allowlistedClass && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
          Won&apos;t ask again for this kind ({allowlistedClass}). You can change
          it back in Autopilot settings.
        </div>
      )}
      {failed.length > 0 ? (
        <section
          aria-label="Approved but failed to run"
          className="mb-4 rounded-xl border border-[#e9b7b0] bg-[#fdf6f5] p-4"
        >
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="font-mono text-[13px] font-semibold text-ink">
              Approved, then failed to run
            </h2>
            <span className="font-mono text-[11px] text-inkMuted">
              {failed.length}
            </span>
          </div>
          <p className="mb-3 text-[12px] leading-[1.5] text-inkMuted">
            You approved these and the system could not carry them out. Nothing
            was done. Each one shows why.
          </p>
          <ul className="flex flex-col gap-2">
            {failed.map((d) => {
              const { agentLabel, verbLabel } = decisionTitle(d.decision_class, d.body);
              return (
                <li
                  key={d.id}
                  id={`approval-${d.id}`}
                  className="rounded-lg border border-[#e9b7b0]/70 bg-white p-3"
                >
                  <div className="font-mono text-[13px] font-semibold text-ink">
                    {agentLabel} · {verbLabel}
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-inkMuted">
                    {(() => {
                      const days = daysOpen(d.approved_at ?? d.emitted_at);
                      return days <= 0 ? "approved today" : `approved ${days}d ago`;
                    })()}
                  </div>
                  {}
                  {d.status === "dispatch_failed" && d.failure_fix?.trim() ? (
                    <p className="mt-2 text-[13px] leading-[1.45] text-ink">{d.failure_fix}</p>
                  ) : null}
                  <div className="mt-2 rounded border border-ink/10 bg-[#fbf9f8] px-2 py-1.5 font-mono text-[12px] leading-[1.45] text-ink">
                    {needsFullCard(d.handler) && d.status === "dispatching"
                      ? `Outcome unknown. Check ${
                          typeof d.body?.app_name === "string" && d.body.app_name.trim()
                            ? d.body.app_name
                            : "the app"
                        } before trying again.`
                      : d.dispatch_error?.trim()
                        ? d.dispatch_error
                        : "No reason was recorded for this failure."}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {orderedDecisions.map((d) => {
        if (d.decision_class === "growth.save_business_controls") return <BusinessControlsApprovalCard key={d.id} decisionId={d.id} onResolved={() => setDecisions((list) => list.filter((item) => item.id !== d.id))} />;
        const unwired = isUnwired(d.handler);
        const founderTask = isFounderTask(d.body);
        const ackOnly = isAcknowledgeOnly(d.handler, d.body);
        const adsPlatform = isAdsDecisionClass(d.decision_class)
          ? adsPlatformOf(d.decision_class)
          : null;
        const highStakes = isHighStakesDecision(
          d.decision_class,
          d.handler,
          d.body,
        );
        const openDays = daysOpen(d.emitted_at);
        const selected = selectedDecisionId === d.id;
        return (
          <div
            id={`approval-${d.id}`}
            key={d.id}
            aria-current={selected ? "true" : undefined}
            className={`rounded-xl border p-4 shadow-[0_1px_2px_rgba(25,25,25,0.04),0_6px_18px_rgba(25,25,25,0.05)] ${
              selected
                ? "border-ink/35 bg-white ring-2 ring-ink/10"
                : unwired
                  ? "border-[#f0dca6] bg-[#fffaf0]"
                  : "border-ink/[0.08] bg-white"
            }`}
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                {(() => {
                  const { agentLabel, verbLabel } = decisionTitle(
                    d.decision_class,
                    d.body,
                  );
                  return (
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-[16px] font-semibold text-ink">
                        {agentLabel}
                        {verbLabel ? (
                          <span className="text-inkMuted"> · {verbLabel}</span>
                        ) : null}
                      </h3>
                      {unwired && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-[#fbeccb] px-2 py-0.5 text-[11px] font-mono uppercase tracking-[0.14em] text-[#8a5a10]"
                          title={`The ${d.handler ?? "selected"} dispatcher isn't wired in this Zavi version. Approving would silently no-op (pre-launch demo only).`}
                        >
                          <span aria-hidden>◆</span> not wired yet
                        </span>
                      )}
                    </div>
                  );
                })()}
                <div className="font-mono text-[11px] text-inkMuted mt-0.5">
                  {d.decision_class}
                </div>
                {(() => {
                  const preview = handlerPreview(d.handler, d.body);
                  if (!preview) return null;
                  return (
                    <div className="font-mono text-[12px] text-inkMuted mt-1">
                      {preview}
                    </div>
                  );
                })()}
                {unwired && (
                  <div className="text-[11px] text-[#8a5a10] mt-1">
                    Approving is disabled: the {d.handler ?? "selected"}{" "}
                    dispatcher isn&apos;t wired in this Zavi version yet.
                  </div>
                )}
                {(() => {
                  const brainCitations = parseBrainCitations(d.body);
                  if (brainCitations.length === 0) return null;
                  return (
                    <div className="flex items-center gap-2 flex-wrap mt-1">
                      <span className="text-[11px] font-mono text-inkMuted">From brain:</span>
                      {brainCitations.map((c) => (
                        <a
                          key={c.note_id}
                          href={`/memory/${c.note_id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={c.title}
                          className="inline-flex items-center max-w-[200px] truncate rounded-full border border-ink/15 bg-bone px-2 py-0.5 text-[11px] font-mono text-ink hover:bg-creamDeep"
                        >
                          {c.title}
                        </a>
                      ))}
                    </div>
                  );
                })()}
                <div className="flex items-center gap-2 flex-wrap mt-1">
                  <span className="text-[11px] font-mono text-inkMuted">
                    proposed {new Date(d.emitted_at).toLocaleTimeString()}
                  </span>
                  {highStakes && openDays >= 1 && (
                    <span
                      className="inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-mono font-medium text-rose-700 ring-1 ring-rose-200"
                      title={`This money/security action has been awaiting your approval for ${openDays} day${openDays === 1 ? "" : "s"}.`}
                    >
                      open {openDays}d
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {founderTask ? (
                  <>
                    {renderedMarkdownOf(d.body) && (
                      <button
                        onClick={() => {
                          const md = renderedMarkdownOf(d.body);
                          if (md) void copyDrafts(d.id, md);
                        }}
                        title="Copy the drafts to your clipboard"
                        className="inline-flex items-center rounded-cta border border-ink/10 bg-white px-3 py-1.5 text-[12px] font-medium text-ink hover:border-ink/30 hover:bg-bone"
                      >
                        {copiedId === d.id ? "Copied" : "Copy"}
                      </button>
                    )}
                    <button
                      onClick={() => decide(d.id, "approve")}
                      disabled={busy === d.id}
                      title="I've handled this, clear it from the queue"
                      className="inline-flex items-center rounded-cta border border-transparent bg-ink text-white px-4 py-1.5 text-[12px] font-medium hover:bg-inkSoft shadow-sm disabled:opacity-50"
                    >
                      {busy === d.id ? "…" : "Mark done"}
                    </button>
                  </>
                ) : (
                  <>
                    {d.agent_slug && (
                      <button
                        onClick={() => refine(d)}
                        disabled={busy === d.id}
                        title={`Reject this proposal and ask ${d.agent_slug} to revise it in chat`}
                        className="inline-flex items-center rounded-cta border border-ink/10 bg-white px-3 py-1.5 text-[12px] font-medium text-ink hover:border-ink/30 hover:bg-bone disabled:opacity-50"
                      >
                        Refine…
                      </button>
                    )}
                    <button
                      onClick={() => decide(d.id, "reject")}
                      disabled={busy === d.id}
                      className="inline-flex items-center rounded-cta border border-ink/10 bg-white px-3 py-1.5 text-[12px] font-medium text-ink hover:border-rose-300 hover:text-rose-700 disabled:opacity-50"
                    >
                      Reject
                    </button>
                    {d.click_allowlistable && (
                      <button
                        onClick={() =>
                          decide(d.id, "approve", {
                            alwaysAllow: true,
                            decisionClass: d.decision_class,
                            ...loadedScheduleGuard(d),
                          })
                        }
                        disabled={busy === d.id || unwired}
                        title="Approve this, and stop asking for this kind of action (you can change it back in Autopilot settings)"
                        className="inline-flex items-center rounded-cta border border-ink/15 bg-white px-3 py-1.5 text-[12px] font-medium text-ink hover:border-ink/30 hover:bg-bone disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {busy === d.id ? "…" : "Approve & always allow this kind"}
                      </button>
                    )}
                    <button
                      onClick={() => decide(d.id, "approve", loadedScheduleGuard(d))}
                      disabled={busy === d.id || unwired}
                      title={unwired ? "Dispatch handler isn't wired, so Approve is disabled" : undefined}
                      className="inline-flex items-center rounded-cta border border-transparent bg-ink text-white px-4 py-1.5 text-[12px] font-medium hover:bg-inkSoft shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {busy === d.id ? "…" : ackOnly ? "Acknowledge" : "Approve"}
                    </button>
                  </>
                )}
              </div>
            </div>
            {!founderTask && (() => {
              const c = decisionConsequence(d.handler, d.decision_class, d.body);
              return (
                <dl className="mb-2 grid grid-cols-[max-content_1fr] gap-x-2.5 gap-y-0.5 text-[12px]">
                  <dt className="font-medium text-emerald-700">If approved</dt>
                  <dd className="min-w-0 text-inkMuted">{c.approve}</dd>
                  <dt className="font-medium text-rose-700">If rejected</dt>
                  <dd className="min-w-0 text-inkMuted">{c.reject}</dd>
                </dl>
              );
            })()}
            <DecisionBody
              decisionClass={d.decision_class}
              handler={d.handler}
              body={
                edits[d.id] && d.body?.payload && typeof d.body.payload === "object"
                  ? { ...d.body, payload: { ...(d.body.payload as Record<string, unknown>), ...edits[d.id] } }
                  : d.body
              }
              onEditPost={
                founderTask ? undefined : (next) => setEdits((e) => ({ ...e, [d.id]: next }))
              }
            />
            {adsPlatform && !founderTask && (
              <AdsAutopilotPanel
                platform={adsPlatform}
                busy={busy === d.id}
                onEnable={(maxDailyBudgetUsd) =>
                  enableAdsAutopilot(d, adsPlatform, maxDailyBudgetUsd)
                }
              />
            )}
            {d.decision_class === "social.publish.v2" && !founderTask && (
              <SocialSchedulePanel
                key={`${d.id}:${typeof d.body?.scheduled_at === "string" ? d.body.scheduled_at : ""}`}
                initial={typeof d.body?.scheduled_at === "string" ? d.body.scheduled_at : null}
                busy={busy === d.id}
                notice={movedNotice[d.id] ?? null}
                onApproveAt={(iso, expected) =>
                  void decide(d.id, "approve", {
                    scheduledAt: iso,
                    ...(expected !== undefined ? { expectedScheduledAt: expected } : {}),
                  })
                }
              />
            )}
            <div className="mt-3 border-t border-ink/10 pt-3">
              <FeedbackInline
                targetType="decision"
                targetId={d.id}
                agentSlug={d.decision_class.split(".")[0] ?? "unknown"}
                compact
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const BLAST_TONE: Record<string, string> = {
  GREEN: "bg-green-100 text-green-800",
  YELLOW: "bg-yellow-100 text-yellow-800",
  ORANGE: "bg-orange-100 text-orange-800",
  RED: "bg-red-100 text-red-800",
};
function DecisionEvidencePanel({ body }: { body: Record<string, unknown> }) {
  const ev = body?.decision_evidence;
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null;
  const e = ev as Record<string, unknown>;
  const reason = typeof e.reason_text === "string" ? e.reason_text : "";
  if (!reason) return null;
  const evidence = Array.isArray(e.evidence) ? (e.evidence as unknown[]).filter((x) => typeof x === "string") : [];
  const alts = Array.isArray(e.alternatives_considered)
    ? (e.alternatives_considered as unknown[]).filter((x) => typeof x === "string")
    : [];
  const reversibility = typeof e.reversibility === "string" ? e.reversibility : null;
  const blast = typeof e.blast_radius === "string" ? e.blast_radius : null;
  const confidence = typeof e.confidence === "number" ? e.confidence : null;
  return (
    <div className="mt-2 rounded-md border border-line bg-bone p-3 text-[12px] text-ink leading-[1.5]">
      <div className="font-medium">{reason}</div>
      <div className="mt-1 flex flex-wrap gap-2">
        {blast && (
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${BLAST_TONE[blast] ?? "bg-bone text-ink"}`}>
            blast: {blast}
          </span>
        )}
        {reversibility && (
          <span className="rounded bg-bone px-1.5 py-0.5 text-[11px] text-ink border border-line">
            {reversibility.replace(/_/g, " ")}
          </span>
        )}
        {confidence !== null && (
          <span className="rounded bg-bone px-1.5 py-0.5 text-[11px] text-ink border border-line">
            confidence {Math.round(confidence * 100)}%
          </span>
        )}
      </div>
      {evidence.length > 0 && (
        <ul className="mt-1.5 list-disc pl-4 text-[12px]">
          {evidence.map((s, i) => <li key={i}>{s as string}</li>)}
        </ul>
      )}
      {alts.length > 0 && (
        <div className="mt-1.5 text-[12px] text-stone">
          <span className="font-medium">Alternatives considered:</span> {alts.join("; ")}
        </div>
      )}
    </div>
  );
}

export function DecisionBody({
  decisionClass,
  handler,
  body,
  onEditPost,
}: {
  decisionClass: string;
  handler: string | null;
  body: Record<string, unknown>;
  onEditPost?: (next: { text: string; thread?: string[] }) => void;
}) {
  const safeBody: Record<string, unknown> =
    body && typeof body === "object" && !Array.isArray(body) ? body : {};
  return (
    <>
      <DecisionEvidencePanel body={safeBody} />
      <DecisionBodyInner
        decisionClass={decisionClass}
        handler={handler}
        body={safeBody}
        onEditPost={onEditPost}
      />
    </>
  );
}

function DecisionBodyInner({
  decisionClass,
  handler,
  body: safeBody,
  onEditPost,
}: {
  decisionClass: string;
  handler: string | null;
  body: Record<string, unknown>;
  onEditPost?: (next: { text: string; thread?: string[] }) => void;
}) {
  if (decisionClass === "engineer.ship-pr") {
    return <PrProposalRenderer body={safeBody} />;
  }
  if (
    decisionClass === "social.publish.v2" &&
    typeof safeBody.channel === "string" &&
    safeBody.payload &&
    typeof safeBody.payload === "object" &&
    !Array.isArray(safeBody.payload)
  ) {
    return (
      <PostPreview
        channel={safeBody.channel}
        payload={safeBody.payload as Record<string, unknown>}
        scheduledAt={safeBody.scheduled_at}
        onEdit={onEditPost}
        readiness={safeBody.readiness}
      />
    );
  }
  if (handler === "praxis.dispatch_specialist" && typeof safeBody.intent === "string") {
    return <DispatchProposalRenderer body={safeBody} />;
  }
  if (needsFullCard(handler) && safeBody.kind === "composio_write") {
    return (
      <div className="mt-2">
        <ProposalSummary decisionClass={decisionClass} handler={handler} body={safeBody} />
      </div>
    );
  }
  const rendered = safeBody.rendered_markdown;
  const hasMarkdown =
    typeof rendered === "string" && rendered.trim().length > 0;
  if (hasMarkdown) {
    const inlineChanges = parseProposalChanges(safeBody.changes);
    return (
      <div className="mt-2">
        {inlineChanges.length > 0 ? (
          <div className="mb-2">
            <ProposalDiff changes={inlineChanges} />
          </div>
        ) : null}
        {}
        <div className="max-h-96 overflow-auto rounded-md">
          <Markdown source={rendered as string} disableActionLinks />
        </div>
      </div>
    );
  }
  if (typeof safeBody.rationale === "string" && safeBody.rationale.trim()) {
    return (
      <div className="mt-2">
        <ProposalSummary
          decisionClass={decisionClass}
          handler={handler}
          body={safeBody}
          showAction={false}
        />
      </div>
    );
  }
  return (
    <pre className="mt-2 rounded-md bg-bone p-3 text-[12px] text-ink leading-[1.5] overflow-auto max-h-48">
      {JSON.stringify(safeBody, null, 2)}
    </pre>
  );
}

function DispatchProposalRenderer({ body }: { body: Record<string, unknown> }) {
  const intent = typeof body.intent === "string" ? body.intent.trim() : "";
  const draft = typeof body.draft === "string" ? body.draft.trim() : "";
  const targetLabel = agentLabelForSlug(body.target_agent_slug);
  const hint =
    body.on_goal_hint && typeof body.on_goal_hint === "object"
      ? (body.on_goal_hint as { relevant?: unknown; note?: unknown })
      : null;
  const onGoalNote =
    hint?.relevant === true && typeof hint.note === "string" && hint.note.trim()
      ? hint.note.trim()
      : null;

  return (
    <div className="mt-2 space-y-2">
      <div className="text-[13px] text-ink/60">
        Goes to <span className="font-medium text-ink">{targetLabel}</span>
      </div>
      {}
      <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[13px] leading-5 text-ink">
        {intent}
      </p>
      {draft ? (
        <div className="max-h-96 overflow-auto rounded-md border border-ink/10 p-2">
          <div className="mb-1 text-[12px] font-medium uppercase tracking-wide text-ink/50">
            Draft to ship
          </div>
          <Markdown source={draft} disableActionLinks />
        </div>
      ) : null}
      {onGoalNote ? (
        <div className="text-[13px] text-ink/60">{onGoalNote}</div>
      ) : null}
    </div>
  );
}

type PrProposalShape = {
  repo?: string;
  base_branch?: string;
  head_branch?: string;
  title?: string;
  body?: string;
  files?: Array<{ path?: string; action?: string; diff?: string }>;
  test_results?: { passed?: number; failed?: number; output_tail?: string };
  risk_class?: string;
};

function PrProposalRenderer({ body }: { body: Record<string, unknown> }) {
  const p = body as PrProposalShape;
  const files = p.files ?? [];
  const totalLines = files.reduce((acc, f) => {
    const diff = f.diff ?? "";
    let added = 0;
    let deleted = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) deleted += 1;
    }
    return acc + added + deleted;
  }, 0);
  return (
    <div className="mt-2 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="rounded-md bg-bone px-2 py-0.5 font-mono text-ink">{p.repo ?? "-"}</span>
        <span className="font-mono text-inkMuted">
          {p.base_branch ?? "?"} ← {p.head_branch ?? "?"}
        </span>
        {p.risk_class && (
          <span
            className={`rounded-md px-2 py-0.5 font-mono uppercase tracking-[0.1em] ${
              p.risk_class === "trivial"
                ? "bg-emerald-50 text-emerald-700"
                : p.risk_class === "low"
                  ? "bg-bone text-ink"
                  : "bg-amber-50 text-amber-700"
            }`}
          >
            risk:{p.risk_class}
          </span>
        )}
        <span className="font-mono text-inkMuted">
          {files.length} file{files.length === 1 ? "" : "s"} · {totalLines} lines
        </span>
      </div>
      {p.title && <div className="text-[16px] font-semibold text-ink">{p.title}</div>}
      {p.body && <p className="text-[13px] text-inkMuted leading-[1.6] whitespace-pre-wrap">{p.body}</p>}
      <div className="space-y-2">
        {files.map((f, i) => (
          <div key={i} className="rounded-md border border-ink/10 bg-white">
            <div className="border-b border-ink/10 px-3 py-1.5 text-[12px] font-mono">
              <span
                className={`mr-2 rounded px-1.5 py-0.5 ${
                  f.action === "create"
                    ? "bg-emerald-50 text-emerald-700"
                    : f.action === "delete"
                      ? "bg-rose-50 text-rose-700"
                      : "bg-bone text-ink"
                }`}
              >
                {f.action ?? "modify"}
              </span>
              <span className="text-ink">{f.path ?? ""}</span>
            </div>
            <pre className="px-3 py-2 text-[11px] text-ink leading-[1.5] overflow-auto max-h-72 whitespace-pre">
              {(f.diff ?? "").split("\n").slice(0, 200).join("\n")}
              {(f.diff ?? "").split("\n").length > 200 ? "\n... [truncated for display]" : ""}
            </pre>
          </div>
        ))}
      </div>
      {p.test_results && (p.test_results.passed || p.test_results.failed) ? (
        <div className="rounded-md bg-bone px-3 py-2 text-[12px] font-mono">
          tests: {p.test_results.passed ?? 0} passed · {p.test_results.failed ?? 0} failed
        </div>
      ) : null}
    </div>
  );
}

