"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Row = {
  agent_slug: string;
  thumbs_up: number;
  thumbs_down: number;
  csat_total: number;
  pct_positive: number | null;
  runs: number;
  failed: number;
  fail_rate: number | null;
};
type Resp = { agents: Row[] };

export default function AdminQualityPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/agent-quality");
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setData(r as Resp);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Agent quality</h1>
        <p className="text-sm text-slate-500 mt-1">
          7-day CSAT + run failure rate per agent across all tenants. Highest failure rate on top.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No agent activity in the last 7 days.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Agent</th>
                <th className="text-right px-3 py-2.5">Runs 7d</th>
                <th className="text-right px-3 py-2.5">Fail rate</th>
                <th className="text-right px-3 py-2.5">👍 / 👎</th>
                <th className="text-right px-3 py-2.5">CSAT</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <tr key={a.agent_slug} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-900">{a.agent_slug}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{a.runs}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {a.fail_rate == null ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <span className={a.fail_rate >= 20 ? "text-rose-700 font-semibold" : a.fail_rate >= 5 ? "text-amber-700" : "text-emerald-700"}>
                        {a.fail_rate}%
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">
                    <span className="text-emerald-700">{a.thumbs_up}</span>
                    <span className="text-slate-300"> / </span>
                    <span className={a.thumbs_down > 0 ? "text-rose-700" : "text-slate-400"}>{a.thumbs_down}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {a.pct_positive == null ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <span className={a.pct_positive >= 80 ? "text-emerald-700" : a.pct_positive >= 50 ? "text-amber-700" : "text-rose-700 font-semibold"}>
                        {a.pct_positive}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
