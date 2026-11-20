"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Row = {
  tenant_id: string;
  display_name: string | null;
  slug: string | null;
  cost_24h: number;
  avg_daily_7d: number;
  x_multiple: number | null;
  spike: boolean;
  top_absolute: boolean;
  flag: string;
};
type Resp = { tenants: Row[] };

const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function AdminCostAnomalyPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/cost-anomaly");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Cost anomalies</h1>
        <p className="text-sm text-slate-500 mt-1">
          Tenants whose last-24h spend is ≥3× their prior-7-day daily average, or in the top 10 by absolute 24h spend.
          Highest 24h cost on top.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.tenants.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No cost anomalies in the last 24 hours.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-right px-3 py-2.5">Cost 24h</th>
                <th className="text-right px-3 py-2.5">Avg daily 7d</th>
                <th className="text-right px-3 py-2.5">×</th>
                <th className="text-right px-3 py-2.5">Flag</th>
              </tr>
            </thead>
            <tbody>
              {data.tenants.map((t) => (
                <tr key={t.tenant_id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-900">
                    <div className="font-medium">{t.display_name ?? "—"}</div>
                    <div className="text-xs text-slate-400">{t.slug ?? t.tenant_id}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-900">{usd(t.cost_24h)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{usd(t.avg_daily_7d)}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {t.x_multiple == null ? (
                      <span className="text-slate-400" title="No prior-7d spend">new</span>
                    ) : (
                      <span className={t.x_multiple >= 3 ? "text-rose-700 font-semibold" : "text-slate-600"}>
                        {t.x_multiple}×
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {t.spike ? (
                      <span className="text-rose-700 font-semibold">spike</span>
                    ) : t.top_absolute ? (
                      <span className="text-amber-700">top-spend</span>
                    ) : (
                      <span className="text-slate-400">—</span>
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
