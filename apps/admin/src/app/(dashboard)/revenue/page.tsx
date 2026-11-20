"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Totals = {
  active: number;
  trialing: number;
  past_due: number;
  canceled: number;
  incomplete: number;
  grandfathered: number;
  total: number;
};
type PlanRow = {
  plan: string;
  active: number;
  trialing: number;
  past_due: number;
  grandfathered: number;
  total: number;
};
type Resp = {
  totals: Totals;
  by_plan: PlanRow[];
  mrr_available: boolean;
  note: string;
};

export default function AdminRevenuePage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/revenue");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Revenue / plan mix</h1>
        <p className="text-sm text-slate-500 mt-1">
          Subscription counts by plan and status across all tenants. Read-only view of stored rows.
        </p>
      </div>

      {data && (
        <div className="flex flex-wrap gap-3 mb-4">
          <Stat label="Active" value={data.totals.active} tone="emerald" />
          <Stat label="Trialing" value={data.totals.trialing} tone="slate" />
          <Stat label="Past due" value={data.totals.past_due} tone="rose" />
          <Stat label="Grandfathered" value={data.totals.grandfathered} tone="slate" />
          <Stat label="Total subs" value={data.totals.total} tone="slate" />
        </div>
      )}

      {data && !data.mrr_available && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 mb-4">
          {data.note}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.by_plan.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No subscription rows.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Plan</th>
                <th className="text-right px-3 py-2.5">Active</th>
                <th className="text-right px-3 py-2.5">Trialing</th>
                <th className="text-right px-3 py-2.5">Past due</th>
                <th className="text-right px-3 py-2.5">Grandfathered</th>
                <th className="text-right px-3 py-2.5">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.by_plan.map((p) => (
                <tr key={p.plan} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-900">{p.plan}</td>
                  <td className="px-3 py-2 text-right font-mono text-emerald-700">{p.active}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{p.trialing}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {p.past_due > 0 ? (
                      <span className="text-rose-700 font-semibold">{p.past_due}</span>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{p.grandfathered}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-900">{p.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "slate" | "emerald" | "rose" }) {
  const c = tone === "rose" ? "text-rose-700" : tone === "emerald" ? "text-emerald-700" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 min-w-[110px]">
      <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className={"font-display font-semibold text-xl mt-0.5 " + c}>{value}</div>
    </div>
  );
}
