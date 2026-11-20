"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Health = "at_risk" | "watch" | "healthy";
type TenantHealth = {
  tenant_id: string;
  tenant: string;
  slug: string;
  created_at: string | null;
  runs_7d: number;
  failed_7d: number;
  fail_rate: number;
  cost_7d: number;
  health: Health;
};
type Resp = { tenants: TenantHealth[]; summary: { total: number; at_risk: number; watch: number } };

const BADGE: Record<Health, string> = {
  at_risk: "bg-rose-100 text-rose-800",
  watch: "bg-amber-100 text-amber-800",
  healthy: "bg-emerald-100 text-emerald-800",
};

export default function AdminTenantHealthPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/tenant-health");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Tenant health</h1>
        <p className="text-sm text-slate-500 mt-1">
          Composite health per tenant over the last 7 days, riskiest first. Catch a failing or gone-quiet tenant before churn.
        </p>
      </div>

      {data && (
        <div className="flex gap-3 mb-4">
          <Stat label="Total" value={data.summary.total} tone="slate" />
          <Stat label="Watch" value={data.summary.watch} tone="amber" />
          <Stat label="At risk" value={data.summary.at_risk} tone="rose" />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.tenants.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No tenants.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-right px-3 py-2.5">Runs 7d</th>
                <th className="text-right px-3 py-2.5">Failed 7d</th>
                <th className="text-right px-3 py-2.5">Fail rate</th>
                <th className="text-right px-3 py-2.5">Cost 7d</th>
                <th className="text-left px-3 py-2.5">Health</th>
              </tr>
            </thead>
            <tbody>
              {data.tenants.map((t) => (
                <tr key={t.tenant_id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-700">
                    <Link href={`/tenants/${t.tenant_id}`} className="hover:underline">{t.tenant}</Link>
                    <span className="ml-1.5 text-slate-400 text-xs">{t.slug}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{t.runs_7d}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{t.failed_7d}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{t.fail_rate}%</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500">${t.cost_7d.toFixed(2)}</td>
                  <td className="px-3 py-2">
                    <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-medium " + BADGE[t.health]}>
                      {t.health.replace("_", " ")}
                    </span>
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

function Stat({ label, value, tone }: { label: string; value: number; tone: "slate" | "amber" | "rose" }) {
  const c = tone === "rose" ? "text-rose-700" : tone === "amber" ? "text-amber-700" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 min-w-[110px]">
      <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className={"font-display font-semibold text-xl mt-0.5 " + c}>{value}</div>
    </div>
  );
}
