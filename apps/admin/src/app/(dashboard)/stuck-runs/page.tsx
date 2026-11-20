"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Run = {
  id: string;
  tenant_id: string | null;
  tenant: string;
  agent_slug: string | null;
  status: string;
  started_at: string | null;
  age_min: number | null;
  error: string | null;
};
type Resp = { sla_minutes: number; stuck: Run[]; failed_24h: Run[] };

export default function AdminStuckRunsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/stuck-runs");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Stuck runs · SLA</h1>
        <p className="text-sm text-slate-500 mt-1">
          Runs still executing past the {data?.sla_minutes ?? 15}-minute SLA, plus everything that failed in the last 24h.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <div className="space-y-6">
          <Section title={`Hung (> ${data.sla_minutes}m running)`} rows={data.stuck} showAge empty="Nothing hung — fleet is flowing." />
          <Section title="Failed (24h)" rows={data.failed_24h} empty="No failures in the last 24h." />
        </div>
      )}
    </div>
  );
}

function Section({ title, rows, showAge, empty }: { title: string; rows: Run[]; showAge?: boolean; empty: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-800 mb-2">
        {title} <span className="font-mono text-slate-400">({rows.length})</span>
      </h2>
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500 text-center">{empty}</div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-left px-3 py-2.5">Agent</th>
                <th className="text-left px-3 py-2.5">Status</th>
                {showAge && <th className="text-right px-3 py-2.5">Age</th>}
                <th className="text-left px-3 py-2.5">Started</th>
                <th className="text-left px-3 py-2.5">Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-700">
                    {r.tenant_id ? <Link href={`/tenants/${r.tenant_id}`} className="hover:underline">{r.tenant}</Link> : r.tenant}
                  </td>
                  <td className="px-3 py-2 text-slate-900">
                    <Link href={`/runs/${r.id}`} className="hover:underline">{r.agent_slug ?? "—"}</Link>
                  </td>
                  <td className="px-3 py-2 text-slate-600">{r.status}</td>
                  {showAge && (
                    <td className="px-3 py-2 text-right font-mono text-amber-700">{r.age_min != null ? `${r.age_min}m` : "—"}</td>
                  )}
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {r.started_at ? new Date(r.started_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-500 text-sm max-w-[240px] truncate" title={r.error ?? ""}>
                    {r.error ?? "—"}
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
