"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import { cn } from "@/lib/utils";

type ValueReportResponse = {
  window_days: number;
  metric: "agent_runtime_time_on_task";
  totals: { tenants: number; runs: number; runtime_seconds: number };
  rows: Array<{ tenant_id: string; runs: number; runtime_seconds: number }>;
};

export default function AdminValueReportPage() {
  const [data, setData] = useState<ValueReportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const res = await adminApiFetch("/api/admin/value-report", { signal: ctrl.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setData(body as ValueReportResponse);
      setError(null);
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") return;
      setError((e as Error).message);
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 43_200_000);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      abortRef.current?.abort();
    };
  }, [load]);

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Value report</h1>
        <p className="text-sm text-slate-500 mt-1">
          What the agents actually ran, per tenant, over the last 7 days. Read-only.
        </p>
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
          <div className="flex gap-3 mb-4 flex-wrap">
            <Stat
              label="Agent runtime"
              value={formatDuration(data.totals.runtime_seconds)}
              sub="last 7 days · all tenants"
              accent
            />
            <Stat
              label="Completed runs"
              value={data.totals.runs.toLocaleString()}
              sub="seed runs excluded"
            />
            <Stat
              label="Active tenants"
              value={data.totals.tenants.toLocaleString()}
              sub="ran ≥1 agent"
            />
            <span className="self-center text-xs text-slate-400">
              {loading ? "Refreshing…" : ""}
            </span>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                <tr>
                  <th className="text-left px-3 py-2.5">Tenant</th>
                  <th className="text-right px-3 py-2.5">Runs (7d)</th>
                  <th className="text-right px-3 py-2.5">Agent runtime</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-slate-500">
                      No agent runtime in the last 7 days.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((r) => (
                    <tr key={r.tenant_id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2 font-mono text-slate-700 text-sm">
                        {r.tenant_id.slice(0, 8)}…
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600 text-sm">
                        {r.runs.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-800 text-sm">
                        {formatDuration(r.runtime_seconds)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="mt-2 text-xs text-slate-400">
            Metric: agent runtime (Σ finish − start over completed, non-seed runs). Honest
            time-on-task — not an estimated hours-saved figure.
          </p>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-white px-4 py-3 min-w-[140px]",
        accent ? "border-slate-900" : "border-slate-200",
      )}
    >
      <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="font-display font-semibold text-xl mt-0.5 text-slate-900">{value}</div>
      <div className="mt-0.5 text-xs text-slate-400">{sub}</div>
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0s";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
