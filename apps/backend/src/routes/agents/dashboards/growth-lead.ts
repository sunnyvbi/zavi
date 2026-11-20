
import type { DashboardBuilder } from "./_contract";
import { diagnoseFunnelTool } from "@/services/tools/growth/diagnose_funnel";
import { readCohortTool } from "@/services/tools/growth/read_cohort";
import { getBoolSetting } from "@/services/settings";
import type {
  CurrentGrowthPlan,
  GrowthAction,
  GrowthStage,
  ExecTag,
} from "@/services/growth/current-growth-plan";

type FunnelStep = {
  event: string;
  count: number;
  conversion_from_top: number | null;
};

type CohortRow = {
  cohort: string;
  signups: number;
  revenue: number | null;
  revenue_per_signup: number | null;
  payback_ratio: number | null;
};

type AttentionItem = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
};

type GrowthBetRow = {
  id: string;
  kind: "budget" | "lifecycle" | "social";
  claim: string;
  from_channel: string | null;
  to_channel: string | null;
  amount_usd: number | null;
  amount_qualitative: boolean;
  confidence: "high" | "medium" | "low" | null;
  status: string;
  emitted_at: string | null;
};

const GROWTH_BET_CLASS_BY_KIND: Record<string, GrowthBetRow["kind"]> = {
  "growth-lead.reallocate-budget": "budget",
  "growth-lead.lifecycle-draft": "lifecycle",
  "growth-lead.social-draft": "social",
};
const GROWTH_BET_CLASSES = Object.keys(GROWTH_BET_CLASS_BY_KIND);

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function projectBet(raw: {
  id: unknown;
  decision_class: unknown;
  body: unknown;
  status: unknown;
  emitted_at: unknown;
}): GrowthBetRow | null {
  const cls = typeof raw.decision_class === "string" ? raw.decision_class : "";
  const kind = GROWTH_BET_CLASS_BY_KIND[cls];
  if (!kind) return null;
  const id = typeof raw.id === "string" ? raw.id : String(raw.id ?? "");
  if (!id) return null;
  const b =
    raw.body && typeof raw.body === "object"
      ? (raw.body as Record<string, unknown>)
      : {};
  const str = (k: string): string | null => {
    const v = b[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const claim = str("bet_claim") ?? "(untitled bet)";
  const amountUsdRaw = Number(b.amount_usd);
  const conf =
    b.confidence === "high" || b.confidence === "medium" || b.confidence === "low"
      ? (b.confidence as "high" | "medium" | "low")
      : null;
  return {
    id,
    kind,
    claim: claim.length > 160 ? `${claim.slice(0, 157)}…` : claim,
    from_channel: str("from_channel"),
    to_channel: str("to_channel"),
    amount_usd: Number.isFinite(amountUsdRaw) ? amountUsdRaw : null,
    amount_qualitative: b.amount_qualitative === true,
    confidence: conf,
    status: typeof raw.status === "string" ? raw.status : "proposed",
    emitted_at: typeof raw.emitted_at === "string" ? raw.emitted_at : null,
  };
}

function extractSteps(funnel: unknown): FunnelStep[] {
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

const CURRENT_PLAN_TAG = "current-growth-plan";
const GROWTH_STAGES: readonly GrowthStage[] = [
  "data_not_ready",
  "pre_loop",
  "leaky_loop",
];
const EXEC_TAGS: readonly ExecTag[] = ["yes", "needs-connector", "needs-data", "manual"];
const PLAN_NEXT_CAP = 2;
const PLAN_LATER_CAP = 7;

function projectAction(raw: unknown): GrowthAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const action = typeof r.action === "string" ? r.action.trim() : "";
  if (!action) return null;
  const exec = EXEC_TAGS.includes(r.exec as ExecTag)
    ? (r.exec as ExecTag)
    : "manual";
  return { action, exec };
}

function projectPlan(raw: unknown): CurrentGrowthPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (!GROWTH_STAGES.includes(p.stage as GrowthStage)) return null;
  const stage = p.stage as GrowthStage;
  const now = projectAction(p.now);
  const next = (Array.isArray(p.next) ? p.next : [])
    .map(projectAction)
    .filter((a): a is GrowthAction => a !== null)
    .slice(0, PLAN_NEXT_CAP);
  const later = (Array.isArray(p.later) ? p.later : [])
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, PLAN_LATER_CAP);
  const updated_at = typeof p.updated_at === "string" ? p.updated_at : "";
  return { stage, now, next, later, updated_at };
}

export const build: DashboardBuilder = async (c) => {
  const autopilotEnabled = true;

  let funnelConnected = false;
  let steps: FunnelStep[] = [];
  let diagnosisSource: string | null = null;
  let totalEvents: number | null = null;
  let windowLabel: string | null = null;

  try {
    const res = (await diagnoseFunnelTool.execute(c.ctx, {})) as Record<
      string,
      unknown
    >;
    funnelConnected = true;
    diagnosisSource =
      typeof res.diagnosis_source === "string" ? res.diagnosis_source : null;
    const funnel = res.funnel;
    steps = extractSteps(funnel);
    if (funnel && typeof funnel === "object") {
      const f = funnel as Record<string, unknown>;
      const te = Number(f.total_events_in_window);
      totalEvents = Number.isFinite(te) ? te : null;
      windowLabel = typeof f.window === "string" ? f.window : null;
    }
  } catch {
    funnelConnected = false;
  }

  type FunnelBar = {
    event: string;
    count: number;
    conversion_from_top: number | null;
    conversion_from_prev: number | null;
    drop_from_prev_pct: number | null;
    is_bottleneck: boolean;
  };

  const bars: FunnelBar[] = steps.map((s, i) => {
    const prev = i > 0 ? steps[i - 1] : null;
    let convFromPrev: number | null = null;
    let dropPct: number | null = null;
    if (prev && prev.count > 0) {
      convFromPrev = round1((s.count / prev.count) * 100);
      dropPct = round1(100 - convFromPrev);
    }
    return {
      event: s.event,
      count: s.count,
      conversion_from_top: s.conversion_from_top,
      conversion_from_prev: convFromPrev,
      drop_from_prev_pct: dropPct,
      is_bottleneck: false,
    };
  });

  let bottleneckIdx = -1;
  let worstDrop = -1;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].drop_from_prev_pct;
    if (d !== null && d > worstDrop) {
      worstDrop = d;
      bottleneckIdx = i;
    }
  }
  if (bottleneckIdx >= 0) bars[bottleneckIdx].is_bottleneck = true;

  const bottleneck =
    bottleneckIdx >= 0
      ? {
          stage: bars[bottleneckIdx].event,
          from_stage: bars[bottleneckIdx - 1].event,
          conversion_from_prev: bars[bottleneckIdx].conversion_from_prev,
          drop_pct: bars[bottleneckIdx].drop_from_prev_pct,
        }
      : null;

  const topOfFunnelCount = bars.length > 0 ? bars[0].count : null;

  let cohortsConnected = false;
  let cohorts: CohortRow[] = [];
  let currency: string | null = null;

  try {
    const res = (await readCohortTool.execute(c.ctx, {})) as Record<
      string,
      unknown
    >;
    cohortsConnected = true;
    currency = typeof res.currency === "string" ? res.currency : null;
    const rows = Array.isArray(res.cohorts) ? res.cohorts : [];
    for (const raw of rows) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const cohort = typeof r.cohort === "string" ? r.cohort : null;
      if (cohort === null) continue;
      cohorts.push({
        cohort,
        signups: numOrNull(r.signups) ?? 0,
        revenue: numOrNull(r.revenue),
        revenue_per_signup: numOrNull(r.revenue_per_signup),
        payback_ratio: numOrNull(r.payback_ratio),
      });
    }
  } catch {
    cohortsConnected = false;
  }

  let bets: GrowthBetRow[] = [];
  try {
    const { data, error } = await c.sb
      .from("decisions")
      .select("id, decision_class, body, status, emitted_at")
      .eq("tenant_id", c.tenantId)
      .in("decision_class", GROWTH_BET_CLASSES)
      .order("emitted_at", { ascending: false })
      .limit(8);
    if (!error && Array.isArray(data)) {
      bets = (data as Array<Record<string, unknown>>)
        .map((r) =>
          projectBet({
            id: r.id,
            decision_class: r.decision_class,
            body: r.body,
            status: r.status,
            emitted_at: r.emitted_at,
          }),
        )
        .filter((r): r is GrowthBetRow => r !== null);
    }
  } catch {
  }

  let currentGrowthPlan: CurrentGrowthPlan | null = null;
  try {
    const { data, error } = await c.sb
      .from("memory_note")
      .select("metadata")
      .eq("tenant_id", c.tenantId)
      .eq("note_type", "growth_priorities")
      .contains("tags", [CURRENT_PLAN_TAG])
      .is("superseded_by", null)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (!error && Array.isArray(data) && data[0]) {
      const meta = (data[0] as Record<string, unknown>).metadata;
      const planRaw =
        meta && typeof meta === "object"
          ? (meta as Record<string, unknown>).plan
          : null;
      currentGrowthPlan = projectPlan(planRaw);
    }
  } catch {
    currentGrowthPlan = null;
  }

  if (
    !funnelConnected &&
    !cohortsConnected &&
    bets.length === 0 &&
    currentGrowthPlan === null
  ) {
    return { connected: false };
  }

  const attention: AttentionItem[] = [];
  if (bottleneck && bottleneck.stage) {
    const dropTxt =
      bottleneck.drop_pct !== null ? `${bottleneck.drop_pct}% of users` : "users";
    attention.push({
      severity: "warn",
      title: `${bottleneck.stage} is your biggest funnel drop`,
      detail: `Between ${bottleneck.from_stage} and ${bottleneck.stage} you lose ${dropTxt}${
        bottleneck.conversion_from_prev !== null
          ? ` (only ${bottleneck.conversion_from_prev}% carry through)`
          : ""
      }.`,
      ask: `${bottleneck.stage} is my biggest funnel drop — what 2-3 levers should I pull this week, and draft the top bet?`,
    });
  }

  return {
    connected: true,
    autopilot_enabled: autopilotEnabled,
    current_growth_plan: currentGrowthPlan,
    funnel: {
      connected: funnelConnected,
      diagnosis_source: diagnosisSource,
      window: windowLabel,
      total_events_in_window: totalEvents,
      steps: bars,
      top_of_funnel_count: topOfFunnelCount,
      bottleneck,
    },
    cohorts: {
      connected: cohortsConnected,
      currency,
      rows: cohorts,
    },
    bets,
    attention,
  };
};
