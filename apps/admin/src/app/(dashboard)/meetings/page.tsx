"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Meeting = {
  tenant_id: string;
  tenant: string;
  status: string;
  platform: string;
  source: string;
  atoms: number;
  transcript_chars: number;
  scheduled_for: string | null;
  created_at: string | null;
};
type Resp = { meetings: Meeting[]; summary: { total: number; failed: number; in_progress: number } };

const BADGE: Record<string, string> = {
  ingested: "bg-emerald-100 text-emerald-800",
  call_ended: "bg-sky-100 text-sky-800",
  processing: "bg-amber-100 text-amber-800",
  in_call: "bg-amber-100 text-amber-800",
  joining: "bg-amber-100 text-amber-800",
  scheduled: "bg-slate-100 text-slate-600",
  failed: "bg-rose-100 text-rose-800",
  cancelled: "bg-slate-100 text-slate-600",
};

export default function AdminMeetingsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/meetings-ops");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Meetings / Notetaker ops</h1>
        <p className="text-sm text-slate-500 mt-1">
          Recent meeting bots and their distill status. Catch a bot that failed to join or a meeting that distilled zero atoms.
        </p>
      </div>

      {data && (
        <div className="flex gap-3 mb-4">
          <Stat label="Recent bots" value={data.summary.total} tone="slate" />
          <Stat label="In progress" value={data.summary.in_progress} tone="amber" />
          <Stat label="Failed" value={data.summary.failed} tone="rose" />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.meetings.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No meeting bots yet.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-left px-3 py-2.5">Platform</th>
                <th className="text-left px-3 py-2.5">Source</th>
                <th className="text-right px-3 py-2.5">Atoms</th>
                <th className="text-right px-3 py-2.5">Transcript</th>
                <th className="text-left px-3 py-2.5">Scheduled</th>
                <th className="text-left px-3 py-2.5">Created</th>
                <th className="text-left px-3 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.meetings.map((m, i) => (
                <tr key={`${m.tenant_id}::${m.created_at ?? i}::${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-700">
                    <Link href={`/tenants/${m.tenant_id}`} className="hover:underline">{m.tenant}</Link>
                  </td>
                  <td className="px-3 py-2 text-slate-900">{m.platform}</td>
                  <td className="px-3 py-2 text-slate-600">{m.source}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{m.atoms}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-500 text-sm">
                    {m.transcript_chars.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {m.scheduled_for ? new Date(m.scheduled_for).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {m.created_at ? new Date(m.created_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-medium " + (BADGE[m.status] ?? "bg-slate-100 text-slate-600")}>
                      {m.status.replace(/_/g, " ")}
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
