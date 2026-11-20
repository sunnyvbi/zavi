"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

type Cohort = {
  week: string;
  week_start: string;
  signups: number;
  activated: number;
  activation_pct: number;
};
type Resp = {
  cohorts: Cohort[];
  summary: { cohorts: number; signups: number; activated: number; activation_pct: number };
};

function pctTone(p: number): string {
  if (p >= 60) return "bg-emerald-100 text-emerald-800";
  if (p >= 30) return "bg-amber-100 text-amber-800";
  return "bg-rose-100 text-rose-800";
}

export default function AdminCohortsPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/cohorts");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Cohorts &amp; retention</h1>
        <p className="text-sm text-slate-500 mt-1">
          Signups bucketed by the ISO week they joined. Activated = the cohort ran at least one agent. Last 12 weeks, newest first.
        </p>
      </div>

      {data && (
        <div className="flex gap-3 mb-4">
          <Stat label="Cohorts" value={data.summary.cohorts} tone="slate" />
          <Stat label="Signups" value={data.summary.signups} tone="slate" />
          <Stat label="Activated" value={data.summary.activated} tone="emerald" />
          <Stat label="Activation %" value={data.summary.activation_pct} tone="emerald" suffix="%" />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.cohorts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No cohorts yet.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Cohort (ISO week)</th>
                <th className="text-left px-3 py-2.5">Week of</th>
                <th className="text-right px-3 py-2.5">Signups</th>
                <th className="text-right px-3 py-2.5">Activated</th>
                <th className="text-left px-3 py-2.5">Activation</th>
              </tr>
            </thead>
            <tbody>
              {data.cohorts.map((c) => (
                <tr key={c.week} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-slate-900">{c.week}</td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {new Date(c.week_start).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-700">{c.signups}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-700">{c.activated}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className={"inline-block rounded px-1.5 py-0.5 text-xs font-medium " + pctTone(c.activation_pct)}>
                        {c.activation_pct}%
                      </span>
                      <div className="h-1.5 w-24 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-emerald-400"
                          style={{ width: `${Math.min(100, Math.max(0, c.activation_pct))}%` }}
                        />
                      </div>
                    </div>
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

function Stat({
  label,
  value,
  tone,
  suffix,
}: {
  label: string;
  value: number;
  tone: "slate" | "emerald";
  suffix?: string;
}) {
  const c = tone === "emerald" ? "text-emerald-700" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 min-w-[110px]">
      <div className="text-xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
      <div className={"font-display font-semibold text-xl mt-0.5 " + c}>
        {value}
        {suffix ?? ""}
      </div>
    </div>
  );
}
