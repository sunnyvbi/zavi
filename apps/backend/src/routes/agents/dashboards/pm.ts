
import type { DashboardBuilder, DashboardContext } from "./_contract";
import { getBoolSetting } from "@/services/settings";
import { isMoneyOrAuthDecisionClass } from "./_attention-money";
import { PM_NEEDS_ACTION_CLASS } from "@/agents/pm/needs-action";
import {
  deriveDispatchStage,
  isPreMergedStage,
  STUCK_DAYS,
  type DispatchStage,
} from "@/agents/pm/roadmap";

type RoadmapStatus = "proposed" | "in_flight" | "shipped" | "measured";
type RoadmapOutcome = "won" | "recurred" | null;

type RoadmapRow = {
  id: string;
  theme: string;
  status: RoadmapStatus;
  outcome: RoadmapOutcome;
  child_run_id: string | null;
  child_status: string | null;
  updated_at: string | null;
};

type HybridRoadmapRow = RoadmapRow & {
  dispatch_stage: DispatchStage;
  pr_url: string | null;
  pr_state: string | null;
  days_stuck: number | null;
  decision_id: string | null;
};

type StandupSkipped = { theme: string; why: string };
type StandupLoopClosed = { theme: string; outcome: string };
type Standup = {
  judgment: {
    candidates_found: number;
    dispatched_count: number;
    skipped: StandupSkipped[];
  };
  summary_bullets: string[];
  loop_closed: StandupLoopClosed[];
  needs_you_count: number;
  moving_clean_count: number;
};

type AttentionItem = {
  severity: "high" | "warn";
  title: string;
  detail: string;
  ask: string;
  decision_id?: string | null;
  is_money?: boolean;
};

type WeekBucket = {
  week_start: string;
  inflow: number;
  dispatched: number;
};

type FlowVitals = {
  inflow_vs_dispatch: WeekBucket[];
  outcomes: {
    proposed: number;
    in_flight: number;
    shipped_measured: number;
    won: number;
    recurred: number;
  };
};

type PmDashboardPayload = {
  kpis: {
    in_flight: number;
    shipped_measured: number;
    won: number;
    recurred: number;
  };
  rows: RoadmapRow[];
  attention: AttentionItem[];
  flow_vitals: FlowVitals;
  standup?: Standup | null;
};

const FLOW_WEEKS = 5;

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "proposed",
  "in_flight",
  "shipped",
  "measured",
]);

function utcWeekStart(at: Date): Date {
  const d = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - sinceMonday);
  return d;
}

function trailingWeekStarts(now: Date): string[] {
  const thisWeek = utcWeekStart(now);
  const out: string[] = [];
  for (let i = FLOW_WEEKS - 1; i >= 0; i--) {
    const w = new Date(thisWeek);
    w.setUTCDate(w.getUTCDate() - i * 7);
    out.push(w.toISOString());
  }
  return out;
}

function emptyFlowVitals(now: Date): FlowVitals {
  return {
    inflow_vs_dispatch: trailingWeekStarts(now).map((week_start) => ({
      week_start,
      inflow: 0,
      dispatched: 0,
    })),
    outcomes: {
      proposed: 0,
      in_flight: 0,
      shipped_measured: 0,
      won: 0,
      recurred: 0,
    },
  };
}

function emptyPayload(now: Date = new Date()): PmDashboardPayload {
  return {
    kpis: { in_flight: 0, shipped_measured: 0, won: 0, recurred: 0 },
    rows: [],
    attention: [],
    flow_vitals: emptyFlowVitals(now),
  };
}

function cleanTheme(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s.length > 0 ? s.slice(0, 160) : "(untitled)";
}

export const build: DashboardBuilder = async (c) => {
  const now = new Date();
  const payload = emptyPayload(now);

  let hybrid = false;
  try {
    hybrid = await getBoolSetting("pm_hybrid_surface", c.tenantId);
  } catch {
    hybrid = false;
  }

  const lastDispatchedById = new Map<string, string | null>();
  let rawRows: Array<Record<string, unknown>> = [];
  try {
    const { data, error } = await c.sb
      .from("pm_roadmap")
      .select("id, theme, theme_normalized, status, outcome, child_run_id, updated_at, last_dispatched_at")
      .eq("tenant_id", c.tenantId)
      .in("status", ["proposed", "in_flight", "shipped", "measured"])
      .order("updated_at", { ascending: false })
      .limit(100);
    if (!error && Array.isArray(data)) {
      rawRows = data as Array<Record<string, unknown>>;
    }
  } catch {
    return payload;
  }

  const rows: RoadmapRow[] = [];
  for (const r of rawRows) {
    const status = String(r.status ?? "");
    if (!VALID_STATUSES.has(status)) continue;
    const outcomeRaw = r.outcome;
    const outcome: RoadmapOutcome =
      outcomeRaw === "won" || outcomeRaw === "recurred" ? outcomeRaw : null;
    const rowId = String(r.id ?? "");
    lastDispatchedById.set(
      rowId,
      typeof r.last_dispatched_at === "string" ? r.last_dispatched_at : null,
    );
    rows.push({
      id: rowId,
      theme: cleanTheme(r.theme ?? r.theme_normalized),
      status: status as RoadmapStatus,
      outcome,
      child_run_id:
        typeof r.child_run_id === "string" && r.child_run_id.length > 0
          ? r.child_run_id
          : null,
      child_status: null,
      updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
    });
  }

  const childIds = Array.from(
    new Set(
      rows
        .filter((r) => r.child_run_id && (r.status === "in_flight" || r.status === "shipped"))
        .map((r) => r.child_run_id as string),
    ),
  );
  if (childIds.length > 0) {
    try {
      const { data, error } = await c.sb
        .from("agent_runs")
        .select("id, status")
        .eq("tenant_id", c.tenantId)
        .in("id", childIds);
      if (!error && Array.isArray(data)) {
        const statusById = new Map<string, string>();
        for (const run of data as Array<Record<string, unknown>>) {
          const id = typeof run.id === "string" ? run.id : "";
          const st = typeof run.status === "string" ? run.status : "";
          if (id) statusById.set(id, st);
        }
        for (const row of rows) {
          if (row.child_run_id && statusById.has(row.child_run_id)) {
            row.child_status = statusById.get(row.child_run_id) ?? null;
          }
        }
      }
    } catch {
    }
  }

  payload.flow_vitals = await computeFlowVitals(c, now);

  const o = payload.flow_vitals.outcomes;
  payload.kpis = {
    in_flight: o.in_flight,
    shipped_measured: o.shipped_measured,
    won: o.won,
    recurred: o.recurred,
  };

  const attentionWithRow: Array<{ item: AttentionItem; roadmapId: string }> = [];
  for (const r of rows) {
    if (r.outcome === "recurred") {
      attentionWithRow.push({
        roadmapId: r.id,
        item: {
          severity: "high",
          title: `The fix for "${r.theme}" came back`,
          detail:
            "A prior fix for this theme did not hold — the same signature recurred. Worth re-investigating and re-dispatching.",
          ask: `The fix for "${r.theme}" came back — re-investigate and re-dispatch.`,
        },
      });
    }
  }
  for (const r of rows) {
    if (r.status === "in_flight") {
      attentionWithRow.push({
        roadmapId: r.id,
        item: {
          severity: "warn",
          title: `"${r.theme}" is in flight`,
          detail: "A fix for this theme is dispatched to engineer. Check where the PR stands.",
          ask: `What's the status of the PR for "${r.theme}"?`,
        },
      });
    }
  }

  payload.rows = rows;
  payload.attention = attentionWithRow.map((a) => a.item);

  if (hybrid) {
    const decisionByRoadmap = await loadOpenNeedsActionDecisions(c);
    const enrichedRows = await enrichRowsWithLifecycle(
      c,
      rows,
      lastDispatchedById,
      now,
      decisionByRoadmap,
    );
    payload.rows = enrichedRows;
    payload.standup = await buildStandup(c, enrichedRows, now);
    const is_money = isMoneyOrAuthDecisionClass(PM_NEEDS_ACTION_CLASS);
    payload.attention = attentionWithRow.map((a) => ({
      ...a.item,
      decision_id: decisionByRoadmap.get(a.roadmapId) ?? null,
      is_money,
    }));
  }

  return payload;
};

async function loadOpenNeedsActionDecisions(c: {
  sb: DashboardContext["sb"];
  tenantId: string;
}): Promise<Map<string, string>> {
  const byRoadmap = new Map<string, string>();
  try {
    const { data, error } = await c.sb
      .from("decisions")
      .select("id, body, emitted_at")
      .eq("tenant_id", c.tenantId)
      .eq("decision_class", PM_NEEDS_ACTION_CLASS)
      .eq("status", "proposed")
      .order("emitted_at", { ascending: false })
      .limit(200);
    if (error || !Array.isArray(data)) return byRoadmap;
    for (const row of data as Array<Record<string, unknown>>) {
      const id = typeof row.id === "string" ? row.id : "";
      const body = (row.body ?? {}) as Record<string, unknown>;
      const roadmapId = typeof body.roadmap_id === "string" ? body.roadmap_id : "";
      if (id && roadmapId && !byRoadmap.has(roadmapId)) byRoadmap.set(roadmapId, id);
    }
  } catch {
  }
  return byRoadmap;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const STUCK_MS = STUCK_DAYS * DAY_MS;
const LOOP_CLOSED_WINDOW_DAYS = 45;

async function enrichRowsWithLifecycle(
  c: { sb: DashboardContext["sb"]; tenantId: string },
  rows: RoadmapRow[],
  lastDispatchedById: Map<string, string | null>,
  now: Date,
  decisionByRoadmap: Map<string, string>,
): Promise<HybridRoadmapRow[]> {
  const childIds = Array.from(
    new Set(rows.map((r) => r.child_run_id).filter((x): x is string => !!x)),
  );

  const childById = new Map<
    string,
    { status?: string | null; finished_at?: string | null; parsed?: Record<string, unknown> | null }
  >();
  if (childIds.length > 0) {
    try {
      const { data, error } = await c.sb
        .from("agent_runs")
        .select("id, status, finished_at, parsed")
        .eq("tenant_id", c.tenantId)
        .in("id", childIds);
      if (!error && Array.isArray(data)) {
        for (const run of data as Array<Record<string, unknown>>) {
          const id = typeof run.id === "string" ? run.id : "";
          if (!id) continue;
          childById.set(id, {
            status: typeof run.status === "string" ? run.status : null,
            finished_at: typeof run.finished_at === "string" ? run.finished_at : null,
            parsed:
              run.parsed && typeof run.parsed === "object"
                ? (run.parsed as Record<string, unknown>)
                : null,
          });
        }
      }
    } catch {
    }
  }

  return rows.map((row) => {
    const child = (row.child_run_id && childById.get(row.child_run_id)) || {};
    const stage = deriveDispatchStage(child);
    const parsed = (child.parsed ?? {}) as Record<string, unknown>;
    const pr_url =
      typeof parsed.pr_url === "string" && parsed.pr_url.length > 0 ? parsed.pr_url : null;
    const pr_state =
      typeof parsed.pr_state === "string" && parsed.pr_state.length > 0 ? parsed.pr_state : null;

    let days_stuck: number | null = null;
    const lastDispatched = lastDispatchedById.get(row.id);
    if (row.status === "in_flight" && lastDispatched) {
      const ageMs = now.getTime() - Date.parse(lastDispatched);
      if (Number.isFinite(ageMs) && isPreMergedStage(stage) && ageMs >= STUCK_MS) {
        days_stuck = Math.floor(ageMs / DAY_MS);
      }
    }

    return {
      ...row,
      dispatch_stage: stage,
      pr_url,
      pr_state,
      days_stuck,
      decision_id: decisionByRoadmap.get(row.id) ?? null,
    };
  });
}

const VALID_URGENCY: ReadonlySet<string> = new Set(["now", "this-week", "this-month"]);
const MAX_DISPATCH_PER_RUN = 3;

function deriveSkipReason(r: Record<string, unknown>, dispatchedCount: number): string {
  if (r.needs_go === true) {
    return "Held for your approval — auto-dispatch precision below threshold.";
  }
  if (r.needs_go === false) {
    const urgency = typeof r.urgency === "string" && VALID_URGENCY.has(r.urgency) ? r.urgency : null;
    const base =
      dispatchedCount >= MAX_DISPATCH_PER_RUN
        ? "Not in this run's top-3 dispatch batch"
        : "Not dispatched this run — reason not recorded";
    return urgency ? `${base} · urgency: ${urgency}` : base;
  }
  return "Reason not recorded";
}

function isExceptionRow(r: HybridRoadmapRow): boolean {
  return (
    r.dispatch_stage === "failed_to_open" ||
    r.outcome === "recurred" ||
    r.days_stuck != null
  );
}

async function buildStandup(
  c: { sb: DashboardContext["sb"]; tenantId: string },
  rows: HybridRoadmapRow[],
  now: Date,
): Promise<Standup | null> {
  let envelope: Record<string, unknown> | null = null;
  try {
    const { data, error } = await c.sb
      .from("agent_runs")
      .select("id, parsed, finished_at")
      .eq("tenant_id", c.tenantId)
      .eq("agent_slug", "pm")
      .eq("status", "success")
      .order("finished_at", { ascending: false })
      .limit(1);
    if (!error && Array.isArray(data) && data.length > 0) {
      const p = (data[0] as Record<string, unknown>).parsed;
      if (p && typeof p === "object") envelope = p as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  if (!envelope) return null;

  const dispatched = Array.isArray(envelope.dispatched_actions)
    ? (envelope.dispatched_actions as Array<Record<string, unknown>>)
    : [];
  const recommended = Array.isArray(envelope.recommended_actions_not_dispatched)
    ? (envelope.recommended_actions_not_dispatched as Array<Record<string, unknown>>)
    : [];
  const backlog = Array.isArray(envelope.backlog)
    ? (envelope.backlog as Array<Record<string, unknown>>)
    : [];

  const themeByItemId = new Map<string, string>();
  for (const b of backlog) {
    const id = typeof b.item_id === "string" ? b.item_id : "";
    const theme = typeof b.theme === "string" ? b.theme : "";
    if (id && theme) themeByItemId.set(id, theme);
  }

  const skipped: StandupSkipped[] = recommended.map((r) => {
    const id = typeof r.item_id === "string" ? r.item_id : "";
    const theme =
      themeByItemId.get(id) ||
      (typeof r.description === "string" && r.description.length > 0
        ? r.description
        : "(untitled)");
    return { theme: theme.slice(0, 160), why: deriveSkipReason(r, dispatched.length) };
  });

  const summaryObj =
    envelope.summary && typeof envelope.summary === "object"
      ? (envelope.summary as Record<string, unknown>)
      : {};
  const summary_bullets = Array.isArray(summaryObj.bullets)
    ? (summaryObj.bullets as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];

  const windowMs = LOOP_CLOSED_WINDOW_DAYS * DAY_MS;
  const loop_closed: StandupLoopClosed[] = rows
    .filter((r) => {
      if (!(r.outcome === "won" || r.status === "measured")) return false;
      if (!r.updated_at) return false;
      const t = Date.parse(r.updated_at);
      return Number.isFinite(t) && now.getTime() - t <= windowMs;
    })
    .slice(0, 20)
    .map((r) => ({ theme: r.theme, outcome: r.outcome ?? r.status }));

  const needs_you_count = rows.filter(isExceptionRow).length;
  const moving_clean_count = rows.filter(
    (r) => r.status === "in_flight" && !isExceptionRow(r),
  ).length;

  return {
    judgment: {
      candidates_found: dispatched.length + recommended.length,
      dispatched_count: dispatched.length,
      skipped,
    },
    summary_bullets,
    loop_closed,
    needs_you_count,
    moving_clean_count,
  };
}

export async function computeFlowVitals(
  c: { sb: DashboardContext["sb"]; tenantId: string },
  now: Date,
): Promise<FlowVitals> {
  const weekStarts = trailingWeekStarts(now);

  const runCount = async (
    p: PromiseLike<{ count: number | null; error: unknown }>,
  ): Promise<number> => {
    try {
      const { count, error } = await p;
      return !error && typeof count === "number" ? count : 0;
    } catch {
      return 0;
    }
  };
  const base = () =>
    c.sb
      .from("pm_roadmap")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", c.tenantId);

  const nowIso = now.toISOString();
  const inflow_vs_dispatch: WeekBucket[] = [];
  for (let i = 0; i < weekStarts.length; i++) {
    const weekStart = weekStarts[i];
    const weekEnd = i + 1 < weekStarts.length ? weekStarts[i + 1] : nowIso;
    const inflow = await runCount(
      base()
        .in("status", ["proposed", "in_flight", "shipped", "measured"])
        .gte("first_seen_at", weekStart)
        .lt("first_seen_at", weekEnd),
    );
    const dispatched = await runCount(
      base()
        .in("status", ["proposed", "in_flight", "shipped", "measured"])
        .gte("last_dispatched_at", weekStart)
        .lt("last_dispatched_at", weekEnd),
    );
    inflow_vs_dispatch.push({ week_start: weekStart, inflow, dispatched });
  }

  const outcomes = {
    proposed: await runCount(base().eq("status", "proposed")),
    in_flight: await runCount(base().eq("status", "in_flight")),
    shipped_measured: await runCount(
      base().in("status", ["shipped", "measured"]),
    ),
    won: await runCount(base().eq("outcome", "won")),
    recurred: await runCount(base().eq("outcome", "recurred")),
  };

  return { inflow_vs_dispatch, outcomes };
}
