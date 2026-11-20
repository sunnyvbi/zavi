"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { adminApiFetch } from "@/lib/api-admin";

type Verdict = "failed" | "needs_review" | "clean" | "insufficient_data" | "in_progress";
type Build = {
  id: string;
  tenant_id: string;
  tenant_slug: string | null;
  site_id: string | null;
  created_at: string;
  status: string;
  objective: string | null;
  verdict: Verdict;
  reasons: string[];
  rating: -1 | 1 | null;
  rating_comment: string | null;
  changes: { total: number; rated: number; up: number; down: number };
  fidelity: { found: number; total: number; gross: boolean } | null;
  review: { status: string; qualifying: number; fix_outcome: string | null } | null;
  fix_passes: number;
};
type Resp = {
  days: number;
  scope: "real" | "all";
  summary: {
    builds: number;
    by_verdict: Record<Verdict, number>;
    rated: number;
    rated_good: number;
    good_share: number | null;
    good_share_low: number | null;
    change_ratings: { rated: number; up: number };
    checked: number;
    with_visible_defect: number;
    avg_fidelity: number | null;
  };
  recent_negative: Array<{ build_id: string; tenant_slug: string | null; comment: string }>;
  builds: Build[];
};

const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  failed: { label: "Failed", cls: "bg-rose-50 text-rose-800 border-rose-200" },
  needs_review: { label: "Needs review", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  insufficient_data: { label: "No signal", cls: "bg-slate-50 text-slate-600 border-slate-200" },
  in_progress: { label: "In progress", cls: "bg-sky-50 text-sky-800 border-sky-200" },
  clean: { label: "Clean", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" },
};

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="text-xs uppercase tracking-[0.1em] text-slate-500">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export default function AdminBuildQualityPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const [scope, setScope] = useState<"real" | "all">("real");

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    (async () => {
      try {
        const res = await adminApiFetch(`/api/admin/build-quality?days=${days}&scope=${scope}`);
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

  const s = data?.summary;
  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-rose-700">Zavi · admin</div>
          <h1 className="font-display font-semibold text-2xl text-slate-900 mt-1">Build quality</h1>
          <p className="text-sm text-slate-500 mt-1">
            Founder thumbs on builds and changes, next to the platform&apos;s own checks. Worst first.
          </p>
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
      ) : data && s && s.builds === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-sm text-slate-600 text-center">
          No builds in the last {data.days} days{data.scope === "real" ? " outside test and dogfood workspaces" : ""}.
        </div>
      ) : data && s ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 mb-5">
            <Stat
              label="Rated good"
              value={s.rated ? `${pct(s.good_share)} of ${s.rated}` : "No ratings"}
              hint={s.rated ? `at least ${pct(s.good_share_low)} (95% lower bound)` : "founders have not rated a build yet"}
            />
            <Stat label="Needs review" value={`${s.by_verdict.needs_review + s.by_verdict.failed} of ${s.builds}`} hint={`${s.by_verdict.failed} failed`} />
            <Stat label="Checked before publish" value={`${s.checked} of ${s.builds}`} hint={`${s.with_visible_defect} with a visible defect`} />
            <Stat
              label="Plan on the site"
              value={pct(s.avg_fidelity)}
              hint={s.change_ratings.rated ? `changes rated good: ${s.change_ratings.up} of ${s.change_ratings.rated}` : "no change ratings yet"}
            />
          </div>

          {data.recent_negative.length > 0 && (
            <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-xs uppercase tracking-[0.1em] text-slate-500 mb-2">What founders said was off</div>
              <ul className="space-y-1.5 text-sm text-slate-700">
                {data.recent_negative.map((n) => (
                  <li key={n.build_id}>
                    <span className="text-slate-400">{n.tenant_slug ?? "?"}: </span>
                    {n.comment}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-[0.1em]">
                <tr>
                  <th className="text-left px-3 py-2.5">Build</th>
                  <th className="text-left px-3 py-2.5">Verdict</th>
                  <th className="text-right px-3 py-2.5">Founder</th>
                  <th className="text-right px-3 py-2.5">Changes good/rated</th>
                  <th className="text-right px-3 py-2.5">Plan</th>
                  <th className="text-right px-3 py-2.5">Defects</th>
                  <th className="text-right px-3 py-2.5">Fixes</th>
                </tr>
              </thead>
              <tbody>
                {data.builds.map((b) => (
                  <tr key={b.id} className="border-t border-slate-100 align-top hover:bg-slate-50">
                    <td className="px-3 py-2">
                      <div className="text-slate-900">{b.objective ?? "(no objective)"}</div>
                      <div className="text-xs text-slate-500">
                        <Link href={`/tenants/${b.tenant_id}`} className="hover:underline">
                          {b.tenant_slug ?? b.tenant_id.slice(0, 8)}
                        </Link>
                        {" · "}
                        {new Date(b.created_at).toLocaleString()}
                        {" · "}
                        <span className="font-mono">{b.id.slice(0, 8)}</span>
                      </div>
                      {b.rating_comment && <div className="mt-1 text-xs text-rose-700">&ldquo;{b.rating_comment}&rdquo;</div>}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${VERDICT[b.verdict].cls}`}>{VERDICT[b.verdict].label}</span>
                      {b.reasons.length > 0 && <div className="mt-1 text-xs text-slate-500">{b.reasons.join(" · ")}</div>}
                    </td>
                    <td className="px-3 py-2 text-right">{b.rating === 1 ? <span className="text-emerald-700">good</span> : b.rating === -1 ? <span className="text-rose-700">bad</span> : <span className="text-slate-400">—</span>}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-600">
                      {b.changes.rated ? `${b.changes.up}/${b.changes.rated}` : <span className="text-slate-400">{b.changes.total ? `0/${b.changes.total} rated` : "—"}</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {b.fidelity ? (
                        <span className={b.fidelity.gross ? "text-rose-700" : "text-slate-600"}>
                          {b.fidelity.found}/{b.fidelity.total}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {b.review ? (
                        <span className={b.review.qualifying > 0 ? "text-amber-700" : "text-slate-600"} title={b.review.fix_outcome ? `fix: ${b.review.fix_outcome}` : b.review.status}>
                          {b.review.status === "reviewed" ? b.review.qualifying : "not reviewed"}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-600">{b.fix_passes || <span className="text-slate-400">0</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
