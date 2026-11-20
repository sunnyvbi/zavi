"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { adminApiFetch } from "@/lib/api-admin";
import { TenantPicker } from "@/components/admin/TenantPicker";

type LivenessCell = {
  runs_total: number;
  runs_classified: number;
  shipped: number;
  answered: number;
  plan_only: number;
  empty: number;
  other: number;
  shipped_rate: number | null;
  coverage: number | null;
};

type FunnelCounts = {
  acted: number; approved: number; rejected: number; expired: number;
  dispatch_failed: number; open: number; superseded: number;
  dispatching: number; other: number;
};

type Resp = {
  window: { days: number; since: string; until: string };
  truncated: boolean;
  coverage: {
    runs_total: number; runs_classified: number; pct_classified: number | null;
    decisions_total: number; note: string;
  };
  decision_funnel: {
    total: number; counts: FunnelCounts; accepted: number; unattributed: number;
    by_agent: Array<{ agent_slug: string; total: number; counts: FunnelCounts; accepted: number }>;
  };
  liveness: {
    overall: LivenessCell;
    by_trigger: Array<{ trigger: string } & LivenessCell>;
    by_agent: Array<{ agent_slug: string } & LivenessCell>;
  };
  cost: {
    by_agent: Array<{
      agent_slug: string; runs: number; cost_usd: number; shipped: number;
      runs_classified: number; cost_per_shipped: number | null; coverage: number | null;
    }>;
    total_usd: number;
  };
  failure: {
    runs_total: number; failed_total: number; cancelled_total: number;
    by_class: Record<string, number>;
    by_agent: Array<{ agent_slug: string; failed: number; by_class: Record<string, number> }>;
    top_signatures: Array<{ signature: string; count: number; agents: string[] }>;
  };
  queue_wait: {
    sample: number; p50_ms: number | null; p95_ms: number | null;
    still_waiting: number; never_started: number;
    oldest_waiting_ms: number | null; negative_waits: number;
    by_agent: Array<{ agent_slug: string; sample: number; p50_ms: number | null; p95_ms: number | null }>;
  };
};

const DAY_OPTIONS = [7, 30, 90] as const;
const EM_DASH = "—";

function pct(ratio: number | null | undefined, digits = 1): string {
  if (ratio == null || !Number.isFinite(ratio)) return EM_DASH;
  return `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(digits)}%`;
}
function barWidth(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "0%";
  return `${Math.min(100, Math.max(0, ratio * 100)).toFixed(2)}%`;
}
function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return EM_DASH;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function ms(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return EM_DASH;
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 3_600_000) return `${(v / 60_000).toFixed(1)}m`;
  return `${(v / 3_600_000).toFixed(1)}h`;
}
const n = (x: number): string => x.toLocaleString();

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="font-display font-semibold text-lg text-slate-900">{title}</h2>
      {hint && <p className="text-sm text-slate-500 mt-0.5 mb-3">{hint}</p>}
      <div className={hint ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

function Card({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "amber" }) {
  const t = tone === "amber" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white";
  return <div className={`rounded-xl border ${t} p-4`}>{children}</div>;
}

function Bar({ ratio, className = "bg-slate-800" }: { ratio: number | null; className?: string }) {
  return (
    <div aria-hidden="true" className="h-2 rounded-full bg-slate-100 overflow-hidden">
      <div className={`h-full ${className}`} style={{ width: barWidth(ratio) }} />
    </div>
  );
}

function CoverageRail({ ratio }: { ratio: number | null }) {
  return (
    <div
      aria-hidden="true"
      className="h-2 rounded-full overflow-hidden bg-[repeating-linear-gradient(135deg,#fef3c7_0,#fef3c7_5px,#fde68a_5px,#fde68a_10px)]"
    >
      <div className="h-full bg-slate-400" style={{ width: barWidth(ratio) }} />
    </div>
  );
}

export default function AgentPerformancePage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">Loading…</div>}>
      <AgentPerformanceBoard />
    </Suspense>
  );
}

function AgentPerformanceBoard() {
  const router = useRouter();
  const params = useSearchParams();

  const days = Number(params.get("days") ?? 30) || 30;
  const tenantId = params.get("tenant_id") ?? "";
  const agentSlug = params.get("agent_slug") ?? "";

  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [allSignatures, setAllSignatures] = useState(false);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    p.set("days", String(days));
    if (tenantId) p.set("tenant_id", tenantId);
    if (agentSlug) p.set("agent_slug", agentSlug);
    return p.toString();
  }, [days, tenantId, agentSlug]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/agent-performance?${qs}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setData(r as Resp);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [qs]);

  const navigate = useCallback(
    (next: Partial<{ days: number; tenant_id: string; agent_slug: string }>, mode: "push" | "replace") => {
      const p = new URLSearchParams(params.toString());
      const d = next.days ?? days;
      if (d === 30) p.delete("days");
      else p.set("days", String(d));
      const t = next.tenant_id !== undefined ? next.tenant_id : tenantId;
      if (t) p.set("tenant_id", t);
      else p.delete("tenant_id");
      const a = next.agent_slug !== undefined ? next.agent_slug : agentSlug;
      if (a) p.set("agent_slug", a);
      else p.delete("agent_slug");
      const url = p.toString() ? `/agent-performance?${p}` : "/agent-performance";
      if (mode === "push") router.push(url);
      else router.replace(url);
    },
    [router, params, days, tenantId, agentSlug],
  );

  const cov = data?.coverage.pct_classified ?? null;

  const agentRows = useMemo(() => {
    if (!data) return [];
    const m = new Map<
      string,
      { agent_slug: string; runs: number; classified: number; shipped: number; shipped_rate: number | null;
        coverage: number | null; cost_usd: number; cost_per_shipped: number | null; failed: number; p95_ms: number | null }
    >();
    const get = (slug: string) => {
      let r = m.get(slug);
      if (!r) {
        r = { agent_slug: slug, runs: 0, classified: 0, shipped: 0, shipped_rate: null, coverage: null,
              cost_usd: 0, cost_per_shipped: null, failed: 0, p95_ms: null };
        m.set(slug, r);
      }
      return r;
    };
    for (const a of data.liveness.by_agent) {
      const r = get(a.agent_slug);
      r.runs = a.runs_total; r.classified = a.runs_classified; r.shipped = a.shipped;
      r.shipped_rate = a.shipped_rate; r.coverage = a.coverage;
    }
    for (const c of data.cost.by_agent) {
      const r = get(c.agent_slug);
      r.cost_usd = c.cost_usd; r.cost_per_shipped = c.cost_per_shipped;
    }
    for (const f of data.failure.by_agent) get(f.agent_slug).failed = f.failed;
    for (const q of data.queue_wait.by_agent) get(q.agent_slug).p95_ms = q.p95_ms;
    return [...m.values()].sort((a, b) => b.runs - a.runs);
  }, [data]);

  const funnelOrder: Array<[keyof FunnelCounts, string]> = [
    ["acted", "Acted"], ["approved", "Approved (transient)"], ["rejected", "Rejected"],
    ["expired", "Expired"], ["dispatch_failed", "Dispatch failed"], ["open", "Open"],
    ["superseded", "Superseded"], ["dispatching", "Dispatching"], ["other", "Other / unknown"],
  ];

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Agent performance</h1>
        <p className="text-sm text-slate-500 mt-1">
          Five fleet metrics over one window. Rates are shown with their denominators — the
          shipped signal covers only part of the fleet and the page never hides that.
        </p>
      </div>

      {}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex rounded-lg border border-slate-200 bg-white overflow-hidden">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              onClick={() => navigate({ days: d }, "replace")}
              className={`px-3 py-1.5 text-sm ${
                d === days ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
        <div className="min-w-[280px]">
          <TenantPicker value={tenantId} onChange={(id) => navigate({ tenant_id: id }, "replace")} />
        </div>
        {agentSlug && (
          <button
            onClick={() => navigate({ agent_slug: "" }, "replace")}
            className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            agent: <span className="font-mono">{agentSlug}</span>
            <span aria-hidden="true">×</span>
            <span className="sr-only">Clear agent filter</span>
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {loading && !data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : !data ? null : (
        <>
          {}
          <div
            className={`rounded-xl border p-4 mb-6 ${
              cov != null && cov < 1 ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"
            }`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm font-medium text-slate-900">
                Shipped-signal coverage: {pct(cov)}
              </div>
              <div className="font-mono text-sm text-slate-600">
                {n(data.coverage.runs_classified)} / {n(data.coverage.runs_total)} runs classified
              </div>
            </div>
            <div className="mt-2">
              <CoverageRail ratio={cov} />
            </div>
            <p className="text-xs text-slate-600 mt-2">
              Striped = unclassified. The shipped signal starts 2026-07-07 and is not backfilled, so
              older runs in this window carry no tier. Shipped rate is computed over{" "}
              <strong>classified runs only</strong>; cost per shipped run is approximate in both
              directions and should be used to rank agents, not to quote a figure.
            </p>
            {data.truncated && (
              <p className="text-xs text-rose-700 mt-2 font-medium">
                Result truncated at the page cap — these totals are a partial window, not the full one.
              </p>
            )}
          </div>

          {}
          <Section
            title="Shipped rate by trigger"
            hint="Deliberately not shown as one fleet number: a2a and cron differ by ~100×, so an average of them describes nothing real."
          >
            <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
              {data.liveness.by_trigger.length === 0 && (
                <div className="p-4 text-sm text-slate-500">No runs in this window.</div>
              )}
              {data.liveness.by_trigger.map((t) => (
                <div key={t.trigger} className="p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="font-mono text-sm text-slate-900">{t.trigger}</div>
                    <div className="text-sm text-slate-600">
                      <span className="font-semibold text-slate-900">{pct(t.shipped_rate)}</span>{" "}
                      of classified
                      <span className="text-slate-400"> · </span>
                      <span className="font-mono">
                        {n(t.shipped)} / {n(t.runs_classified)}
                      </span>{" "}
                      shipped
                    </div>
                  </div>
                  <div className="mt-2 grid gap-1.5">
                    <Bar ratio={t.shipped_rate} className="bg-sky-700" />
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <CoverageRail ratio={t.coverage} />
                      </div>
                      <div className="text-xs text-slate-500 font-mono whitespace-nowrap">
                        coverage {pct(t.coverage, 0)} ({n(t.runs_classified)}/{n(t.runs_total)})
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-slate-500 font-mono">
                    shipped {n(t.shipped)} · answered {n(t.answered)} · plan-only {n(t.plan_only)} ·
                    empty {n(t.empty)} · other {n(t.other)}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {}
          <Section
            title="Decision outcomes"
            hint="One shared denominator. Acted and approved stay separate — approved is transient, acted means it actually dispatched."
          >
            <Card>
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                <div className="text-sm text-slate-700">
                  <span className="font-mono text-slate-900">{n(data.decision_funnel.total)}</span> decisions
                </div>
                <div className="text-sm text-slate-600">
                  accepted{" "}
                  <span className="font-mono text-slate-900">{n(data.decision_funnel.accepted)}</span>
                  <span className="text-slate-400"> · </span>
                  unattributed{" "}
                  <span className="font-mono text-slate-900">{n(data.decision_funnel.unattributed)}</span>
                </div>
              </div>
              <div className="space-y-2">
                {funnelOrder.map(([k, label]) => {
                  const v = data.decision_funnel.counts[k];
                  const ratio = data.decision_funnel.total > 0 ? v / data.decision_funnel.total : null;
                  return (
                    <div key={k} className="flex items-center gap-3">
                      <div className="w-44 shrink-0 text-sm text-slate-700">{label}</div>
                      <div className="flex-1">
                        <Bar ratio={ratio} className={k === "other" ? "bg-amber-500" : "bg-slate-800"} />
                      </div>
                      <div className="w-36 shrink-0 text-right font-mono text-sm text-slate-600">
                        {n(v)}/{n(data.decision_funnel.total)} · {pct(ratio, 0)}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-slate-500 mt-3">
                <strong>Other / unknown</strong> and <strong>unattributed</strong> are always shown, including
                at zero — they are the guarantee that no decision silently left the denominator.
                Unattributed decisions have no parent run, so they count fleet-wide but cannot be
                assigned to an agent.
              </p>
            </Card>
          </Section>

          {}
          <Section title="By agent" hint="Select an agent to scope every metric on this page to it.">
            <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-3 py-2.5">Agent</th>
                    <th className="text-right px-3 py-2.5">Runs</th>
                    <th className="text-right px-3 py-2.5">Shipped</th>
                    <th className="text-right px-3 py-2.5">Coverage</th>
                    <th className="text-right px-3 py-2.5">Cost / ship</th>
                    <th className="text-right px-3 py-2.5">Spend</th>
                    <th className="text-right px-3 py-2.5">Failed</th>
                    <th className="text-right px-3 py-2.5">Queue p95</th>
                  </tr>
                </thead>
                <tbody>
                  {agentRows.map((a) => (
                    <tr key={a.agent_slug} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2">
                        <button
                          onClick={() => navigate({ agent_slug: a.agent_slug }, "push")}
                          className="text-slate-900 hover:text-sky-700 hover:underline text-left"
                        >
                          {a.agent_slug}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">{n(a.runs)}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        <span className="text-slate-900">{pct(a.shipped_rate, 0)}</span>{" "}
                        <span className="text-slate-400 text-xs">
                          {n(a.shipped)}/{n(a.classified)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        <span className={a.coverage != null && a.coverage < 1 ? "text-amber-700" : "text-slate-600"}>
                          {pct(a.coverage, 0)}
                        </span>{" "}
                        <span className="text-slate-400 text-xs">
                          {n(a.classified)}/{n(a.runs)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">
                        {a.cost_per_shipped == null ? (
                          <span className="text-slate-400">{EM_DASH}</span>
                        ) : (
                          <span
                            className={a.coverage != null && a.coverage < 1 ? "text-amber-700" : undefined}
                            title="Two-sided bias: unclassified runs push this up, cost_usd undercounting pushes it down. Direction unknown."
                          >
                            ~{usd(a.cost_per_shipped)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">{usd(a.cost_usd)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">{n(a.failed)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">{ms(a.p95_ms)}</td>
                    </tr>
                  ))}
                  {agentRows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-6 text-center text-sm text-slate-500">
                        No agent activity in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              <strong>Cost / ship is approximate in BOTH directions</strong> (hence <span className="font-mono">~</span>).
              Unclassified runs mean ships are undercounted, which pushes it <em>up</em>; but{" "}
              <code>agent_runs.cost_usd</code> is known to undercount Anthropic spend — treat spend as a
              floor — which pushes it <em>down</em>. Use it to rank agents, not to quote a figure.
              Total recorded spend this window: <span className="font-mono">{usd(data.cost.total_usd)}</span>{" "}
              (a floor).
            </p>
          </Section>

          {}
          <Section title="Failures" hint="Split by owner, so each class routes to whoever can actually fix it.">
            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <div className="text-sm text-slate-700 mb-3">
                  <span className="font-mono text-slate-900">{n(data.failure.failed_total)}</span> failed
                  <span className="text-slate-400"> · </span>
                  <span className="font-mono text-slate-900">{n(data.failure.cancelled_total)}</span> cancelled
                </div>
                <div className="space-y-2">
                  {Object.entries(data.failure.by_class)
                    .sort((a, b) => b[1] - a[1])
                    .map(([cls, v]) => {
                      const ratio = data.failure.failed_total > 0 ? v / data.failure.failed_total : null;
                      return (
                        <div key={cls} className="flex items-center gap-3">
                          <div className="w-28 shrink-0 text-sm text-slate-700 font-mono">{cls}</div>
                          <div className="flex-1">
                            <Bar ratio={ratio} className={cls === "unknown" ? "bg-amber-500" : "bg-slate-800"} />
                          </div>
                          <div className="w-28 shrink-0 text-right font-mono text-sm text-slate-600">
                            {n(v)}/{n(data.failure.failed_total)} · {pct(ratio, 0)}
                          </div>
                        </div>
                      );
                    })}
                  {Object.keys(data.failure.by_class).length === 0 && (
                    <div className="text-sm text-slate-500">No failures in this window.</div>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-3">
                  <strong>Cancelled is not failed</strong> — a human pressed stop. Counted separately so it
                  never inflates the failure rate. <strong>unknown</strong> means a failed run with no
                  structured outcome (pre-2026-07-07), not an unknown cause.
                </p>
              </Card>

              <Card>
                <div className="text-sm text-slate-700 mb-3">Recurring failure signatures</div>
                <div className="space-y-2">
                  {(allSignatures ? data.failure.top_signatures : data.failure.top_signatures.slice(0, 5)).map(
                    (s) => (
                      <div key={s.signature} className="text-sm">
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono text-slate-900 shrink-0">{n(s.count)}×</span>
                          <span className="text-slate-700 break-words">{s.signature}</span>
                        </div>
                        <div className="text-xs text-slate-500 font-mono mt-0.5">{s.agents.join(", ")}</div>
                      </div>
                    ),
                  )}
                  {data.failure.top_signatures.length === 0 && (
                    <div className="text-sm text-slate-500">Nothing recurring.</div>
                  )}
                </div>
                {data.failure.top_signatures.length > 5 && (
                  <button
                    onClick={() => setAllSignatures((v) => !v)}
                    className="mt-3 text-xs text-sky-700 hover:underline"
                  >
                    {allSignatures ? "Show top 5" : `Show all ${data.failure.top_signatures.length}`}
                  </button>
                )}
                <p className="text-xs text-slate-500 mt-3">
                  The coarse class collapses different causes into one bucket; the signature is what
                  separates them.
                </p>
              </Card>
            </div>
          </Section>

          {}
          <Section title="Queue health" hint="Wait time is enqueue → start. Execution time is diagnostic, not a KPI, and is not reported.">
            <div className="grid md:grid-cols-3 gap-4">
              <Card>
                <div className="text-xs uppercase tracking-[0.1em] text-slate-500">Wait percentiles</div>
                <div className="mt-2 flex items-baseline gap-4">
                  <div>
                    <div className="font-mono text-xl text-slate-900">{ms(data.queue_wait.p50_ms)}</div>
                    <div className="text-xs text-slate-500">p50</div>
                  </div>
                  <div>
                    <div className="font-mono text-xl text-slate-900">{ms(data.queue_wait.p95_ms)}</div>
                    <div className="text-xs text-slate-500">p95</div>
                  </div>
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  Over <span className="font-mono">{n(data.queue_wait.sample)}</span> runs that started.
                  Runs still queued are excluded — see backlog.
                </p>
                {data.queue_wait.negative_waits > 0 && (
                  <p className="text-xs text-amber-700 mt-1">
                    {n(data.queue_wait.negative_waits)} run(s) had a negative wait (clock skew) and were
                    excluded.
                  </p>
                )}
              </Card>

              <Card tone={data.queue_wait.still_waiting > 0 ? "amber" : "plain"}>
                <div className="text-xs uppercase tracking-[0.1em] text-slate-500">Queue backlog</div>
                <div className="font-mono text-2xl text-slate-900 mt-2">{n(data.queue_wait.still_waiting)}</div>
                <p className="text-xs text-slate-500 mt-1">
                  Runs enqueued and genuinely still pending right now.
                  {data.queue_wait.oldest_waiting_ms != null && (
                    <> Oldest has waited <span className="font-mono">{ms(data.queue_wait.oldest_waiting_ms)}</span>.</>
                  )}
                </p>
              </Card>

              <Card>
                <div className="text-xs uppercase tracking-[0.1em] text-slate-500">Never started</div>
                <div className="font-mono text-2xl text-slate-900 mt-2">{n(data.queue_wait.never_started)}</div>
                <p className="text-xs text-slate-500 mt-1">
                  Terminal runs that ended before ever starting (cancelled, dispatch failure).
                  <strong> This is not backlog</strong> — nothing here is waiting. It is a dispatch-health
                  signal.
                </p>
              </Card>
            </div>
          </Section>

          <p className="text-xs text-slate-400">
            Window: {data.window.days}d · {new Date(data.window.since).toLocaleString()} →{" "}
            {new Date(data.window.until).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}
