"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Conn = {
  tenant_id: string;
  tenant: string;
  slug: string;
  team_name: string | null;
  scopes: number;
  connected_at: string | null;
  token_expires_at: string | null;
  status: "ok" | "expiring" | "expired" | "no_expiry";
};
type Resp = { connectors: Conn[]; summary: { total: number; expired: number; expiring: number } };

const BADGE: Record<Conn["status"], string> = {
  expired: "bg-rose-100 text-rose-800",
  expiring: "bg-amber-100 text-amber-800",
  no_expiry: "bg-slate-100 text-slate-600",
  ok: "bg-emerald-100 text-emerald-800",
};

export default function AdminConnectorsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/connectors-health");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Connectors health</h1>
        <p className="text-sm text-slate-500 mt-1">
          Every tenant connector, needs-reconnect first. Catch an expiring token before it walls an agent run.
        </p>
      </div>

      {data && (
        <div className="flex gap-3 mb-4">
          <Stat label="Total" value={data.summary.total} tone="slate" />
          <Stat label="Expiring ≤7d" value={data.summary.expiring} tone="amber" />
          <Stat label="Expired" value={data.summary.expired} tone="rose" />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.connectors.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No connectors.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-left px-3 py-2.5">Connector</th>
                <th className="text-left px-3 py-2.5">Workspace</th>
                <th className="text-right px-3 py-2.5">Scopes</th>
                <th className="text-left px-3 py-2.5">Connected</th>
                <th className="text-left px-3 py-2.5">Expires</th>
                <th className="text-left px-3 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.connectors.map((c, i) => (
                <tr key={`${c.tenant_id}::${c.slug}::${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-700">
                    <Link href={`/tenants/${c.tenant_id}`} className="hover:underline">{c.tenant}</Link>
                  </td>
                  <td className="px-3 py-2 text-slate-900">{c.slug}</td>
                  <td className="px-3 py-2 text-slate-600">{c.team_name || "—"}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{c.scopes}</td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {c.connected_at ? new Date(c.connected_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {c.token_expires_at ? new Date(c.token_expires_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-medium " + BADGE[c.status]}>
                      {c.status.replace("_", " ")}
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
