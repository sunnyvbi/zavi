"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Sched = {
  tenant_id: string;
  agent_slug: string;
  cron_expression: string;
  enabled: boolean;
  last_fired_at: string | null;
  runs_24h_ok: number;
  runs_24h_fail: number;
};

type Resp = { schedules: Sched[]; inngest_dashboard_url: string };

export default function AdminCronsPage() {
  return <Body />;
}

function Body() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/crons");
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setData(r as Resp);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
            Zavi · admin
          </div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Crons</h1>
          <p className="text-sm text-slate-500 mt-1">
            Scheduled agent runs. For Inngest function metrics (next-fire, retries, lag),
            <a
              href={data?.inngest_dashboard_url ?? "https://app.inngest.com"}
              target="_blank"
              rel="noopener"
              className="ml-1 underline text-slate-700 hover:text-slate-900"
            >
              open the Inngest dashboard ↗
            </a>
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.schedules.length === 0 ? (
        <div className="glass-card border-dashed p-8 text-sm text-slate-600 text-center">
          No scheduled agents.
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Tenant</th>
                <th className="text-left px-3 py-2.5">Agent</th>
                <th className="text-left px-3 py-2.5">Cron</th>
                <th className="text-left px-3 py-2.5">Enabled</th>
                <th className="text-left px-3 py-2.5">Last fired</th>
                <th className="text-right px-3 py-2.5">24h ok / fail</th>
              </tr>
            </thead>
            <tbody>
              {data.schedules.map((s) => (
                <tr
                  key={`${s.tenant_id}::${s.agent_slug}`}
                  className="border-t border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-3 py-2 font-mono text-slate-700">
                    <Link href={`/tenants/${s.tenant_id}`} className="hover:underline">
                      {s.tenant_id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-900">{s.agent_slug}</td>
                  <td className="px-3 py-2 font-mono text-slate-600">{s.cron_expression}</td>
                  <td className="px-3 py-2 font-mono text-slate-600">
                    {s.enabled ? "✓" : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {s.last_fired_at
                      ? new Date(s.last_fired_at).toLocaleString()
                      : "never"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    <span className="text-emerald-700">{s.runs_24h_ok}</span>
                    <span className="text-slate-300"> / </span>
                    <span className={s.runs_24h_fail > 0 ? "text-rose-700" : "text-slate-400"}>
                      {s.runs_24h_fail}
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
