"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Status = "active" | "trialing" | "past_due" | "canceled" | "incomplete";

type Sub = {
  tenant_id: string;
  tenant: string;
  slug: string;
  plan: string;
  status: Status;
  grandfathered: boolean;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  credit_balance: number | null;
};
type Resp = {
  subscriptions: Sub[];
  summary: { total: number; past_due: number; canceled: number; trialing: number };
};

const BADGE: Record<Status, string> = {
  active: "bg-emerald-100 text-emerald-800",
  trialing: "bg-amber-100 text-amber-800",
  past_due: "bg-rose-100 text-rose-800",
  canceled: "bg-rose-100 text-rose-800",
  incomplete: "bg-slate-100 text-slate-600",
};

export default function AdminBillingPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/billing");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Billing &amp; subscriptions</h1>
        <p className="text-sm text-slate-500 mt-1">
          Every tenant&apos;s plan, status, and credit balance — read-only. Problem accounts (past due / canceled) first.
        </p>
      </div>

      {data && (
        <div className="flex gap-3 mb-4">
          <Stat label="Total" value={data.summary.total} tone="slate" />
          <Stat label="Past due" value={data.summary.past_due} tone="rose" />
          <Stat label="Canceled" value={data.summary.canceled} tone="rose" />
          <Stat label="Trialing" value={data.summary.trialing} tone="amber" />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.subscriptions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No subscriptions.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-left px-3 py-2.5">Plan</th>
                <th className="text-left px-3 py-2.5">Status</th>
                <th className="text-left px-3 py-2.5">Renews</th>
                <th className="text-right px-3 py-2.5">Credit balance</th>
              </tr>
            </thead>
            <tbody>
              {data.subscriptions.map((s, i) => (
                <tr key={`${s.tenant_id}::${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-700">
                    <Link href={`/tenants/${s.tenant_id}`} className="hover:underline">{s.tenant}</Link>
                  </td>
                  <td className="px-3 py-2 text-slate-900">
                    {s.plan}
                    {s.grandfathered && (
                      <span className="ml-1.5 inline-block rounded px-1 py-0.5 text-xs font-medium bg-indigo-100 text-indigo-700 align-middle">
                        grandfathered
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-medium " + BADGE[s.status]}>
                      {s.status.replace("_", " ")}
                    </span>
                    {s.cancel_at_period_end && s.status !== "canceled" && (
                      <span className="ml-1.5 text-xs text-rose-600">cancels at period end</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {s.current_period_end ? new Date(s.current_period_end).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-700">
                    {s.credit_balance == null ? "—" : s.credit_balance.toLocaleString()}
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
