"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Entry = {
  at: string;
  actor: string;
  action: string;
  target: string | null;
  tenant_id: string | null;
  source: "staff" | "admin_task" | "tenant_config";
  on_behalf?: boolean;
};
type Resp = { entries: Entry[] };

const SRC: Record<Entry["source"], string> = {
  staff: "bg-slate-100 text-slate-700",
  admin_task: "bg-indigo-100 text-indigo-700",
  tenant_config: "bg-amber-100 text-amber-800",
};

export default function AdminAuditPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/audit-log");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Audit log</h1>
        <p className="text-sm text-slate-500 mt-1">
          Staff writes, admin-task actions, and per-tenant config flips — merged, newest first.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No audit entries.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">When</th>
                <th className="text-left px-3 py-2.5">Source</th>
                <th className="text-left px-3 py-2.5">Actor</th>
                <th className="text-left px-3 py-2.5">Action</th>
                <th className="text-left px-3 py-2.5">Target</th>
                <th className="text-left px-3 py-2.5">Tenant</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e, i) => (
                <tr key={`${e.at}::${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm whitespace-nowrap">
                    {new Date(e.at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-medium " + SRC[e.source]}>
                      {e.source.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {e.actor}
                    {e.on_behalf && <span className="ml-1 text-xs text-indigo-600">(on behalf)</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-900">{e.action}</td>
                  <td className="px-3 py-2 text-slate-600 text-sm max-w-[280px] truncate" title={e.target ?? ""}>
                    {e.target ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {e.tenant_id ? (
                      <Link href={`/tenants/${e.tenant_id}`} className="hover:underline">{e.tenant_id.slice(0, 8)}</Link>
                    ) : (
                      "—"
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
