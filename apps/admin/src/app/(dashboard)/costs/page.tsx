"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Rollup = {
  tenant_id: string;
  agent_slug: string;
  runs: number;
  tokens: number;
  usd: number;
};

type Resp = {
  days: number;
  totals: { runs: number; tokens: number; usd: number };
  rollup: Rollup[];
};

export default function AdminCostsPage() {
  return <Body />;
}

function Body() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/costs?days=${days}`);
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
  }, [days]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
            Zavi · admin
          </div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Costs</h1>
        </div>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        >
          <option value={1}>1d</option>
          <option value={7}>7d</option>
          <option value={30}>30d</option>
          <option value={90}>90d</option>
        </select>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-6">
            <Total label={`Runs · ${data.days}d`} value={data.totals.runs.toLocaleString()} />
            <Total label="Tokens" value={data.totals.tokens.toLocaleString()} />
            <Total label="Spend" value={`$${data.totals.usd.toFixed(2)}`} />
          </div>

          {data.rollup.length === 0 ? (
            <div className="glass-card border-dashed p-8 text-sm text-slate-600 text-center">
              No runs in window.
            </div>
          ) : (
            <div className="glass-card overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-3 py-2.5">Tenant</th>
                    <th className="text-left px-3 py-2.5">Agent</th>
                    <th className="text-right px-3 py-2.5">Runs</th>
                    <th className="text-right px-3 py-2.5">Tokens</th>
                    <th className="text-right px-3 py-2.5">USD</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rollup.map((r) => (
                    <tr
                      key={`${r.tenant_id}::${r.agent_slug}`}
                      className="border-t border-slate-100 hover:bg-slate-50"
                    >
                      <td className="px-3 py-2 font-mono text-slate-700">
                        <Link
                          href={`/tenants/${r.tenant_id}`}
                          className="hover:underline"
                        >
                          {r.tenant_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-slate-900">{r.agent_slug}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">
                        {r.runs}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">
                        {r.tokens.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-900">
                        ${r.usd.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-card p-4">
      <div className="text-sm uppercase tracking-[0.14em] text-slate-500">
        {label}
      </div>
      <div className="mt-1 font-display font-semibold text-2xl tabular-nums text-slate-900">
        {value}
      </div>
    </div>
  );
}
