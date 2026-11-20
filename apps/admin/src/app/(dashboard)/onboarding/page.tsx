"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";
import { OnboardingEmailsStats } from "@/components/admin/onboarding/OnboardingEmailsStats";

type StuckRow = {
  actor: string;
  tenant_id: string | null;
  tenant: string;
  last_step: string;
  last_status: string;
  last_activity_at: string;
  age_minutes: number;
  events: number;
};
type Resp = {
  windowDays: number;
  stuckMinutes: number;
  since: string;
  summary: { stuck: number; incomplete: number };
  stuck: StuckRow[];
};

const STATUS_BADGE: Record<string, string> = {
  abandoned: "bg-rose-100 text-rose-800",
  entered: "bg-amber-100 text-amber-800",
  skipped: "bg-slate-100 text-slate-600",
  completed: "bg-emerald-100 text-emerald-800",
};

function ageLabel(mins: number): string {
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (60 * 24))}d`;
}

export default function AdminOnboardingPipelinePage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/onboarding-pipeline");
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
        <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Onboarding pipeline</h1>
        <p className="text-sm text-slate-500 mt-1">
          Everyone who started the activation wizard, never reached <span>activate</span>, and has
          gone quiet. Newest-stuck first — reach out before they go cold.
        </p>
      </div>

      {data && (
        <div className="flex gap-3 mb-4">
          <Stat label="Stuck" value={data.summary.stuck} tone="rose" />
          <Stat label="Incomplete (in-window)" value={data.summary.incomplete} tone="amber" />
          <Stat label={`Window ${data.windowDays}d · stale ≥${data.stuckMinutes}m`} value={data.stuck.length} tone="slate" />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 mb-4">{error}</div>
      )}

      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.stuck.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          Nobody stuck mid-onboarding right now.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
              <tr>
                <th className="text-left px-3 py-2.5">Tenant / user</th>
                <th className="text-left px-3 py-2.5">Last step</th>
                <th className="text-left px-3 py-2.5">Status</th>
                <th className="text-right px-3 py-2.5">Events</th>
                <th className="text-left px-3 py-2.5">Last activity</th>
                <th className="text-right px-3 py-2.5">Stuck for</th>
              </tr>
            </thead>
            <tbody>
              {data.stuck.map((r, i) => (
                <tr key={`${r.actor}::${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 text-slate-700">
                    {r.tenant_id ? (
                      <Link href={`/tenants/${r.tenant_id}`} className="hover:underline">{r.tenant}</Link>
                    ) : (
                      <span className="text-slate-500">{r.tenant}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-900">{r.last_step}</td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        "inline-block rounded px-1.5 py-0.5 text-xs font-medium " +
                        (STATUS_BADGE[r.last_status] ?? "bg-slate-100 text-slate-600")
                      }
                    >
                      {r.last_status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-600">{r.events}</td>
                  <td className="px-3 py-2 font-mono text-slate-500 text-sm">
                    {new Date(r.last_activity_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-rose-700 text-sm">{ageLabel(r.age_minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <OnboardingEmailsStats />
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
