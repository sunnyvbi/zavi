"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import {
  useAgentDashboard,
  DashboardShell,
  SectionTitle,
  AttentionList,
  EmptyState,
  Pill,
  ago,
  type AttentionItem,
} from "./dashboard-ui";
import { PmHybridDashboard } from "./PmHybridDashboard";

type RoadmapStatus = "proposed" | "in_flight" | "shipped" | "measured";
type RoadmapOutcome = "won" | "recurred" | null;

type RoadmapRow = {
  id: string;
  theme: string;
  status: RoadmapStatus;
  outcome: RoadmapOutcome;
  child_run_id: string | null;
  child_status: string | null;
  updated_at: string | null;
};

type WeekBucket = {
  week_start: string;
  inflow: number;
  dispatched: number;
};

type FlowVitals = {
  inflow_vs_dispatch: WeekBucket[];
  outcomes: {
    proposed: number;
    in_flight: number;
    shipped_measured: number;
    won: number;
    recurred: number;
  };
};

type Payload = {
  generic?: boolean;
  kpis: {
    in_flight: number;
    shipped_measured: number;
    won: number;
    recurred: number;
  };
  rows: RoadmapRow[];
  attention: AttentionItem[];
  flow_vitals?: FlowVitals;
};

const STATUS_LABEL: Record<RoadmapStatus, string> = {
  proposed: "proposed",
  in_flight: "in flight",
  shipped: "shipped",
  measured: "measured",
};

function statusTone(s: RoadmapStatus): "neutral" | "good" | "warn" | "bad" {
  if (s === "in_flight") return "warn";
  if (s === "shipped" || s === "measured") return "good";
  return "neutral";
}

const emptyState = (
  <EmptyState title="No roadmap yet">
    Ask pm “what should we ship next?” to build your prioritized backlog. As
    fixes get dispatched and land, they’ll move across this board.
  </EmptyState>
);

function VerdictBanner({ kpis }: { kpis: Payload["kpis"] }) {
  const landed = kpis.shipped_measured;
  const recurred = kpis.recurred;
  const healthy = landed > recurred;
  const ratioLabel =
    recurred > 0
      ? `${(landed / recurred).toFixed(2)}×`
      : landed > 0
        ? "all held"
        : "-";

  return (
    <section
      role="status"
      className={`flex items-center gap-4 rounded-2xl border px-4 py-4 ${
        healthy
          ? "border-[#cfe6da] bg-[#e8f3ed]"
          : "border-[#f1cdcf] bg-[#fbeaeb]"
      }`}
    >
      <div
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-black/[0.06] bg-white"
      >
        {healthy ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="#167f50"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
          >
            <path d="M3 17l6-6 4 4 7-7" />
            <path d="M14 8h6v6" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="#cb2029"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
          >
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
            <path d="M10.3 3.3 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.3a2 2 0 0 0-3.4 0z" />
          </svg>
        )}
      </div>
      <div className="flex-1">
        <div className="text-[14px] font-semibold text-[#0e0f11]">
          {healthy
            ? "Backlog is drawing down; fixes are holding"
            : recurred > 0
              ? "Recurrence is outpacing fixes that held"
              : "Nothing landed yet this cycle"}
        </div>
        <div className="mt-0.5 text-[13px] text-[#595959]">
          {landed} shipped / measured · {kpis.won} held (won) · {recurred} came
          back (recurred).{" "}
          {recurred > 0
            ? "Recurrence clusters deserve a root-cause look, not another single fix."
            : "Cycle is healthy."}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div
          className="text-[22px] font-bold tabular-nums tracking-tight"
          style={{ color: healthy ? "#167f50" : "#cb2029" }}
        >
          {ratioLabel}
        </div>
        <div className="text-[11px] uppercase tracking-wide text-[#595959]">
          shipped / measured ÷ recurred
        </div>
      </div>
    </section>
  );
}

function flowMax(weeks: WeekBucket[]): number {
  let m = 1;
  for (const w of weeks) m = Math.max(m, w.inflow, w.dispatched);
  return m;
}

function weekLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
}

function FlowVitals({ fv }: { fv: FlowVitals }) {
  const weeks = fv.inflow_vs_dispatch ?? [];
  const max = flowMax(weeks);
  const totalInflow = weeks.reduce((s, w) => s + w.inflow, 0);
  const totalDispatched = weeks.reduce((s, w) => s + w.dispatched, 0);
  const o = fv.outcomes ?? {
    proposed: 0,
    in_flight: 0,
    shipped_measured: 0,
    won: 0,
    recurred: 0,
  };
  const outpacing = totalDispatched >= totalInflow;

  return (
    <section
      aria-label="Flow vitals"
      className="rounded-2xl border border-[#f0f0f0] bg-white px-4 py-4"
    >
      <div className="flex items-baseline gap-2.5">
        <h3 className="text-[16px] font-semibold text-[#0e0f11]">
          Flow vitals
        </h3>
        <span className="text-[11px] text-[#8a8a8a]">
          trailing 5 weeks · UTC
        </span>
      </div>

      {}
      <div className="mt-3">
        <div className="flex items-center justify-between">
          <div className="text-[12px] font-semibold text-[#0e0f11]">
            Inflow vs dispatch
          </div>
          <div className="flex items-center gap-3 text-[11px] text-[#595959]">
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-3 rounded-sm border border-[#b9b9b9]"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(90deg,#b9b9b9 0 3px,transparent 3px 6px)",
                }}
              />
              inflow ({totalInflow})
            </span>
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-3 rounded-sm bg-[#027bff]"
              />
              dispatched ({totalDispatched})
            </span>
          </div>
        </div>
        <div
          role="img"
          aria-label={`Weekly inflow versus dispatch over ${weeks.length} weeks. ${totalInflow} themes discovered, ${totalDispatched} dispatched. ${
            outpacing
              ? "Dispatch is keeping pace with or outpacing inflow."
              : "Inflow is outpacing dispatch."
          }`}
          className="mt-2 flex items-end gap-3"
          style={{ height: 88 }}
        >
          {weeks.map((w) => (
            <div
              key={w.week_start}
              className="flex flex-1 flex-col items-center justify-end gap-1"
            >
              <div
                className="flex w-full items-end justify-center gap-1"
                style={{ height: 64 }}
              >
                {}
                <div
                  className="w-[42%] rounded-t border border-[#b9b9b9]"
                  style={{
                    height: `${(w.inflow / max) * 100}%`,
                    minHeight: w.inflow > 0 ? 3 : 0,
                    backgroundImage:
                      "repeating-linear-gradient(90deg,#dcdcdc 0 3px,transparent 3px 6px)",
                  }}
                  title={`${weekLabel(w.week_start)}: ${w.inflow} discovered`}
                />
                {}
                <div
                  className="w-[42%] rounded-t bg-[#027bff]"
                  style={{
                    height: `${(w.dispatched / max) * 100}%`,
                    minHeight: w.dispatched > 0 ? 3 : 0,
                  }}
                  title={`${weekLabel(w.week_start)}: ${w.dispatched} dispatched`}
                />
              </div>
              <div className="text-[11px] tabular-nums text-[#8a8a8a]">
                {weekLabel(w.week_start)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {}
      <div className="mt-5 border-t border-[#f4f4f4] pt-4">
        <div className="text-[12px] font-semibold text-[#0e0f11]">
          Lifecycle distribution
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-3">
          <div className="flex items-center justify-between">
            <dt className="text-[#595959]">Proposed</dt>
            <dd className="font-semibold tabular-nums text-[#0e0f11]">
              {o.proposed}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-[#595959]">In flight</dt>
            <dd className="font-semibold tabular-nums text-[#b06a00]">
              {o.in_flight}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-[#595959]">Shipped / measured</dt>
            <dd className="font-semibold tabular-nums text-[#167f50]">
              {o.shipped_measured}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="inline-flex items-center gap-1 text-[#595959]">
              <span aria-hidden="true">✓</span> Held (won)
            </dt>
            <dd className="font-semibold tabular-nums text-[#167f50]">
              {o.won}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="inline-flex items-center gap-1 text-[#595959]">
              <span aria-hidden="true">↻</span> Recurred
            </dt>
            <dd className="font-semibold tabular-nums text-[#cb2029]">
              {o.recurred}
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function usePmHybridFlag(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch("/api/tenant/me/pm-hybrid-surface");
        const body = (await res.json().catch(() => ({}))) as {
          enabled?: boolean;
        };
        if (alive) setEnabled(body.enabled === true);
      } catch {
        if (alive) setEnabled(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}

export function PmDashboard() {
  const hybrid = usePmHybridFlag();
  if (hybrid) return <PmHybridDashboard />;
  return <PmDashboardClassic />;
}

function PmDashboardClassic() {
  const state = useAgentDashboard<Payload>("pm");
  return (
    <DashboardShell
      title="Ship Velocity"
      subtitle="Are we shipping fixes faster than they come back?"
      state={state}
      genericFallback={emptyState}
      render={(d) => {
        const rows = d.rows ?? [];
        const attention = d.attention ?? [];
        const k = d.kpis ?? {
          in_flight: 0,
          shipped_measured: 0,
          won: 0,
          recurred: 0,
        };

        if (rows.length === 0) return emptyState;

        const recurredRows = rows.filter((r) => r.outcome === "recurred");

        return (
          <>
            {}
            <VerdictBanner kpis={k} />

            {}
            {attention.length > 0 && <AttentionList items={attention} />}

            {}
            {recurredRows.length > 0 && (
              <section
                role="alert"
                className="flex items-start gap-4 rounded-2xl border border-[#f1cdcf] bg-[#fbeaeb] px-4 py-4"
              >
                <div
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-black/[0.06] bg-white"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#cb2029"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                  >
                    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                    <path d="M21 3v5h-5" />
                    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                    <path d="M3 21v-5h5" />
                  </svg>
                </div>
                <div className="flex-1">
                  <div className="text-[14px] font-semibold text-[#0e0f11]">
                    Recurrence: {recurredRows.length} shipped fix
                    {recurredRows.length === 1 ? "" : "es"} came back
                  </div>
                  <div className="mt-0.5 text-[13px] text-[#595959]">
                    {recurredRows
                      .slice(0, 3)
                      .map((r) => `“${r.theme}”`)
                      .join(", ")}{" "}
                    recurred. Recommend one systemic root-cause bet over
                    re-dispatching point fixes. Ask pm in chat.
                  </div>
                </div>
              </section>
            )}

            {}
            {d.flow_vitals && <FlowVitals fv={d.flow_vitals} />}

            {}
            <section>
              <SectionTitle>Backlog ledger · evidence-anchored</SectionTitle>
              <div className="overflow-hidden rounded-xl border border-[#f0f0f0] bg-white">
                <table className="w-full text-[13px] tabular-nums">
                  <thead>
                    <tr className="border-b border-[#f0f0f0] text-left text-[11px] uppercase tracking-wide text-[#8a8a8a]">
                      <th className="px-3.5 py-2.5 font-semibold">Theme</th>
                      <th className="px-3.5 py-2.5 font-semibold">Status</th>
                      <th className="px-3.5 py-2.5 font-semibold">Outcome</th>
                      <th className="px-3.5 py-2.5 font-semibold">
                        Engineer run
                      </th>
                      <th className="px-3.5 py-2.5 text-right font-semibold">
                        Updated
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.id}
                        className="border-b border-[#f0f0f0] last:border-0"
                      >
                        <td className="px-3.5 py-3">
                          <div className="font-medium text-[#0e0f11]">
                            {r.theme || "(untitled)"}
                          </div>
                          {r.child_status &&
                          (r.status === "in_flight" ||
                            r.status === "shipped") ? (
                            <div className="mt-0.5 text-[11px] text-[#8a8a8a]">
                              engineer run: {r.child_status}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-3.5 py-3">
                          <Pill tone={statusTone(r.status)}>
                            {STATUS_LABEL[r.status]}
                          </Pill>
                        </td>
                        <td className="px-3.5 py-3">
                          {r.outcome === "won" ? (
                            <span className="inline-flex items-center gap-2 text-[12px] font-semibold text-[#167f50]">
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#167f50"
                                strokeWidth={2.6}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="h-[13px] w-[13px]"
                                aria-hidden="true"
                              >
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                              won
                            </span>
                          ) : r.outcome === "recurred" ? (
                            <span className="inline-flex items-center gap-2 text-[12px] font-semibold text-[#cb2029]">
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#cb2029"
                                strokeWidth={2.4}
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="h-[13px] w-[13px]"
                                aria-hidden="true"
                              >
                                <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                                <path d="M21 3v5h-5" />
                                <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                                <path d="M3 21v-5h5" />
                              </svg>
                              recurred
                            </span>
                          ) : (
                            <span className="text-[#c8c8c8]">-</span>
                          )}
                        </td>
                        <td className="px-3.5 py-3">
                          {r.child_run_id ? (
                            <span className="font-mono text-[12px] text-[#027bff]">
                              {r.child_run_id.slice(0, 8)}
                            </span>
                          ) : (
                            <span className="text-[12px] text-[#8a8a8a]">
                              -
                            </span>
                          )}
                        </td>
                        <td className="px-3.5 py-3 text-right text-[#8a8a8a]">
                          {ago(r.updated_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        );
      }}
    />
  );
}
