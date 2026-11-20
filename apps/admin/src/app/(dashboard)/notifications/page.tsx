"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Entry = {
  at: string;
  channel: "email" | "slack";
  tenant_id: string | null;
  subject_or_summary: string | null;
  status: string;
};
type Resp = { entries: Entry[] };

const CHANNEL: Record<Entry["channel"], string> = {
  email: "bg-sky-100 text-sky-700",
  slack: "bg-violet-100 text-violet-700",
};

function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "sent") return "bg-emerald-100 text-emerald-700";
  if (s === "failed") return "bg-rose-100 text-rose-700";
  if (s === "skipped") return "bg-slate-100 text-slate-600";
  return "bg-amber-100 text-amber-800";
}

export default function AdminNotificationsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/notifications-log");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Notifications log</h1>
        <p className="text-sm text-slate-500 mt-1">
          Outbound email + Slack sends — merged, newest first.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No notifications.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">When</th>
                <th className="text-left px-3 py-2.5">Channel</th>
                <th className="text-left px-3 py-2.5">Subject / summary</th>
                <th className="text-left px-3 py-2.5">Status</th>
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
                    <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-medium " + CHANNEL[e.channel]}>
                      {e.channel}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-600 text-sm max-w-[360px] truncate" title={e.subject_or_summary ?? ""}>
                    {e.subject_or_summary ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-medium " + statusClass(e.status)}>
                      {e.status}
                    </span>
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
