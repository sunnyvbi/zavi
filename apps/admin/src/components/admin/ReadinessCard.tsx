"use client";

import { useEffect, useState } from "react";
import { adminApiFetch } from "@/lib/api-admin";

interface Readiness {
  tenant_id: string;
  score: number;
  dimensions: Record<string, number | string[] | number[]>;
  computed_at: string;
  last_discovery_at: string | null;
}

interface FdeEvent {
  id: string;
  action_kind: string;
  gap_dimension: string | null;
  before_score: number | null;
  after_score: number | null;
  staff_email: string | null;
  agent_training_hint: string | null;
  created_at: string;
}

const DIMENSION_MAX: Record<string, number> = {
  connectors: 30,
  verified_brain: 20,
  goal_measurable: 15,
  deliverable: 15,
  product_url: 10,
  founder_engaged: 10,
};

const DIMENSION_LABEL: Record<string, string> = {
  connectors: "Connectors wired",
  verified_brain: "Verified company brain",
  goal_measurable: "Measurable goal",
  deliverable: "Real deliverable shipped",
  product_url: "Product URL known",
  founder_engaged: "Founder engaged",
};

const AGENT_DOABLE_DIMS = ["verified_brain", "product_url", "deliverable"];
const HUMAN_DOABLE_DIMS = ["connectors", "goal_measurable", "founder_engaged"];

function splitScore(dims: Record<string, unknown> | undefined, keys: string[]) {
  const got = (k: string) => (typeof dims?.[k] === "number" ? (dims[k] as number) : 0);
  return {
    score: keys.reduce((n, k) => n + got(k), 0),
    max: keys.reduce((n, k) => n + (DIMENSION_MAX[k] ?? 0), 0),
    blockers: keys.filter((k) => got(k) < (DIMENSION_MAX[k] ?? 0)),
  };
}

export function ReadinessCard({
  tenantId,
  refreshKey = 0,
}: {
  tenantId: string;
  refreshKey?: number;
}) {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [events, setEvents] = useState<FdeEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rRes, eRes] = await Promise.all([
          adminApiFetch(`/api/admin/tenants/${tenantId}/readiness?recompute=1`),
          adminApiFetch(`/api/admin/tenants/${tenantId}/fde-events`),
        ]);
        const rBody = await rRes.json().catch(() => ({}));
        if (!rRes.ok) throw new Error(rBody?.error?.message ?? `HTTP ${rRes.status}`);
        if (!cancelled) setReadiness((rBody?.readiness ?? null) as Readiness | null);

        if (eRes.ok) {
          const eBody = await eRes.json().catch(() => ({}));
          if (!cancelled) setEvents((eBody?.events ?? []) as FdeEvent[]);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, refreshKey]);

  if (!loaded) {
    return <Shell><p className="text-sm text-slate-500">Loading readiness…</p></Shell>;
  }
  if (err) {
    return <Shell><p className="text-sm text-rose-700">Could not load readiness: {err}</p></Shell>;
  }
  if (!readiness) {
    return (
      <Shell>
        <p className="text-sm text-slate-500">
          Readiness has never been computed for this tenant.{" "}
          <span className="text-slate-400">
            (That is not a score of zero — it means the scan has not run here yet.)
          </span>
        </p>
      </Shell>
    );
  }

  const dims = Object.entries(DIMENSION_MAX)
    .map(([key, max]) => {
      const got = typeof readiness.dimensions?.[key] === "number"
        ? (readiness.dimensions[key] as number)
        : null;
      return { key, max, got, deficit: got === null ? null : max - got };
    })
    .sort((a, b) => (b.deficit ?? -1) - (a.deficit ?? -1));

  const topGap = dims.find((d) => (d.deficit ?? 0) > 0) ?? null;
  const operable = readiness.score >= 70;

  const agent = splitScore(readiness.dimensions, AGENT_DOABLE_DIMS);
  const human = splitScore(readiness.dimensions, HUMAN_DOABLE_DIMS);
  const agentComplete = agent.score >= agent.max;

  return (
    <Shell>
      <div className="flex items-baseline gap-3">
        <span
          className={`text-3xl font-semibold tabular-nums ${operable ? "text-emerald-700" : "text-slate-900"}`}
        >
          {readiness.score}
          <span className="text-base text-slate-400">/100</span>
        </span>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            operable ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
          }`}
        >
          {operable ? "Operable" : "Below the gate"}
        </span>
      </div>

      {topGap && (
        <p className="mt-2 text-sm text-slate-800">
          Biggest gap: <strong>{DIMENSION_LABEL[topGap.key] ?? topGap.key}</strong>{" "}
          <span className="text-slate-500">
            ({topGap.got}/{topGap.max} — {topGap.deficit} pts on the table)
          </span>
        </p>
      )}

      {}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="text-slate-600">
          Agent-done{" "}
          <span className="tabular-nums font-medium text-slate-900">
            {agent.score}/{agent.max}
          </span>
        </span>
        <span className="text-slate-600">
          Human-remaining{" "}
          <span className="tabular-nums font-medium text-slate-900">
            {human.max - human.score}/{human.max}
          </span>
        </span>
        {agentComplete ? (
          <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-700">
            Zavi has done all it can — remaining is a human&apos;s move
            {human.blockers.length > 0 && (
              <>: {human.blockers.map((k) => DIMENSION_LABEL[k] ?? k).join(", ")}</>
            )}
          </span>
        ) : (
          agent.max - agent.score > 0 && (
            <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-600">
              {agent.max - agent.score} pts still automatable
            </span>
          )
        )}
      </div>

      <div className="mt-4 space-y-1.5">
        {dims.map((d) => (
          <div key={d.key} className="flex items-center gap-3">
            <span className="w-48 shrink-0 text-xs text-slate-600">
              {DIMENSION_LABEL[d.key] ?? d.key}
            </span>
            <div className="h-1.5 flex-1 rounded-full bg-slate-100">
              <div
                className="h-1.5 rounded-full bg-emerald-500"
                style={{ width: `${d.got === null ? 0 : (d.got / d.max) * 100}%` }}
              />
            </div>
            <span className="w-14 shrink-0 text-right text-xs tabular-nums text-slate-500">
              {d.got === null ? "—" : `${d.got}/${d.max}`}
            </span>
          </div>
        ))}
      </div>

      {events.length > 0 && (
        <div className="mt-5 border-t border-slate-100 pt-3">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            Human rescues ({events.length})
          </div>
          <ul className="mt-2 space-y-1.5">
            {events.slice(0, 5).map((e) => (
              <li key={e.id} className="text-xs text-slate-600">
                <span className="font-medium text-slate-800">
                  {e.action_kind.replace(/_/g, " ")}
                </span>
                {e.gap_dimension && <> on {e.gap_dimension.replace(/_/g, " ")}</>}
                {e.before_score !== null && (
                  <>
                    {" "}
                    <span className="tabular-nums text-slate-400">
                      ({e.before_score}
                      {e.after_score !== null ? ` → ${e.after_score}` : ""})
                    </span>
                  </>
                )}
                {e.agent_training_hint && (
                  <div className="mt-0.5 text-slate-500 italic">“{e.agent_training_hint}”</div>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-400">
            Every rescue here is a thing an agent could not do. When the same one recurs on
            another tenant, it becomes a proposed fleet lesson.
          </p>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-3 font-display text-sm font-semibold text-slate-900">
        Onboarding readiness
      </h2>
      {children}
    </section>
  );
}
