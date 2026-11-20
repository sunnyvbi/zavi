"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Entry = {
  at: string;
  event_id: string;
  type: string;
  tenant_id: string | null;
  amount: string | null;
  status: string | null;
};
type Resp = { entries: Entry[] };

export default function AdminDisputesPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/disputes");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Disputes</h1>
        <p className="text-sm text-slate-500 mt-1">
          Stripe chargeback/dispute webhook events, newest first. Read-only — this view never submits
          evidence, challenges, or refunds. Tenant and amount are not recorded on the dispute event ledger,
          so those columns show “—”.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No disputes recorded.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">When</th>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-left px-3 py-2.5">Dispute event</th>
                <th className="text-left px-3 py-2.5">Amount</th>
                <th className="text-left px-3 py-2.5">Status</th>
                <th className="text-left px-3 py-2.5">Event ID</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e, i) => (
                <tr key={`${e.event_id}::${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm whitespace-nowrap">
                    {new Date(e.at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {e.tenant_id ? (
                      <Link href={`/tenants/${e.tenant_id}`} className="hover:underline">{e.tenant_id.slice(0, 8)}</Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-900">{e.type}</td>
                  <td className="px-3 py-2 text-slate-700 whitespace-nowrap">{e.amount ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-600 text-sm">{e.status ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm max-w-[220px] truncate" title={e.event_id}>
                    {e.event_id}
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
