"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Ws = {
  tenant_id: string;
  tenant: string;
  team_id: string;
  workspace: string;
  purpose: string;
  is_primary: boolean;
  scopes: number;
  channels: number;
  connected_at: string | null;
};
type Resp = { workspaces: Ws[]; summary: { total: number; tenants: number; primary: number } };

export default function AdminSlackWorkspacesPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/slack-workspaces");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Slack workspaces</h1>
        <p className="text-sm text-slate-500 mt-1">
          Every connected Slack install across tenants, grouped by tenant. Primary routing target first.
        </p>
      </div>

      {data && (
        <div className="flex gap-3 mb-4">
          <Stat label="Installs" value={data.summary.total} />
          <Stat label="Tenants" value={data.summary.tenants} />
          <Stat label="Primary" value={data.summary.primary} />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.workspaces.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No connected Slack workspaces.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-left px-3 py-2.5">Workspace</th>
                <th className="text-left px-3 py-2.5">Purpose</th>
                <th className="text-left px-3 py-2.5">Primary</th>
                <th className="text-right px-3 py-2.5">Scopes</th>
                <th className="text-right px-3 py-2.5">Channels</th>
                <th className="text-left px-3 py-2.5">Connected</th>
              </tr>
            </thead>
            <tbody>
              {data.workspaces.map((w, i) => (
                <tr key={`${w.tenant_id}::${w.team_id}::${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-700">
                    <Link href={`/tenants/${w.tenant_id}`} className="hover:underline">{w.tenant}</Link>
                  </td>
                  <td className="px-3 py-2 text-slate-900">{w.workspace}</td>
                  <td className="px-3 py-2 text-slate-600">{w.purpose}</td>
                  <td className="px-3 py-2">
                    {w.is_primary ? (
                      <span className="inline-block rounded px-1.5 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-800">
                        primary
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{w.scopes}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{w.channels}</td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {w.connected_at ? new Date(w.connected_at).toLocaleDateString() : "—"}
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 min-w-[110px]">
      <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="font-display font-semibold text-xl mt-0.5 text-slate-900">{value}</div>
    </div>
  );
}
