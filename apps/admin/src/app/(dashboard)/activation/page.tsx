"use client";

import { useEffect, useMemo, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Stage =
  | "needs_onboarding"
  | "needs_connector"
  | "needs_first_run"
  | "needs_approval"
  | "activated";

type TenantRow = {
  tenant_id: string;
  slug: string;
  display_name: string;
  kind: string | null;
  created_at: string;
  brain_seeded: boolean;
  connectors_count: number;
  runs: number;
  approval_acted: boolean;
  first_deliverable_at: string | null;
  last_active_at: string | null;
  activated: boolean;
  activation_stage: Stage;
  days_in_stage: number | null;
  time_to_value_hours: number | null;
};

type ActivationResp = {
  window_days: number;
  kind: string;
  totals: {
    tenants: number;
    activated: number;
    activation_rate: number | null;
    median_time_to_value_hours: number | null;
  };
  funnel: Record<string, number>;
  by_stage: Record<Stage, number>;
  tenants: TenantRow[];
};

const FUNNEL_STEPS: Array<[string, string]> = [
  ["signed_up", "Signed up"],
  ["brain_seeded", "Brain seeded"],
  ["connected", "Connected a tool"],
  ["ran_agent", "Ran an agent"],
  ["acted_approval", "Acted on a proposal"],
  ["activated", "Activated"],
];

const STAGE_LABEL: Record<Stage, string> = {
  needs_onboarding: "Needs onboarding",
  needs_connector: "Needs a connector",
  needs_first_run: "Needs first run",
  needs_approval: "Needs to act on a proposal",
  activated: "Activated",
};

const STAGE_TONE: Record<Stage, string> = {
  needs_onboarding: "bg-rose-100 text-rose-700",
  needs_connector: "bg-amber-100 text-amber-800",
  needs_first_run: "bg-amber-100 text-amber-800",
  needs_approval: "bg-blue-100 text-blue-700",
  activated: "bg-emerald-100 text-emerald-700",
};

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const d = Math.floor(hrs / 24);
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}

export default function ActivationPage() {
  const [data, setData] = useState<ActivationResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [win, setWin] = useState<30 | 60 | 90>(60);
  const [kind, setKind] = useState<"real" | "all">("real");

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/activation?window=${win}&kind=${kind}`);
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setData(r as ActivationResp);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [win, kind]);

  const stuck = useMemo(
    () =>
      (data?.tenants ?? [])
        .filter((t) => !t.activated)
        .sort((a, b) => (b.days_in_stage ?? 0) - (a.days_in_stage ?? 0)),
    [data],
  );

  const funnelTop = data?.funnel?.signed_up ?? 0;

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5">
        <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Activation</h1>
        <p className="text-sm text-slate-500 mt-1">
          New tenants over the last {win} days — how far they get to first value (ran an agent + acted on a
          proposal), and who is stuck.
        </p>
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-sm">
          {([30, 60, 90] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWin(w)}
              className={`px-3 py-1.5 border-l first:border-l-0 border-slate-300 ${
                win === w ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {w}d
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden text-sm">
          {(["real", "all"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`px-3 py-1.5 border-l first:border-l-0 border-slate-300 ${
                kind === k ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {k === "real" ? "Real" : "All"}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">
          {error}
        </div>
      )}
      {!data && !error && <div className="text-sm text-slate-500">Loading…</div>}

      {data && (
        <>
          {}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <Tile label="New tenants" value={String(data.totals.tenants)} />
            <Tile label="Activated" value={String(data.totals.activated)} />
            <Tile
              label="Activation rate"
              value={
                data.totals.activation_rate == null
                  ? "—"
                  : `${Math.round(data.totals.activation_rate * 100)}%`
              }
            />
            <Tile
              label="Median time-to-value"
              value={
                data.totals.median_time_to_value_hours == null
                  ? "—"
                  : fmtHours(data.totals.median_time_to_value_hours)
              }
            />
          </div>

          {}
          <h2 className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">
            Funnel
          </h2>
          <div className="rounded-xl border border-slate-200 bg-white p-4 mb-6 space-y-2">
            {FUNNEL_STEPS.map(([key, label], i) => {
              const n = data.funnel[key] ?? 0;
              const pct = funnelTop > 0 ? Math.round((n / funnelTop) * 100) : 0;
              const prev = i > 0 ? data.funnel[FUNNEL_STEPS[i - 1][0]] ?? 0 : n;
              const dropped = prev - n;
              return (
                <div key={key} className="flex items-center gap-3">
                  <div className="w-40 shrink-0 text-sm text-slate-700">{label}</div>
                  <div className="flex-1 h-6 rounded bg-slate-100 overflow-hidden">
                    <div
                      className="h-full bg-slate-800 flex items-center justify-end pr-2 text-sm font-mono text-white"
                      style={{ width: `${Math.max(pct, 3)}%` }}
                    >
                      {n}
                    </div>
                  </div>
                  <div className="w-24 shrink-0 text-right text-sm font-mono text-slate-500">
                    {pct}%{i > 0 && dropped > 0 ? ` · -${dropped}` : ""}
                  </div>
                </div>
              );
            })}
          </div>

          {}
          <h2 className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">
            Stuck tenants · {stuck.length}
          </h2>
          {stuck.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
              No stuck tenants in this window — everyone activated. 🎉
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.08em]">
                  <tr>
                    <th className="text-left px-4 py-2.5">Tenant</th>
                    <th className="text-left px-3 py-2.5">Stuck at</th>
                    <th className="text-right px-3 py-2.5">Days stuck</th>
                    <th className="text-right px-3 py-2.5">Conn</th>
                    <th className="text-right px-3 py-2.5">Runs</th>
                    <th className="text-right px-3 py-2.5">Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {stuck.map((t) => (
                    <tr key={t.tenant_id} className="border-t border-slate-100">
                      <td className="px-4 py-2.5">
                        <a href={`/tenants/${t.tenant_id}`} className="text-slate-900 hover:underline">
                          {t.slug}
                        </a>
                        <div className="text-sm text-slate-500 truncate max-w-[200px]">
                          {t.display_name}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-xs ${STAGE_TONE[t.activation_stage]}`}
                        >
                          {STAGE_LABEL[t.activation_stage]}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-700">
                        {t.days_in_stage == null ? "—" : `${t.days_in_stage}d`}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-600">{t.connectors_count}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-600">{t.runs}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-sm text-slate-500">
                        {relTime(t.last_active_at)}
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

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-xs uppercase tracking-[0.12em] text-slate-400">{label}</div>
      <div className="mt-1 text-xl font-display font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
