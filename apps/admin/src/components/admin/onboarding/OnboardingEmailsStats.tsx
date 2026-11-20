"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

export type EmailStep = { step: number; label: string; sent: number; visits: number; acted: number };
export type EmailStatsResp = {
  steps: EmailStep[];
  denominator: { people_in_sequence: number; excludes: string; acted_means: string };
};

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "–");

export function OnboardingEmailsTable({ data }: { data: EmailStatsResp }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
          <tr>
            <th className="text-left px-3 py-2.5">Email</th>
            <th className="text-right px-3 py-2.5">Sent</th>
            <th className="text-right px-3 py-2.5">Came back</th>
            <th className="text-right px-3 py-2.5">Acted within 2 days</th>
          </tr>
        </thead>
        <tbody>
          {data.steps.map((s) => (
            <tr key={s.step} className="border-t border-slate-100">
              <td className="px-3 py-2 text-slate-900">
                <span className="font-mono text-slate-500 mr-2">{s.step}</span>
                {s.label}
              </td>
              <td className="px-3 py-2 text-right font-mono">{s.sent}</td>
              <td className="px-3 py-2 text-right font-mono">
                {s.visits} <span className="text-slate-400">({pct(s.visits, s.sent)})</span>
              </td>
              <td className="px-3 py-2 text-right font-mono">
                {s.acted} <span className="text-slate-400">({pct(s.acted, s.visits)})</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100">
        {data.denominator.people_in_sequence} people in the sequence. Excludes {data.denominator.excludes}. Acted ={" "}
        {data.denominator.acted_means}.
      </p>
    </div>
  );
}

export function OnboardingEmailsStats() {
  const [data, setData] = useState<EmailStatsResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApiFetch("/api/admin/onboarding-emails-stats");
        const r = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(r?.error?.message ?? `HTTP ${res.status}`);
        if (!cancelled) setData(r as EmailStatsResp);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="mt-8">
      <h2 className="font-display font-semibold text-lg text-slate-900">Onboarding emails</h2>
      <p className="text-sm text-slate-500 mt-1 mb-3">Per email: sent, came back through its button, and acted within 2 days.</p>
      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</div>
      ) : !data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <OnboardingEmailsTable data={data} />
      )}
    </section>
  );
}
