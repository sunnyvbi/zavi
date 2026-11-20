
export type FunnelStep = {
  event: string;
  count: number;
  conversion_from_top: number | null;
};

export type GrowthStage = "data_not_ready" | "pre_loop" | "leaky_loop";

export type GrowthStageInput = {
  sourceAvailable: boolean;
  steps: FunnelStep[];
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function normalizeFunnelSteps(funnel: unknown): FunnelStep[] {
  if (!funnel || typeof funnel !== "object") return [];
  const f = funnel as Record<string, unknown>;
  const candidates: unknown[] = [
    f.steps,
    (f.funnel as Record<string, unknown> | undefined)?.steps,
  ];
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;
    const steps: FunnelStep[] = [];
    for (const raw of c) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const event = typeof r.event === "string" ? r.event : null;
      const count = Number(r.count);
      if (event === null || !Number.isFinite(count)) continue;
      const conv = Number(r.conversion_from_top);
      steps.push({
        event,
        count,
        conversion_from_top: Number.isFinite(conv) ? round1(conv) : null,
      });
    }
    if (steps.length > 0) return steps;
  }
  return [];
}

export function classifyGrowthStage(input: GrowthStageInput): GrowthStage {
  const { sourceAvailable, steps } = input;

  if (!sourceAvailable || steps.length < 2) return "data_not_ready";

  if (steps.every((s) => !(s.count > 0))) return "data_not_ready";

  const terminal = steps[steps.length - 1].count;
  if (!(terminal > 0)) return "pre_loop";

  return "leaky_loop";
}

export type ExecTag = "yes" | "needs-connector" | "needs-data" | "manual";

export type GrowthAction = { action: string; exec: ExecTag };

export type CurrentGrowthPlan = {
  stage: GrowthStage;
  now: GrowthAction | null;
  next: GrowthAction[];
  later: string[];
  updated_at: string;
};

export type GrowthPlanBet = {
  bet: string;
  lever: "budget" | "lifecycle" | "social";
  amount_usd: number | null;
  amount_qualitative: boolean;
  suggested_dispatch: string | null;
  suggested_publish: string | null;
  evidence_text: string;
};

export function isEarlyStage(stage: GrowthStage): boolean {
  return stage === "data_not_ready" || stage === "pre_loop";
}

export function isScaleBudgetBet(bet: { lever: string }): boolean {
  return bet.lever === "budget";
}

const CONNECTOR_GAP_RE =
  /_not_connected|not connected|connect (your|the|a|their)|instrument (your|the|their)|\/settings/i;

function looksLikeDispatchRail(v: string | null): boolean {
  if (!v) return false;
  const token = v.split("(")[0].trim().split(/\s+/)[0] ?? "";
  if (!token) return false;
  const slug = (token.includes(".") ? token.slice(0, token.indexOf(".")) : token).toLowerCase();
  return slug !== "founder" && /^[a-z0-9-]+$/.test(slug);
}

export function resolveExecTag(bet: GrowthPlanBet): ExecTag {
  const hay = `${bet.bet} ${bet.evidence_text}`;
  if (CONNECTOR_GAP_RE.test(hay)) return "needs-connector";
  if (bet.lever === "social" && (bet.suggested_publish ?? "").trim()) return "yes";
  if (looksLikeDispatchRail(bet.suggested_dispatch)) return "yes";
  if (bet.lever === "budget" && bet.amount_usd != null) return "yes";
  if (bet.lever === "lifecycle") return "yes";
  return "manual";
}

const LATER_CAP = 7;

export function buildCurrentGrowthPlan(input: {
  stage: GrowthStage;
  bets: GrowthPlanBet[];
  updatedAt: string;
  hasConnectedGrowthDataSource?: boolean;
}): CurrentGrowthPlan {
  const { stage, updatedAt, hasConnectedGrowthDataSource = false } = input;
  const eligible = input.bets.filter(
    (b) => !(isScaleBudgetBet(b) && isEarlyStage(stage)),
  );

  if (stage === "data_not_ready") {
    const now: GrowthAction = hasConnectedGrowthDataSource
      ? {
          action:
            "Your funnel data is too thin to diagnose yet. Keep your events and orders flowing; no new connector needed.",
          exec: "needs-data",
        }
      : {
          action:
            "Get a real funnel signal first. Instrument your product events (POST /api/events/ingest) or connect your operator DB in /settings, so growth diagnosis runs on data, not guesses.",
          exec: "needs-connector",
        };
    return {
      stage,
      now,
      next: [],
      later: eligible.map((b) => b.bet).slice(0, LATER_CAP),
      updated_at: updatedAt,
    };
  }

  const actions: GrowthAction[] = eligible.map((b) => ({
    action: b.bet,
    exec: resolveExecTag(b),
  }));
  return {
    stage,
    now: actions[0] ?? null,
    next: actions.slice(1, 3),
    later: actions.slice(3).map((a) => a.action).slice(0, LATER_CAP),
    updated_at: updatedAt,
  };
}
