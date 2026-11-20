"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";
import { InlineStatusRow } from "../InlineStatusRow";
import {
  useAgentDashboard,
  DashboardShell,
  SectionTitle,
  AttentionCard,
  EmptyState,
  Pill,
  num,
  ago,
  type AttentionItem,
} from "./dashboard-ui";

const SLUG = "chief-of-staff";

type DispatchRow = {
  target: string;
  decision_class: string;
  status: string;
  emitted_at: string | null;
  dispatch_error: string | null;
  failed: boolean;
};

type VerdictRow = {
  decision_id: string;
  verdict: "approved" | "rejected" | "deferred";
  target: string;
  intent: string;
  emitted_at: string | null;
};

type AccountabilityRow = {
  target: string;
  state: "delivered" | "on_track" | "at_risk" | "missed";
  intent: string;
  emitted_at: string | null;
};

type Payload = {
  generic?: boolean;
  kpis: {
    pending_cos_dispatches: number;
    pending_approvals_all: number;
    specialist_runs_since_digest: number;
    last_digest_at: string | null;
  };
  has_digest: boolean;
  attention: AttentionItem[];
  dispatches: DispatchRow[];
  recent_verdicts?: VerdictRow[];
  accountability?: AccountabilityRow[];
};

function statusTone(
  status: string,
  failed: boolean,
): "neutral" | "good" | "warn" | "bad" {
  if (failed) return "bad";
  if (status === "acted") return "good";
  if (status === "proposed") return "warn";
  return "neutral";
}

const placeholder = (
  <EmptyState title="No chief-of-staff brief yet.">
    Run a digest to scan your channels and fleet. If anything needs your call,
    it will land here as a decision card with the owner, reason, and next move.
  </EmptyState>
);

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

function delegatedRows(rows: DispatchRow[]): DispatchRow[] {
  return rows.filter((row) => row.status !== "proposed");
}

function atRiskCount(rows: AccountabilityRow[]): number {
  return rows.filter((row) => row.state === "at_risk" || row.state === "missed")
    .length;
}

function deliveredCount(rows: AccountabilityRow[]): number {
  return rows.filter((row) => row.state === "delivered").length;
}

function BriefHero({ data }: { data: Payload }) {
  const queueCount = data.attention.length;
  const failedCount = data.dispatches.filter((row) => row.failed).length;
  const delegatedCount = delegatedRows(data.dispatches).length;
  const accountability = data.accountability ?? [];
  const slippingCount = atRiskCount(accountability);
  const doneCount = deliveredCount(accountability);

  let title = "No urgent call is waiting right now.";
  let detail =
    "Your approval queue is clear. Watch delegated work, or run a fresh digest when you want Chief of Staff to scan for the next set of open loops.";
  if (queueCount > 0) {
    title = `Start with ${queueCount} ${plural(queueCount, "dispatch")} waiting for your verdict.`;
    detail =
      "Chief of Staff already packaged the owner and reason. Approve the work you want to run, reject anything stale, and the specialist queue stays clean.";
  } else if (failedCount > 0) {
    title = `${failedCount} delegated ${plural(failedCount, "item")} failed after approval.`;
    detail =
      "The approval queue is clear, but at least one handoff did not land. Retry it, reroute it, or ask Chief of Staff for the fastest recovery path.";
  } else if (slippingCount > 0) {
    title = `${slippingCount} ${plural(slippingCount, "commitment")} need follow-up.`;
    detail =
      "The team has accepted the work, but one or more commitments are at risk. Use the accountability panel to decide what to chase.";
  }

  return (
    <section className="rounded-xl border border-[#d7e2f7] bg-[#f6f9ff] px-4 py-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[#4d6b9f]">
            Morning brief
          </div>
          <h3 className="mt-1 text-[16px] font-semibold leading-snug text-[#0e0f11]">
            {title}
          </h3>
          <p className="mt-1 max-w-3xl text-[13px] leading-5 text-[#4f5b67]">
            {detail}
          </p>
        </div>
        <div className="grid min-w-[260px] grid-cols-3 gap-2">
          <BriefMetric label="Needs you" value={queueCount} tone="blue" />
          <BriefMetric label="Delegated" value={delegatedCount} tone="neutral" />
          <BriefMetric label="Delivered" value={doneCount} tone="green" />
        </div>
      </div>
    </section>
  );
}

function BriefMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: "blue" | "green" | "neutral";
}) {
  const toneClass =
    tone === "blue"
      ? "border-[#c9dafd] bg-white text-[#174ea6]"
      : tone === "green"
        ? "border-[#c2e3dc] bg-white text-[#0f766e]"
        : "border-[#e5e7eb] bg-white text-[#0e0f11]";
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
        {label}
      </div>
      <div className="mt-1 text-[20px] font-semibold tabular-nums">
        {typeof value === "number" ? num(value) : value}
      </div>
    </div>
  );
}

function RunDigestControls({ onRanComplete }: { onRanComplete: () => void }) {
  const [starting, setStarting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const onRun = useCallback(async () => {
    setErrorMsg(null);
    setRunId(null);
    setStarting(true);
    try {
      const res = await apiFetch(`/api/agents/${SLUG}/run`, {
        method: "POST",
        body: JSON.stringify({}),
        idempotent: true,
      });
      if (!res.ok) {
        setErrorMsg("Couldn't start the digest. Try again.");
        return;
      }
      const data = (await res.json()) as { run_id?: string };
      if (typeof data.run_id === "string") {
        setRunId(data.run_id);
      } else {
        onRanComplete();
      }
    } catch {
      setErrorMsg("Couldn't start the digest. Try again.");
    } finally {
      setStarting(false);
    }
  }, [onRanComplete]);

  const running = starting || runId !== null;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[#f0f0f0] bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[#0e0f11]">
            Refresh the brief
          </div>
          <div className="text-[12px] text-[#595959]">
            Scan your channels and specialist fleet now. Chief of Staff will
            update the brief, queue approval-gated dispatches, and leave auto
            bookkeeping out of your decision list.
          </div>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className="shrink-0 cursor-pointer rounded-cta bg-[#0e0f11] px-3.5 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-[#25262a] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? "Running…" : "Run digest now"}
        </button>
      </div>

      {runId && (
        <InlineStatusRow
          key={runId}
          agentSlug={SLUG}
          runId={runId}
          onComplete={() => {
            setTimeout(() => {
              setRunId(null);
              onRanComplete();
            }, 1500);
          }}
        />
      )}
      {errorMsg && (
        <div role="alert" className="text-[12px] text-[#cb2029]">
          {errorMsg}
        </div>
      )}
    </div>
  );
}

function DecisionQueue({
  items,
  onActed,
}: {
  items: AttentionItem[];
  onActed: () => void;
}) {
  const total = items.length;
  return (
    <section className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <SectionTitle>Needs your click</SectionTitle>
        <span className="rounded-full border border-[#e5e7eb] bg-white px-2 py-1 text-[12px] tabular-nums text-[#595959]">
          {total} {plural(total, "verdict")}
        </span>
      </div>
      {total === 0 ? (
        <EmptyState title="Queue clear">
          Nothing is waiting on your verdict right now. Run a fresh digest to
          surface the next set of dispatches.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((a, i) => (
            <AttentionCard key={a.decision_id ?? i} item={a} onActed={onActed} />
          ))}
        </div>
      )}
    </section>
  );
}

function DispatchesInFlight({ rows }: { rows: DispatchRow[] }) {
  return (
    <section className="min-w-0">
      <SectionTitle>Delegated work</SectionTitle>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#f0f0f0] px-4 py-3 text-[12px] text-[#a8a8a8]">
          No approved dispatches are in flight. Once you approve a decision,
          the specialist handoff appears here.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[#f0f0f0] bg-white">
          <table className="w-full table-fixed text-[13px]">
            <thead>
              <tr className="border-b border-[#f0f0f0] text-left text-[11px] uppercase tracking-wide text-[#8a8a8a]">
                <th className="w-[56%] px-3 py-2 font-medium">Owner</th>
                <th className="w-[22%] px-3 py-2 font-medium">Status</th>
                <th className="w-[22%] px-3 py-2 text-right font-medium">Queued</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-[#f0f0f0] align-top last:border-0"
                >
                  <td className="min-w-0 px-3 py-2">
                    <div className="truncate font-medium text-[#0e0f11]">
                      {row.target}
                    </div>
                    <div className="truncate font-mono text-[11px] text-[#8a8a8a]">
                      {row.decision_class}
                    </div>
                    {row.dispatch_error ? (
                      <div className="mt-0.5 text-[11px] text-[#cb2029]">
                        {row.dispatch_error}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <Pill tone={statusTone(row.status, row.failed)}>
                      {row.failed ? "failed" : row.status}
                    </Pill>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#595959]">
                    {ago(row.emitted_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const VERDICT_LABEL: Record<VerdictRow["verdict"], string> = {
  approved: "Approved",
  rejected: "Rejected",
  deferred: "Deferred",
};
const VERDICT_GLYPH: Record<VerdictRow["verdict"], string> = {
  approved: "✓",
  rejected: "✕",
  deferred: "↦",
};
function verdictTone(v: VerdictRow["verdict"]): "good" | "bad" | "neutral" {
  if (v === "approved") return "good";
  if (v === "rejected") return "bad";
  return "neutral";
}

export function RecentVerdicts({ rows }: { rows: VerdictRow[] }) {
  return (
    <section>
      <SectionTitle>Recent verdicts</SectionTitle>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#f0f0f0] px-4 py-3 text-[12px] text-[#a8a8a8]">
          No verdicts yet. Once you approve or reject a queued dispatch, your
          decisions land here, most recent first.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[#f0f0f0] bg-white">
          <ul>
            {rows.map((v) => (
              <li
                key={v.decision_id}
                className="flex items-center gap-2.5 border-b border-[#f0f0f0] px-3 py-2 last:border-0"
              >
                <Pill tone={verdictTone(v.verdict)}>
                  <span aria-hidden="true">{VERDICT_GLYPH[v.verdict]}</span>{" "}
                  {VERDICT_LABEL[v.verdict]}
                </Pill>
                <span className="min-w-0 flex-1 truncate text-[13px] text-[#0e0f11]">
                  <b className="font-semibold">{v.target}</b>
                  {v.intent ? <span className="text-[#595959]"> · {v.intent}</span> : null}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-[#8a8a8a]">
                  {ago(v.emitted_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const ACCT_LABEL: Record<AccountabilityRow["state"], string> = {
  delivered: "Delivered",
  on_track: "On track",
  at_risk: "At risk",
  missed: "Missed",
};
const ACCT_GLYPH: Record<AccountabilityRow["state"], string> = {
  delivered: "✓",
  on_track: "●",
  at_risk: "▲",
  missed: "✕",
};
function acctTone(
  s: AccountabilityRow["state"],
): "good" | "warn" | "bad" | "neutral" {
  if (s === "delivered") return "good";
  if (s === "on_track") return "neutral";
  if (s === "at_risk") return "warn";
  return "bad";
}

export function Accountability({ rows }: { rows: AccountabilityRow[] }) {
  return (
    <section>
      <div className="mb-2 flex flex-col">
        <SectionTitle>Accountability</SectionTitle>
        <span className="text-[12px] text-[#8a8a8a]">
          This week&apos;s committed vs. delivered.
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#f0f0f0] px-4 py-3 text-[12px] text-[#a8a8a8]">
          Nothing to track yet. Once you approve a dispatch, each agent&apos;s
          committed-vs-delivered status appears here for the past week.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((a, i) => (
            <div
              key={`${a.target}-${i}`}
              className="flex items-center justify-between gap-3 rounded-xl border border-[#f0f0f0] bg-white px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-[#0e0f11]">
                  {a.target}
                </div>
                <div className="truncate text-[12px] text-[#595959]">
                  {a.intent || "-"}
                  {a.emitted_at ? (
                    <span className="text-[#8a8a8a]"> · {ago(a.emitted_at)}</span>
                  ) : null}
                </div>
              </div>
              <Pill tone={acctTone(a.state)}>
                <span aria-hidden="true">{ACCT_GLYPH[a.state]}</span>{" "}
                {ACCT_LABEL[a.state]}
              </Pill>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function ChiefOfStaffDashboard() {
  const state = useAgentDashboard<Payload>(SLUG);
  const { refresh } = state;

  return (
    <DashboardShell
      title="Morning Brief"
      subtitle="See what needs your decision, what is already delegated, and what needs follow-up."
      state={state}
      genericFallback={
        <div className="flex flex-col gap-5">
          <RunDigestControls onRanComplete={refresh} />
          {placeholder}
        </div>
      }
      render={(d) => {
        const k = d.kpis;
        const delegated = delegatedRows(d.dispatches);
        const accountability = d.accountability ?? [];

        return (
          <>
            <BriefHero data={d} />

            {}
            <RunDigestControls onRanComplete={refresh} />

            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <BriefMetric
                label="Awaiting verdict"
                value={k.pending_cos_dispatches}
                tone="blue"
              />
              <BriefMetric
                label="All approvals"
                value={k.pending_approvals_all}
                tone="neutral"
              />
              <BriefMetric
                label="Since digest"
                value={k.last_digest_at ? k.specialist_runs_since_digest : "-"}
                tone="green"
              />
              <div className="rounded-lg border border-[#e5e7eb] bg-white px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8a8a8a]">
                  Last digest
                </div>
                <div className="mt-1 text-[20px] font-semibold tabular-nums text-[#0e0f11]">
                  {k.last_digest_at ? ago(k.last_digest_at) : "-"}
                </div>
              </div>
            </section>

            {}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
              <DecisionQueue items={d.attention} onActed={refresh} />
              <div className="flex min-w-0 flex-col gap-5">
                <DispatchesInFlight rows={delegated} />
                <RecentVerdicts rows={d.recent_verdicts ?? []} />
                <Accountability rows={accountability} />
              </div>
            </div>
          </>
        );
      }}
    />
  );
}
