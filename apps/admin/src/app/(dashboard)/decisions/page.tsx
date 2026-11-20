"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type DecisionRow = {
  id: string;
  tenant_id: string;
  agent_run_id: string | null;
  decision_class: string;
  status: string;
  autonomy_at_emit: string | null;
  handler: string | null;
  emitted_at: string;
  approved_at: string | null;
  dispatched_at: string | null;
  dispatch_error: string | null;
};

export default function AdminDecisionsPage() {
  return <Body />;
}

function Body() {
  const [rows, setRows] = useState<DecisionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("status");
    if (s) setStatus(s);
  }, []);
  const [klass, setKlass] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams();
        if (status) qs.set("status", status);
        if (klass) qs.set("decision_class", klass);
        qs.set("limit", "100");
        const res = await adminApiFetch(`/api/admin/decisions?${qs.toString()}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setRows((r.decisions ?? []) as DecisionRow[]);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, klass]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
            Zavi · admin
          </div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Decisions</h1>
        </div>
        <div className="flex items-center gap-2">
          <input
            placeholder="status (proposed|approved|…)"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm w-52"
          />
          <input
            placeholder="decision_class"
            value={klass}
            onChange={(e) => setKlass(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm w-52"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {rows === null ? (
        <div className="text-sm text-slate-500">Loading decisions…</div>
      ) : rows.length === 0 ? (
        <div className="glass-card border-dashed p-8 text-sm text-slate-600 text-center">
          No decisions match.
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Emitted</th>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-left px-3 py-2.5">Class</th>
                <th className="text-left px-3 py-2.5">Status</th>
                <th className="text-left px-3 py-2.5">Autonomy</th>
                <th className="text-left px-3 py-2.5">Handler</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm whitespace-nowrap">
                    {new Date(d.emitted_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-600 text-sm">
                    {d.tenant_id.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/decisions/${d.id}`}
                      className="text-slate-900 hover:underline"
                    >
                      {d.decision_class}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{d.status}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {d.autonomy_at_emit ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{d.handler ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
