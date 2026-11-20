"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Flow = "fast" | "staged" | "edit";
type Pass = "first" | "repair" | "visual_fix";
type Tokens = { input: number; output: number; cache_read: number; cache_write: number };
type Bucket = { runs: number; usd: number; tokens: Tokens };
type Dist = { builds: number; avg: number; p50: number; p90: number; max: number; total: number };
type Build = {
  id: string;
  tenant_id: string;
  tenant_slug: string | null;
  created_at: string;
  status: string;
  flow: Flow;
  finished: boolean;
  usd: number;
  model_usd: number;
  tool_usd: number;
  image_usd: number;
  runs: number;
  passes: Record<Pass, number>;
  by_stage: Record<string, Bucket>;
  by_model: Record<string, Bucket>;
};
type Resp = {
  days: number;
  scope: "real" | "all";
  not_included: string[];
  totals: { builds: number; unfinished: number; usd: number; model_usd: number; tool_usd: number; image_usd: number; runs: number; cache_read_share: number | null };
  truncated: { builds: boolean; runs: boolean; images: boolean; tool_costs: boolean };
  per_build: Record<Flow, Dist | null>;
  by_stage: Array<{ stage: string; flow: Flow; pass: Pass } & Bucket>;
  by_model: Array<{ model: string } & Bucket>;
  builds: Build[];
};

const FLOW_LABEL: Record<Flow, string> = { fast: "Fast build", staged: "Staged build", edit: "Change" };
const PASS_LABEL: Record<Pass, string> = { first: "first pass", repair: "repair", visual_fix: "visual fix" };
const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
const mtok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

function DistCard({ flow, d }: { flow: Flow; d: Dist | null }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs uppercase tracking-[0.1em] text-slate-500">{FLOW_LABEL[flow]}</div>
      {d ? (
        <>
          <div className="mt-1 font-display text-2xl font-semibold text-slate-900">{usd(d.avg)}</div>
          <div className="mt-0.5 text-xs text-slate-500">
            avg of {d.builds} · p50 {usd(d.p50)} · p90 {usd(d.p90)} · max {usd(d.max)}
          </div>
        </>
      ) : (
        <div className="mt-1 text-sm text-slate-400">none in this window</div>
      )}
    </div>
  );
}

export default function AdminBuildCostsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const [scope, setScope] = useState<"real" | "all">("real");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/build-costs?days=${days}&scope=${scope}`);
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
  }, [days, scope]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Build cost</h1>
          <p className="text-sm text-slate-500 mt-1">Known model and image cost of each build and change, by flow, stage, model and pass.</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-md border border-slate-300 bg-white px-2 py-1.5">
            {[7, 14, 30, 90].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
          <select value={scope} onChange={(e) => setScope(e.target.value === "all" ? "all" : "real")} className="rounded-md border border-slate-300 bg-white px-2 py-1.5">
            <option value="real">Real workspaces</option>
            <option value="all">All, incl. test + dogfood</option>
          </select>
        </div>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>}

      {!data && !error ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data && data.totals.builds === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No builds with model cost in the last {data.days} days{data.scope === "real" ? " outside test and dogfood workspaces" : ""}.
        </div>
      ) : data ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 mb-3">
            {(["fast", "staged", "edit"] as Flow[]).map((f) => (
              <DistCard key={f} flow={f} d={data.per_build[f]} />
            ))}
          </div>
          {Object.values(data.truncated).some(Boolean) && (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Some rows hit the read cap ({Object.entries(data.truncated).filter(([, v]) => v).map(([k]) => k.replace("_", " ")).join(", ")}): totals are lower than the real
              window. Pick a shorter range.
            </div>
          )}
          <p className="mb-5 text-xs text-slate-500">
            {data.totals.builds} builds and changes ({data.totals.unfinished} still running, left out of the averages), {data.totals.runs} agent runs,{" "}
            {usd(data.totals.usd)} in total ({usd(data.totals.model_usd)} model, {usd(data.totals.tool_usd)} tools, {usd(data.totals.image_usd)} images). Cache reads are {data.totals.cache_read_share === null ? "—" : `${Math.round(data.totals.cache_read_share * 100)}%`} of input tokens. Not
            included: {data.not_included.join("; ")}.
          </p>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 mb-5">
            <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-3 py-2.5">Stage</th>
                    <th className="text-right px-3 py-2.5">Runs</th>
                    <th className="text-right px-3 py-2.5">Cost</th>
                    <th className="text-right px-3 py-2.5">Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_stage.map((s) => (
                    <tr key={`${s.flow}-${s.stage}-${s.pass}`} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-900">
                        {FLOW_LABEL[s.flow]} · {s.stage} <span className="text-slate-400">({PASS_LABEL[s.pass]})</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">{s.runs}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-900">{usd(s.usd)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">{usd(s.runs ? s.usd / s.runs : 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                  <tr>
                    <th className="text-left px-3 py-2.5">Model</th>
                    <th className="text-right px-3 py-2.5">Runs</th>
                    <th className="text-right px-3 py-2.5">Cost</th>
                    <th className="text-right px-3 py-2.5">Out / cache read</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_model.map((m) => (
                    <tr key={m.model} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-slate-900 font-mono text-xs">{m.model}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">{m.runs}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-900">{usd(m.usd)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">
                        {mtok(m.tokens.output)} / {mtok(m.tokens.cache_read)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                <tr>
                  <th className="text-left px-3 py-2.5">Build</th>
                  <th className="text-left px-3 py-2.5">Flow</th>
                  <th className="text-right px-3 py-2.5">Runs</th>
                  <th className="text-right px-3 py-2.5">Repairs</th>
                  <th className="text-right px-3 py-2.5">Images</th>
                  <th className="text-right px-3 py-2.5">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.builds.map((b) => (
                  <Fragment key={b.id}>
                    <tr className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setOpen(open === b.id ? null : b.id)}>
                      <td className="px-3 py-2">
                        <Link href={`/tenants/${b.tenant_id}`} className="text-slate-900 hover:underline" onClick={(e) => e.stopPropagation()}>
                          {b.tenant_slug ?? b.tenant_id.slice(0, 8)}
                        </Link>
                        <div className="text-xs text-slate-500">
                          {new Date(b.created_at).toLocaleString()} · <span className="font-mono">{b.id.slice(0, 8)}</span> · {b.status}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {FLOW_LABEL[b.flow]}
                        {!b.finished && <span className="ml-1 text-xs text-sky-700">(running)</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">{b.runs}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">{b.passes.repair + b.passes.visual_fix}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-600">{b.image_usd ? usd(b.image_usd) : "—"}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-900">{usd(b.usd)}</td>
                    </tr>
                    {open === b.id && (
                      <tr className="bg-slate-50">
                        <td colSpan={6} className="px-3 py-2 text-xs text-slate-600">
                          <div>
                            By stage:{" "}
                            {Object.entries(b.by_stage)
                              .map(([k, v]) => `${k} ${usd(v.usd)} (${v.runs})`)
                              .join(" · ")}
                          </div>
                          <div>
                            By model:{" "}
                            {Object.entries(b.by_model)
                              .map(([k, v]) => `${k} ${usd(v.usd)}, ${mtok(v.tokens.output)} out, ${mtok(v.tokens.cache_read)} cache read`)
                              .join(" · ")}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
