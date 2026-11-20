"use client";

import { useEffect, useState, type JSX } from "react";
import { apiFetch } from "@/lib/api";

type ScorecardEnvelope = {
  brier: number | null;
  brier_n: number;
  directional_accuracy: number | null;
  directional_accuracy_n: number;
  actual_rate: number | null;
  actual_rate_n: number;
  calibration_curve: Array<{ bin: number; count: number; actual_rate: number }>;
};

type EmptyState = { code: "no_data_yet"; message: string };

type AgentSection = {
  slug: string;
  loading: boolean;
  empty: EmptyState | null;
  data: ScorecardEnvelope | null;
  error: string | null;
};

const SCORED_AGENTS = ["chief-of-staff", "pm"] as const;

async function fetchScorecard(
  holder_ref?: string,
): Promise<{ ok: ScorecardEnvelope } | { empty: EmptyState } | { error: string }> {
  const qs = holder_ref
    ? `?holder_type=agent&holder_ref=${encodeURIComponent(holder_ref)}`
    : "";
  try {
    const r = await apiFetch(`/api/takes/scorecard${qs}`);
    if (r.status === 404) {
      const body = (await r.json()) as { error?: { code?: string; message?: string } };
      return {
        empty: {
          code: "no_data_yet",
          message: body.error?.message ?? "No resolved bets yet.",
        },
      };
    }
    if (!r.ok) {
      return { error: `HTTP ${r.status}` };
    }
    const body = (await r.json()) as { report?: ScorecardEnvelope } & ScorecardEnvelope;
    return { ok: body.report ?? (body as ScorecardEnvelope) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function formatPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(digits)}%`;
}

function formatBrier(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "-";
  return n.toFixed(3);
}

export function ScorecardPanel(): JSX.Element {
  const [tenant, setTenant] = useState<AgentSection>({
    slug: "(tenant total)",
    loading: true,
    empty: null,
    data: null,
    error: null,
  });
  const [perAgent, setPerAgent] = useState<AgentSection[]>(
    SCORED_AGENTS.map((slug) => ({
      slug,
      loading: true,
      empty: null,
      data: null,
      error: null,
    })),
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await fetchScorecard();
      if (cancelled) return;
      if ("ok" in r) {
        setTenant((s) => ({ ...s, loading: false, data: r.ok }));
      } else if ("empty" in r) {
        setTenant((s) => ({ ...s, loading: false, empty: r.empty }));
      } else {
        setTenant((s) => ({ ...s, loading: false, error: r.error }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results = await Promise.all(SCORED_AGENTS.map((slug) => fetchScorecard(slug)));
      if (cancelled) return;
      setPerAgent(
        SCORED_AGENTS.map((slug, i) => {
          const r = results[i];
          if ("ok" in r) {
            return { slug, loading: false, empty: null, data: r.ok, error: null };
          } else if ("empty" in r) {
            return { slug, loading: false, empty: r.empty, data: null, error: null };
          } else {
            return { slug, loading: false, empty: null, data: null, error: r.error };
          }
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-1">Brain scorecard</h3>
        <p className="text-[12px] text-slate-500">
          Calibration metrics from your agents' resolved bets. Empty until predictions
          are resolved (correct / incorrect / partial) via the staff UI.
        </p>
      </div>

      <ScoreRow section={tenant} title="Tenant total (all holders)" />

      <div className="space-y-3">
        <h4 className="text-[12px] font-medium text-slate-600 uppercase tracking-wide">
          Per scoring agent
        </h4>
        {perAgent.map((s) => (
          <ScoreRow key={s.slug} section={s} title={s.slug} />
        ))}
      </div>
    </div>
  );
}

function ScoreRow({ section, title }: { section: AgentSection; title: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-base font-medium text-slate-900">{title}</div>
        {section.loading && (
          <div className="text-[11px] text-slate-400">loading…</div>
        )}
      </div>

      {section.error && (
        <div className="text-[12px] text-rose-600">Error: {section.error}</div>
      )}

      {section.empty && (
        <div className="text-[12px] text-slate-500 italic">
          {section.empty.message}
        </div>
      )}

      {section.data && (
        <div className="grid grid-cols-3 gap-3 text-[13px]">
          <Metric label="Brier" value={formatBrier(section.data.brier)} sub={`n=${section.data.brier_n}`} />
          <Metric
            label="Directional accuracy"
            value={formatPct(section.data.directional_accuracy)}
            sub={`n=${section.data.directional_accuracy_n}`}
          />
          <Metric
            label="Actual rate"
            value={formatPct(section.data.actual_rate)}
            sub={`n=${section.data.actual_rate_n}`}
          />
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }): JSX.Element {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-base font-semibold text-slate-900">{value}</div>
      <div className="text-[11px] text-slate-400">{sub}</div>
    </div>
  );
}
