"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";
import { cn } from "@/lib/utils";

type GapGroup = {
  tenant_id: string;
  hash: string;
  question: string;
  count: number;
  last_seen: string;
  agents: string[];
  statuses: string[];
};

type GapsResponse = {
  window_days: number;
  min_count: number;
  total_failed_episodes: number;
  with_question: number;
  gap_count: number;
  gaps: GapGroup[];
};

type WindowDays = 14 | 30 | 90;

export default function AdminGapsPage() {
  const [data, setData] = useState<GapsResponse | null>(null);
  const [days, setDays] = useState<WindowDays>(14);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (d: WindowDays) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const res = await adminApiFetch(`/api/admin/gaps?days=${d}`, { signal: ctrl.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setData(body as GapsResponse);
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
    void load(days);
    const t = setInterval(() => void load(days), 43_200_000);
    const onVisible = () => {
      if (!document.hidden) void load(days);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      abortRef.current?.abort();
    };
  }, [days, load]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Gaps</h1>
        <p className="text-sm text-slate-500 mt-1">
          Questions the fleet failed to answer, grouped by recurrence. Read-only.
        </p>
      </div>

      <div className="mb-4 flex items-center gap-2">
        {([14, 30, 90] as const).map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              days === d
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
            )}
          >
            {d}d
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-400">{loading ? "Refreshing…" : ""}</span>
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
            <Stat label="Distinct gaps" value={data.gap_count.toLocaleString()} accent />
            <Stat label="Failed episodes" value={data.total_failed_episodes.toLocaleString()} />
            <Stat label="With a question" value={data.with_question.toLocaleString()} />
            <Stat label="Window" value={`${data.window_days}d`} />
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                <tr>
                  <th className="text-left px-3 py-2.5">Question</th>
                  <th className="text-left px-3 py-2.5">Tenant</th>
                  <th className="text-left px-3 py-2.5">Agents</th>
                  <th className="text-left px-3 py-2.5">Statuses</th>
                  <th className="text-right px-3 py-2.5">Count</th>
                  <th className="text-right px-3 py-2.5">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.gaps.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-slate-500">
                      No unanswered-question gaps in this window.
                    </td>
                  </tr>
                ) : (
                  data.gaps.map((g) => (
                    <tr
                      key={`${g.tenant_id}::${g.hash}`}
                      className="border-t border-slate-100 align-top hover:bg-slate-50"
                    >
                      <td className="px-3 py-2 text-slate-900">
                        <span className="line-clamp-3 max-w-md block">{g.question}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-700 text-sm">
                        {g.tenant_id.slice(0, 8)}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-600 text-sm">
                        {g.agents.length ? g.agents.join(", ") : "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                        {g.statuses.length ? g.statuses.join(", ") : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900">
                        {g.count.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600 text-sm">
                        {relativeTime(g.last_seen)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-white px-4 py-3 min-w-[110px]",
        accent ? "border-slate-900" : "border-slate-200",
      )}
    >
      <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="font-display font-semibold text-xl mt-0.5 text-slate-900">{value}</div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
