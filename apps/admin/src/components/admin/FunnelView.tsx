"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SignupCreditCosts } from "./SignupCreditCosts";
import { adminApiFetch } from "@/lib/api-admin";

type Source = { source: string; kind: string; creator_id?: string };

type Row = {
  tenant_id: string;
  source?: Source;
  signed_up_at: string;
  first_run_at: string | null;
  first_feedback_at: string | null;
};

export type FunnelData = {
  sources: (Source & { signups: number })[];
  windowDays: number; since: string; until: string; includeInternal: boolean; excluded: number;
  totals: { signed_up: number; ran: number; gave_feedback: number };
  rows: Row[];
};

export function FunnelView({ initialData }: { initialData?: FunnelData }) {
  const [data, setData] = useState<FunnelData | null>(initialData ?? null);
  const [days, setDays] = useState(initialData?.windowDays ?? 30);
  const [includeInternal, setIncludeInternal] = useState(initialData?.includeInternal ?? false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/funnel?days=${days}&include_internal=${includeInternal ? "1" : "0"}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setData(r as FunnelData);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days, includeInternal]);

  function pct(n: number, d: number) {
    if (d === 0) return "0%";
    return `${Math.round((n / d) * 100)}%`;
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-sky-700">
          Zavi · admin
        </div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Funnel</h1>
        <p className="text-sm text-slate-500 mt-1">
          signup → first agent run → first feedback
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-4 text-sm">
        <label>Signup window <select aria-label="Signup window" value={days} onChange={e => setDays(Number(e.target.value))} className="ml-2 rounded border px-2 py-1">
          {[7, 30, 90].map(n => <option key={n} value={n}>Last {n} days</option>)}
        </select></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={includeInternal} onChange={e => setIncludeInternal(e.target.checked)} />Include test and internal workspaces</label>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}

      {!data && !error ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data ? (
        <>
          <p className="mb-4 text-sm text-slate-600">One signup per workspace created or first claimed in the last {data.windowDays} days. {data.includeInternal ? "Includes test and internal workspaces. Unclaimed video workspaces are excluded." : `${data.excluded} test, internal or unclaimed video workspaces excluded.`}</p>
          <div className="grid grid-cols-1 gap-3 mb-6 sm:grid-cols-3">
            <Step label="Signed up" count={data.totals.signed_up} />
            <Step
              label="First run"
              count={data.totals.ran}
              note={pct(data.totals.ran, data.totals.signed_up) + " of signups"}
            />
            <Step
              label="First feedback"
              count={data.totals.gave_feedback}
              note={pct(data.totals.gave_feedback, data.totals.ran) + " of first-run"}
            />
          </div>

          <section aria-labelledby="source-heading" className="mb-6">
            <h2 id="source-heading" className="font-display text-xl font-semibold">Signups by source</h2>
            <p className="mt-1 mb-3 text-sm text-slate-600">Recorded creator/affiliate referrals take precedence over channel code, UTM source, referring website or ad network. Unknown means no usable source was captured; it is not counted as direct.</p>
            <div className="glass-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white/50 text-slate-600"><tr><th className="px-3 py-2 text-left">Source</th><th className="px-3 py-2 text-left">Based on</th><th className="px-3 py-2 text-right">Signups</th></tr></thead>
                <tbody>{data.sources.map(row => <tr key={`${row.kind}:${row.creator_id ?? row.source}`} className="border-t border-slate-100">
                  <td className="px-3 py-2 break-words"><SourceName source={row} /></td>
                  <td className="px-3 py-2 text-slate-500">{sourceKindLabel(row.kind)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.signups}</td>
                </tr>)}</tbody>
                <tfoot><tr className="border-t font-semibold"><td colSpan={2} className="px-3 py-2">Total</td><td className="px-3 py-2 text-right tabular-nums">{data.totals.signed_up}</td></tr></tfoot>
              </table>
            </div>
          </section>

          {data.rows.length === 0 ? (
            <div className="glass-card border-dashed p-8 text-sm text-slate-600 text-center">
              No tenants yet.
            </div>
          ) : (
            <div className="glass-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white/50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-3 py-2.5">Tenant</th>
                    <th className="text-left px-3 py-2.5">Source</th>
                    <th className="text-left px-3 py-2.5">Signed up</th>
                    <th className="text-left px-3 py-2.5">First run</th>
                    <th className="text-left px-3 py-2.5">First feedback</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.tenant_id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2 font-mono text-slate-700">
                        <Link href={`/tenants/${r.tenant_id}`} className="hover:underline">
                          {r.tenant_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-3 py-2"><SourceName source={r.source ?? { source: "Unknown", kind: "unknown" }} /></td>
                      <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                        {new Date(r.signed_up_at).toLocaleDateString()}
                      </td>
                      <td className="px-3 py-2 font-mono text-sm">
                        {r.first_run_at ? (
                          <span className="text-slate-700">
                            {new Date(r.first_run_at).toLocaleDateString()}
                          </span>
                        ) : (
                          <span className="text-rose-700">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-sm">
                        {r.first_feedback_at ? (
                          <span className="text-slate-700">
                            {new Date(r.first_feedback_at).toLocaleDateString()}
                          </span>
                        ) : (
                          <span className="text-amber-700">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
      <SignupCreditCosts />
    </div>
  );
}

function Step({ label, count, note }: { label: string; count: number; note?: string }) {
  return (
    <div className="glass-card p-4">
      <div className="text-sm uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className="mt-1 font-display font-semibold text-3xl tabular-nums text-slate-900">
        {count}
      </div>
      {note && <div className="text-sm text-slate-500 mt-0.5">{note}</div>}
    </div>
  );
}

function SourceName({ source }: { source: Source }) {
  return source.kind === "affiliate" && source.creator_id
    ? <Link href={`/creator-network/creators/${encodeURIComponent(source.creator_id)}`} className="text-sky-700 hover:underline">{source.source} (affiliate) <span className="font-mono text-xs text-slate-500">· {source.creator_id.slice(0, 8)}</span></Link>
    : <>{source.source}</>;
}

function sourceKindLabel(kind: string): string {
  return ({affiliate: "Recorded creator referral", from: "Channel code", utm_source: "UTM source", referrer: "Referring website", ad_network: "Ad network", direct: "Captured landing without a source", unknown: "Source not captured"} as Record<string, string>)[kind] ?? kind;
}
