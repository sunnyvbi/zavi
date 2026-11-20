"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type ErrRow = {
  id: string;
  tenant_id: string;
  agent_slug: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

export default function AdminErrorsPage() {
  return <Body />;
}

function Body() {
  const [rows, setRows] = useState<ErrRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/errors?hours=${hours}&limit=200`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setRows((r.errors ?? []) as ErrRow[]);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hours]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
            Zavi · admin
          </div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Errors</h1>
        </div>
        <select
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        >
          <option value={1}>1h</option>
          <option value={6}>6h</option>
          <option value={24}>24h</option>
          <option value={72}>72h</option>
          <option value={168}>7d</option>
        </select>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {rows === null ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-emerald-300 bg-emerald-50 p-8 text-sm text-emerald-800 text-center">
          No errors in window.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="rounded-xl border border-rose-100 bg-white p-3 text-sm"
            >
              <div className="flex items-center gap-3 mb-1">
                <Link
                  href={`/runs/${r.id}`}
                  className="text-slate-900 hover:underline"
                >
                  {r.agent_slug}
                </Link>
                <span className="rounded-full bg-rose-50 text-rose-800 border border-rose-200 px-2 py-0.5 text-xs">
                  {r.status}
                </span>
                <span className="font-mono text-slate-500 text-sm">
                  tenant:{r.tenant_id.slice(0, 8)}
                </span>
                <span className="ml-auto font-mono text-slate-500 text-sm">
                  {r.finished_at
                    ? new Date(r.finished_at).toLocaleString()
                    : r.started_at
                      ? new Date(r.started_at).toLocaleString()
                      : "—"}
                </span>
              </div>
              {r.error && (
                <pre className="text-sm font-mono whitespace-pre-wrap break-words text-rose-900 max-h-24 overflow-hidden">
                  {r.error}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
