"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type AgentEntry = {
  agent_slug: string;
  routed_runs: number;
  live_runs: number;
  shadow_runs: number;
  tier: Record<string, number>;
  reason_codes: Record<string, number>;
  classifier_runs: number;
  classifier_errors: number;
  classifier_error_rate: number;
  avg_classifier_ms: number | null;
  tokens: { input: number; output: number; cache_read: number; total: number };
  usd: number;
  flags: string[];
};

type Resp = {
  days: number;
  totals: {
    routed_runs: number;
    by_tier: Record<string, number>;
    classifier_runs: number;
    classifier_errors: number;
    classifier_error_rate: number;
  };
  perAgent: AgentEntry[];
};

export default function AdminModelRoutingPage() {
  return <Body />;
}

function Body() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/model-routing?days=${days}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setData(r as Resp);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
            Zavi · admin
          </div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">
            Model routing
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Cost-first Sonnet/Opus router — per-agent tier split, classifier health, spend.
          </p>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        >
          <option value={1}>1d</option>
          <option value={7}>7d</option>
          <option value={30}>30d</option>
          <option value={90}>90d</option>
        </select>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 mb-6">
            <Total label={`Routed runs · ${data.days}d`} value={data.totals.routed_runs.toLocaleString()} />
            <Total label="Sonnet" value={(data.totals.by_tier.sonnet ?? 0).toLocaleString()} />
            <Total label="Opus" value={(data.totals.by_tier.opus ?? 0).toLocaleString()} />
            <Total
              label="Classifier err"
              value={pct(data.totals.classifier_error_rate)}
              alert={data.totals.classifier_error_rate > 0.1 && data.totals.classifier_runs >= 5}
            />
          </div>

          {data.perAgent.length === 0 ? (
            <div className="glass-card border-dashed p-8 text-sm text-slate-600 text-center">
              No routed runs in window. (Router is on, but engineer/research/advisor
              haven&apos;t fired yet — or it&apos;s in shadow mode.)
            </div>
          ) : (
            <div className="glass-card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-3 py-2.5">Agent</th>
                    <th className="text-right px-3 py-2.5">Runs</th>
                    <th className="text-left px-3 py-2.5">Tier</th>
                    <th className="text-left px-3 py-2.5">Top reasons</th>
                    <th className="text-right px-3 py-2.5">Cls err</th>
                    <th className="text-right px-3 py-2.5">Cls ms</th>
                    <th className="text-right px-3 py-2.5">Tokens</th>
                    <th className="text-right px-3 py-2.5">USD</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perAgent.map((a) => {
                    const flagged = a.flags.includes("high_classifier_error");
                    return (
                      <tr key={a.agent_slug} className="border-t border-slate-100 hover:bg-slate-50 align-top">
                        <td className="px-3 py-2 text-slate-900">
                          {a.agent_slug}
                          {flagged && (
                            <span className="ml-1.5 rounded bg-rose-100 px-1 py-0.5 text-xs uppercase text-rose-700">
                              flag
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-600">
                          {a.routed_runs}
                          <span className="text-slate-400">
                            {" "}
                            ({a.live_runs}l/{a.shadow_runs}s)
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex gap-1 flex-wrap">
                            {Object.entries(a.tier).map(([t, n]) => (
                              <Badge key={t} tone={t === "opus" ? "amber" : t === "sonnet" ? "green" : "slate"}>
                                {t} {n}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-sm text-slate-500">
                          {topReasons(a.reason_codes)}
                        </td>
                        <td
                          className={
                            "px-3 py-2 text-right font-mono " +
                            (flagged ? "text-rose-700 font-semibold" : "text-slate-600")
                          }
                        >
                          {a.classifier_runs > 0 ? pct(a.classifier_error_rate) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-500">
                          {a.avg_classifier_ms ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-600">
                          {a.tokens.total.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-slate-900">
                          ${a.usd.toFixed(3)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function topReasons(m: Record<string, number>): string {
  const sorted = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return sorted.map(([r, n]) => `${r}:${n}`).join("  ") || "—";
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "amber" | "green" | "slate" }) {
  const cls =
    tone === "amber"
      ? "bg-amber-100 text-amber-800"
      : tone === "green"
        ? "bg-emerald-100 text-emerald-800"
        : "bg-slate-100 text-slate-700";
  return (
    <span className={"rounded px-1.5 py-0.5 text-xs " + cls}>{children}</span>
  );
}

function Total({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div
      className={
        "rounded-xl border bg-white p-4 " + (alert ? "border-rose-300 bg-rose-50" : "border-slate-200")
      }
    >
      <div className="text-sm uppercase tracking-[0.14em] text-slate-500">
        {label}
      </div>
      <div
        className={
          "mt-1 font-display font-semibold text-2xl tabular-nums " +
          (alert ? "text-rose-700" : "text-slate-900")
        }
      >
        {value}
      </div>
    </div>
  );
}
