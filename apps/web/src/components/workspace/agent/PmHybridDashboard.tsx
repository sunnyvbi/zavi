"use client";

import { useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useWorkspace } from "@/components/workspace/WorkspaceShell";
import {
  useAgentDashboard,
  DashboardShell,
  SectionTitle,
  EmptyState,
  Pill,
  ago,
} from "./dashboard-ui";

type RoadmapStatus = "proposed" | "in_flight" | "shipped" | "measured";
type RoadmapOutcome = "won" | "recurred" | null;
type DispatchStage =
  | "dispatched"
  | "engineer_done"
  | "pr_open"
  | "merged"
  | "closed_unmerged"
  | "failed_to_open";

type HybridRow = {
  id: string;
  theme: string;
  status: RoadmapStatus;
  outcome: RoadmapOutcome;
  child_run_id: string | null;
  child_status: string | null;
  updated_at: string | null;
  dispatch_stage: DispatchStage;
  pr_url: string | null;
  pr_state: string | null;
  days_stuck: number | null;
  decision_id: string | null;
};

type Standup = {
  judgment: {
    candidates_found: number;
    dispatched_count: number;
    skipped: { theme: string; why: string }[];
  };
  summary_bullets: string[];
  loop_closed: { theme: string; outcome: string }[];
  needs_you_count?: number;
  moving_clean_count?: number;
};

type HybridPayload = {
  generic?: boolean;
  kpis: {
    in_flight: number;
    shipped_measured: number;
    won: number;
    recurred: number;
  };
  rows: HybridRow[];
  standup?: Standup | null;
};

const STUCK_DAYS = 7;

function isException(r: HybridRow): boolean {
  if (r.dispatch_stage === "failed_to_open") return true;
  if (r.outcome === "recurred") return true;
  if (r.days_stuck != null) return true;
  return false;
}

function exceptionSeverityRank(r: HybridRow): number {
  if (r.outcome === "recurred") return 3;
  if (r.dispatch_stage === "failed_to_open") return 2;
  return 1;
}

function rankExceptions(exceptions: HybridRow[]): HybridRow[] {
  return [...exceptions].sort((a, b) => {
    const d = exceptionSeverityRank(b) - exceptionSeverityRank(a);
    if (d !== 0) return d;
    return (b.days_stuck ?? 0) - (a.days_stuck ?? 0);
  });
}

const NEEDS_YOU_CAP = 6;

function prNum(url: string | null): string {
  if (!url) return "";
  const parts = url.split("/pull/");
  return parts.length > 1 ? parts[1] : "";
}

const STAGE_LABEL: Record<DispatchStage, string> = {
  dispatched: "dispatched",
  engineer_done: "engineer done, no PR yet",
  pr_open: "PR open",
  merged: "PR merged",
  closed_unmerged: "PR closed, unmerged",
  failed_to_open: "PR failed to open",
};

function stageTone(s: DispatchStage): "neutral" | "good" | "warn" | "bad" {
  if (s === "merged") return "good";
  if (s === "closed_unmerged") return "warn";
  if (s === "failed_to_open") return "bad";
  return "neutral";
}

function exceptionReason(r: HybridRow): string {
  if (r.dispatch_stage === "failed_to_open")
    return "The engineer run finished but couldn't open a PR. It'll retry on the next dispatch.";
  if (r.outcome === "recurred")
    return "This shipped and merged, then came back. Recommend a fresh approach, not another point fix.";
  if (r.days_stuck != null) {
    const n = prNum(r.pr_url);
    return `${n ? `PR #${n}` : "The PR"} has been stuck ${r.days_stuck}d in review. It needs a merge, which is an engineer action, not mine.`;
  }
  return "Needs a look.";
}

function actClass(kind: "pr" | "plain"): string {
  const base =
    "inline-flex items-center rounded-lg border bg-white px-2.5 py-1 text-[12px] font-semibold transition-colors";
  return kind === "pr"
    ? `${base} border-[#bfdbfe] text-[#1e40af] hover:bg-[#eff6ff]`
    : `${base} border-[#e5e7eb] text-[#1f1f1f] hover:bg-[#f7f4ee]`;
}

function useRowActions() {
  const { openTab, seedComposer } = useWorkspace();

  const openPr = (url: string | null) => {
    if (url) {
      const href = url.startsWith("http") ? url : `https://${url}`;
      window.open(href, "_blank", "noopener,noreferrer");
    }
  };
  const openRun = (runId: string | null) => {
    if (runId)
      openTab({
        kind: "run",
        title: `Run ${runId.slice(0, 8)}…`,
        payload: { kind: "run", runId },
        dirty: false,
        pinned: false,
      });
  };
  const askPm = (theme: string) =>
    seedComposer({
      agentSlug: "pm",
      text: `What's the status of "${theme}"?`,
      thread: "current",
      autoSend: true,
    });
  const askEngineer = (theme: string) =>
    seedComposer({
      agentSlug: "engineer",
      text: `What's the status of the PR for "${theme}"?`,
      autoSend: true,
    });

  return { openPr, openRun, askPm, askEngineer };
}

function RowActions({
  row,
  include,
}: {
  row: HybridRow;
  include: {
    pr?: boolean;
    run?: boolean;
    askPm?: boolean;
    askEngineer?: boolean;
  };
}) {
  const a = useRowActions();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {include.pr && row.pr_url ? (
        <button
          type="button"
          className={actClass("pr")}
          onClick={() => a.openPr(row.pr_url)}
        >
          Open PR
        </button>
      ) : null}
      {include.run && row.child_run_id ? (
        <button
          type="button"
          className={actClass("plain")}
          onClick={() => a.openRun(row.child_run_id)}
        >
          Open engineer run
        </button>
      ) : null}
      {include.askPm ? (
        <button
          type="button"
          className={actClass("plain")}
          onClick={() => a.askPm(row.theme)}
        >
          Ask PM about this
        </button>
      ) : null}
      {include.askEngineer ? (
        <button
          type="button"
          className={actClass("plain")}
          onClick={() => a.askEngineer(row.theme)}
        >
          Ask engineer for status
        </button>
      ) : null}
    </div>
  );
}

function pickResolver(rows: HybridRow[]): HybridRow | null {
  const exceptions = rows.filter(isException);
  if (exceptions.length === 0) return null;
  const failed = exceptions.filter((r) => r.dispatch_stage === "failed_to_open");
  const pool = failed.length > 0 ? failed : exceptions;
  return pool.reduce((best, r) =>
    (r.days_stuck ?? 0) > (best.days_stuck ?? 0) ? r : best,
  );
}

function ResolverBanner({ row }: { row: HybridRow }) {
  const a = useRowActions();
  let message: ReactNode;
  let action: ReactNode = null;

  if (row.dispatch_stage === "failed_to_open") {
    message = (
      <>
        The engineer run for <b className="text-[#fde68a]">“{row.theme}”</b>{" "}
        finished but couldn’t open a PR.
      </>
    );
    action = row.child_run_id ? (
      <button
        type="button"
        onClick={() => a.openRun(row.child_run_id)}
        className="rounded-cta bg-white px-4 py-2 text-[13px] font-bold text-[#0f172a] transition-colors hover:bg-[#e5e7eb]"
      >
        Open engineer run
      </button>
    ) : null;
  } else if (row.days_stuck != null) {
    const n = prNum(row.pr_url);
    message = (
      <>
        {n ? `PR #${n}` : "The PR"} for{" "}
        <b className="text-[#fde68a]">“{row.theme}”</b> has been stuck{" "}
        <b className="text-[#fde68a]">{row.days_stuck}d</b> in review.
      </>
    );
    action = row.pr_url ? (
      <button
        type="button"
        onClick={() => a.openPr(row.pr_url)}
        className="rounded-cta bg-white px-4 py-2 text-[13px] font-bold text-[#0f172a] transition-colors hover:bg-[#e5e7eb]"
      >
        Open PR
      </button>
    ) : null;
  } else {
    message = (
      <>
        <b className="text-[#fde68a]">“{row.theme}”</b> shipped, then came back. It needs a fresh approach.
      </>
    );
    action = (
      <button
        type="button"
        onClick={() => a.askPm(row.theme)}
        className="rounded-cta bg-white px-4 py-2 text-[13px] font-bold text-[#0f172a] transition-colors hover:bg-[#e5e7eb]"
      >
        Ask PM about this
      </button>
    );
  }

  return (
    <section
      role="status"
      className="flex items-center gap-4 rounded-2xl bg-[#0f172a] px-4 py-4 text-white"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-bold uppercase tracking-wider text-[#93c5fd]">
          The one thing I need today
        </div>
        <div className="mt-1 text-[16px] leading-[1.4]">{message}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </section>
  );
}

function JudgmentBlock({ judgment }: { judgment: Standup["judgment"] }) {
  const [open, setOpen] = useState(false);
  const { candidates_found, dispatched_count, skipped } = judgment;
  return (
    <div className="rounded-xl border border-[#c7d2fe] bg-[#eef2ff] px-3.5 py-3">
      <div className="text-[13px] leading-[1.5] text-[#3730a3]">
        I found{" "}
        <b>
          {candidates_found} candidate fix
          {candidates_found === 1 ? "" : "es"}
        </b>{" "}
        this run, dispatched <b>{dispatched_count}</b>.
        {skipped.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-1.5 font-semibold text-[#1e40af] hover:underline"
          >
            {open ? "why ▾" : "why ▸"}
          </button>
        ) : null}
      </div>
      {open && skipped.length > 0 ? (
        <div className="mt-2.5 flex flex-col gap-2 rounded-lg border border-[#c7d2fe] bg-white px-3 py-2.5 text-[12px]">
          {skipped.map((s, i) => (
            <div key={i} className="text-[#4b5563]">
              <b>Skipped:</b> {s.theme}: {s.why}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReceiptsExpander({ row }: { row: HybridRow }) {
  const [open, setOpen] = useState(false);
  const rows: [string, string][] = [
    ["Engineer run", row.child_run_id || "-"],
    ["PR", row.pr_url || "-"],
    ["Stage", STAGE_LABEL[row.dispatch_stage]],
    ["Stuck", row.days_stuck != null ? `${row.days_stuck}d` : "-"],
    ["Updated", ago(row.updated_at)],
  ];
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[12px] font-semibold text-[#1e40af] hover:underline"
      >
        {open ? "receipts ▾" : "receipts ▸"}
      </button>
      {open ? (
        <dl className="mt-1.5 flex flex-col gap-1 rounded-lg border border-[#f0f0f0] bg-[#fbfaf7] px-3 py-2.5 text-[12px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="w-24 shrink-0 text-[11px] font-bold uppercase tracking-wide text-[#8a8a8a]">
                {k}
              </dt>
              <dd
                className={`min-w-0 break-all text-[#374151] ${
                  k === "Engineer run" || k === "PR" ? "font-mono text-[11px]" : ""
                }`}
              >
                {v}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function NeedsYouDecision({
  row,
  onResolved,
}: {
  row: HybridRow;
  onResolved: () => void;
}) {
  const decisionId = row.decision_id;
  const [confirming, setConfirming] = useState(false);
  const [acting, setActing] = useState<null | "approve" | "reject">(null);
  const [done, setDone] = useState<null | "approved" | "declined">(null);
  const [failed, setFailed] = useState(false);

  if (!decisionId) {
    return (
      <span className="text-[12px] text-[#8a8a8a]">
        No approval to make yet. The PM opens one on its next run.
      </span>
    );
  }

  if (done) {
    return (
      <div
        className={`text-[12px] font-medium ${
          done === "approved" ? "text-[#167f50]" : "text-[#595959]"
        }`}
      >
        {done === "approved"
          ? "✓ Approved. Re-dispatching the engineer and closing the PR"
          : "Declined, left as is"}
      </div>
    );
  }

  const act = async (action: "approve" | "reject") => {
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
      setDone(action === "approve" ? "approved" : "declined");
      onResolved();
    } catch {
      setFailed(true);
    } finally {
      setActing(null);
    }
  };

  const prBtn =
    "inline-flex items-center rounded-xl bg-[#0f1729] px-3 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-[#1c2740] disabled:opacity-50";

  const n = prNum(row.pr_url);

  return (
    <div className="flex flex-col gap-2">
      {confirming ? (
        <>
          <div className="rounded-lg border border-[#e8c46a] bg-[#fdf9ee] px-2.5 py-2 text-[12px] leading-[1.4] text-[#2b2416]">
            Approve? This re-dispatches the engineer
            {n ? ` and closes PR #${n}` : " and closes the stuck PR"}.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={acting !== null}
              onClick={() => void act("approve")}
              className={prBtn}
            >
              {acting === "approve" ? "…" : "Confirm approve"}
            </button>
            <button
              type="button"
              disabled={acting !== null}
              onClick={() => setConfirming(false)}
              className={actClass("plain")}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={acting !== null}
            onClick={() => setConfirming(true)}
            className={prBtn}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={acting !== null}
            onClick={() => void act("reject")}
            className={actClass("plain")}
          >
            {acting === "reject" ? "…" : "Not now"}
          </button>
        </div>
      )}
      {failed ? (
        <span className="text-[11px] text-[#c0392b]">
          Couldn&apos;t update. Try again.
        </span>
      ) : null}
    </div>
  );
}

function NeedsYouItem({
  row,
  onResolved,
  decisionSlot,
}: {
  row: HybridRow;
  onResolved: () => void;
  decisionSlot?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[#f0f0f0] border-l-[3px] border-l-[#cb2029] bg-white px-4 py-3">
      <div className="text-[16px] font-semibold leading-[1.3] text-[#0e0f11]">
        {row.theme || "(untitled)"}
      </div>
      <div className="mt-1 text-[13px] text-[#595959]">
        {exceptionReason(row)}
      </div>
      <div className="mt-2">
        <RowActions
          row={row}
          include={{ pr: true, run: true, askPm: true, askEngineer: true }}
        />
      </div>
      <ReceiptsExpander row={row} />
      <div className="mt-2.5 border-t border-dashed border-[#f0f0f0] pt-2.5">
        {decisionSlot ?? <NeedsYouDecision row={row} onResolved={onResolved} />}
      </div>
    </div>
  );
}

function StandupCard({
  standup,
  exceptions,
  totalExceptionCount,
  overflowCount,
  movingCleanCount,
  onOpenRoadmap,
  onResolved,
}: {
  standup: Standup | null | undefined;
  exceptions: HybridRow[];
  totalExceptionCount: number;
  overflowCount: number;
  movingCleanCount: number;
  onOpenRoadmap: () => void;
  onResolved: () => void;
}) {
  return (
    <section className="rounded-2xl border border-[#f0f0f0] bg-white px-4 py-4">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[14px] font-semibold text-[#0e0f11]">
          Product Manager
        </h3>
        <span className="text-[12px] text-[#8a8a8a]">morning standup</span>
      </div>

      {standup ? (
        <>
          {standup.summary_bullets.length > 0 ? (
            <div className="mt-3 flex flex-col gap-2">
              {standup.summary_bullets.map((b, i) => (
                <div key={i} className="text-[13px] text-[#1f2937]">
                  • {b}
                </div>
              ))}
            </div>
          ) : null}

          {standup.loop_closed.length > 0 ? (
            <div className="mt-3 flex flex-col gap-2">
              {standup.loop_closed.map((l, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-[#a7f3d0] bg-[#d1fae5] px-3 py-2 text-[13px] font-medium text-[#065f46]"
                >
                  <span aria-hidden="true">✓</span> {l.theme}: {l.outcome}
                </div>
              ))}
            </div>
          ) : null}

          <div className="mt-3.5">
            <JudgmentBlock judgment={standup.judgment} />
          </div>
        </>
      ) : (
        <p className="mt-3 text-[13px] text-[#8a8a8a]">
          No standup yet. The PM builds it from its latest run. Once it runs,
          you’ll see what it found, what it dispatched (and why not the rest),
          and what closed the loop.
        </p>
      )}

      <div className="mt-4">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[#595959]">
          Needs you ({totalExceptionCount})
        </div>
        {totalExceptionCount > 0 ? (
          <div className="flex flex-col gap-2.5">
            {exceptions.map((r) => (
              <NeedsYouItem key={r.id} row={r} onResolved={onResolved} />
            ))}
            {overflowCount > 0 ? (
              <button
                type="button"
                onClick={onOpenRoadmap}
                className="self-start text-[13px] font-semibold text-[#1e40af] hover:underline"
              >
                +{overflowCount} more in governance ▸
              </button>
            ) : null}
          </div>
        ) : (
          <div className="rounded-xl border border-[#cfe6da] bg-[#e8f3ed] px-4 py-3 text-[13px] text-[#167f50]">
            Nothing needs you right now. Every dispatched fix is moving on its
            own.
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-dashed border-[#f0f0f0] pt-3 text-[13px] text-[#374151]">
        {movingCleanCount > 0 ? (
          <>That’s it. Everything else ({movingCleanCount}) is moving fine.{" "}</>
        ) : (
          <>
            Nothing is moving cleanly right now. The backlog is stalled.{" "}
          </>
        )}
        <button
          type="button"
          onClick={onOpenRoadmap}
          className="font-semibold text-[#1e40af] hover:underline"
        >
          Full roadmap ▸
        </button>
      </div>
    </section>
  );
}

function PipelineStrip({ rows }: { rows: HybridRow[] }) {
  const c = {
    proposed: rows.filter((r) => r.status === "proposed").length,
    in_flight: rows.filter((r) => r.status === "in_flight").length,
    shipped: rows.filter((r) => r.status === "shipped").length,
    measured: rows.filter((r) => r.status === "measured").length,
    won: rows.filter((r) => r.outcome === "won").length,
    recurred: rows.filter((r) => r.outcome === "recurred").length,
  };
  const stuck = rows.filter((r) => r.days_stuck != null).length;
  const segs: {
    label: string;
    n: number;
    tone: "neutral" | "good" | "bad";
    note?: string;
  }[] = [
    { label: "Proposed", n: c.proposed, tone: "neutral" },
    {
      label: "In flight",
      n: c.in_flight,
      tone: stuck > 0 ? "bad" : "neutral",
      note: stuck > 0 ? `${stuck} stuck` : undefined,
    },
    { label: "Shipped", n: c.shipped, tone: "neutral" },
    { label: "Measured", n: c.measured, tone: "neutral" },
    { label: "Won", n: c.won, tone: "good" },
    { label: "Recurred", n: c.recurred, tone: c.recurred > 0 ? "bad" : "neutral" },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {segs.map((s) => {
        const border =
          s.tone === "good"
            ? "border-[#a7f3d0] bg-[#d1fae5]"
            : s.tone === "bad"
              ? "border-[#fecaca] bg-[#fee2e2]"
              : "border-[#f0f0f0] bg-[#fbfaf7]";
        const numColor =
          s.tone === "good"
            ? "text-[#167f50]"
            : s.tone === "bad"
              ? "text-[#cb2029]"
              : "text-[#0e0f11]";
        return (
          <div
            key={s.label}
            className={`min-w-[86px] flex-1 rounded-xl border px-3 py-2.5 text-center ${border}`}
          >
            <div className={`text-[20px] font-bold tabular-nums ${numColor}`}>
              {s.n}
            </div>
            <div className="mt-0.5 text-[11px] uppercase tracking-wide text-[#595959]">
              {s.label}
            </div>
            {s.note ? (
              <div className="mt-0.5 text-[11px] font-semibold text-[#cb2029]">
                {s.note}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function RoadmapLedger({ rows }: { rows: HybridRow[] }) {
  const sorted = [...rows].sort(
    (a, b) => (isException(b) ? 1 : 0) - (isException(a) ? 1 : 0),
  );
  return (
    <div className="overflow-x-auto rounded-xl border border-[#f0f0f0] bg-white">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-[#f0f0f0] text-left text-[11px] uppercase tracking-wide text-[#8a8a8a]">
            <th className="px-3.5 py-2.5 font-semibold">Theme</th>
            <th className="px-3.5 py-2.5 font-semibold">Stage</th>
            <th className="px-3.5 py-2.5 font-semibold">Age</th>
            <th className="px-3.5 py-2.5 font-semibold">Engineer run</th>
            <th className="px-3.5 py-2.5 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.id}
              className={`border-b border-[#f0f0f0] last:border-0 ${
                isException(r) ? "bg-[#fef6f6]" : ""
              }`}
            >
              <td className="px-3.5 py-3">
                <div className="max-w-[290px] font-medium text-[#0e0f11]">
                  {r.theme || "(untitled)"}
                </div>
              </td>
              <td className="px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={stageTone(r.dispatch_stage)}>
                    {STAGE_LABEL[r.dispatch_stage]}
                  </Pill>
                  {r.days_stuck != null ? (
                    <Pill tone="bad">stuck {r.days_stuck}d</Pill>
                  ) : null}
                </div>
              </td>
              <td className="px-3.5 py-3 text-[#8a8a8a]">{ago(r.updated_at)}</td>
              <td className="px-3.5 py-3">
                {r.child_run_id ? (
                  <span className="font-mono text-[12px] text-[#027bff]">
                    {r.child_run_id.slice(0, 8)}
                  </span>
                ) : (
                  <span className="text-[12px] text-[#8a8a8a]">-</span>
                )}
              </td>
              <td className="px-3.5 py-3">
                <RowActions
                  row={r}
                  include={{ pr: true, run: true, askPm: true }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GovernancePanel({ rows }: { rows: HybridRow[] }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <SectionTitle>Pipeline health</SectionTitle>
        <PipelineStrip rows={rows} />
      </div>
      <div>
        <SectionTitle>Roadmap ledger · exceptions on top</SectionTitle>
        <RoadmapLedger rows={rows} />
      </div>
    </div>
  );
}

const emptyState = (
  <EmptyState title="No roadmap yet">
    Ask pm “what should we ship next?” to build your prioritized backlog. As
    fixes get dispatched and land, they’ll move across this board.
  </EmptyState>
);

export function PmHybridDashboard() {
  const state = useAgentDashboard<HybridPayload>("pm");
  const { refresh } = state;
  const [roadmapOpen, setRoadmapOpen] = useState(false);

  return (
    <DashboardShell
      title="Product delivery"
      subtitle="The standup up top; the receipts and roadmap one expand away."
      state={state}
      genericFallback={emptyState}
      render={(d) => {
        const rows = d.rows ?? [];
        if (rows.length === 0) return emptyState;

        const allExceptions = rankExceptions(rows.filter(isException));
        const visibleExceptions = allExceptions.slice(0, NEEDS_YOU_CAP);
        const overflowCount = allExceptions.length - visibleExceptions.length;
        const resolver = pickResolver(rows);
        const movingCleanCount =
          d.standup?.moving_clean_count ??
          rows.filter((r) => r.status === "in_flight" && !isException(r)).length;

        return (
          <>
            {resolver ? <ResolverBanner row={resolver} /> : null}

            <StandupCard
              standup={d.standup}
              exceptions={visibleExceptions}
              totalExceptionCount={allExceptions.length}
              overflowCount={overflowCount}
              movingCleanCount={movingCleanCount}
              onOpenRoadmap={() => setRoadmapOpen(true)}
              onResolved={refresh}
            />

            <section className="overflow-hidden rounded-2xl border border-[#f0f0f0] bg-white">
              <button
                type="button"
                onClick={() => setRoadmapOpen((v) => !v)}
                className="flex w-full items-center justify-between gap-3 px-4 py-4 text-left transition-colors hover:bg-[#fafafa]"
              >
                <span className="text-[14px] font-semibold text-[#0e0f11]">
                  Receipts &amp; roadmap{" "}
                  <span className="text-[12px] font-normal text-[#8a8a8a]">
                    (governance)
                  </span>
                </span>
                <span className="text-[12px] text-[#8a8a8a]">
                  {roadmapOpen ? "▾ hide" : "▸ show"}
                </span>
              </button>
              {roadmapOpen ? (
                <div className="border-t border-[#f0f0f0] px-4 py-4">
                  <GovernancePanel rows={rows} />
                </div>
              ) : null}
            </section>
          </>
        );
      }}
    />
  );
}
