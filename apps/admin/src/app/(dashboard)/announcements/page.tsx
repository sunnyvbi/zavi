"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Entry = {
  at: string;
  kind: string;
  audience: string | null;
  summary: string | null;
  status: string | null;
  count: number | null;
  source: "digest" | "comms";
};
type Resp = { entries: Entry[] };

const SRC: Record<Entry["source"], string> = {
  digest: "bg-indigo-100 text-indigo-700",
  comms: "bg-slate-100 text-slate-700",
};

const STATUS: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-700",
  blocked_content: "bg-rose-100 text-rose-700",
  skipped_low_signal: "bg-amber-100 text-amber-800",
};

export default function AdminAnnouncementsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/announcements");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Announcements</h1>
        <p className="text-sm text-slate-500 mt-1">
          History of tenant-wide broadcasts — digest / brief sends and outbound comms, merged, newest first.
        </p>
      </div>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 mb-4">
        Compose-and-send is intentionally not exposed here — broadcasts are a gated action fired by an operator.
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No broadcast history.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">When</th>
                <th className="text-left px-3 py-2.5">Source</th>
                <th className="text-left px-3 py-2.5">Kind</th>
                <th className="text-left px-3 py-2.5">Detail</th>
                <th className="text-left px-3 py-2.5">Status</th>
                <th className="text-right px-3 py-2.5">Count</th>
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
                      {e.source}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-900 text-sm">{e.kind}</td>
                  <td className="px-3 py-2 text-slate-600 text-sm max-w-[240px] truncate" title={e.summary ?? ""}>
                    {e.summary ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {e.status ? (
                      <span
                        className={
                          "inline-block rounded px-1.5 py-0.5 text-xs font-medium " +
                          (STATUS[e.status] ?? "bg-slate-100 text-slate-600")
                        }
                      >
                        {e.status.replace(/_/g, " ")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-700 text-sm">
                    {e.count ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {e.audience ? (
                      <Link href={`/tenants/${e.audience}`} className="hover:underline">
                        {e.audience.slice(0, 8)}
                      </Link>
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
