
import { serviceClient } from "@/services/supabase";
import type { MorningBriefResponse } from "../../src/services/workspace/morning-brief-assembler";

export type Provenance = "observed" | "proposed" | "inferred";

export function labelLine(text: string, provenance: Provenance): string {
  return `${text} [${provenance}]`;
}

export type YesterdayLedgerRow = {
  action: string;
  target_agent_slug: string | null;
  outcome: string | null;
  created_at: string;
};

export type YesterdayOutcomeRow = {
  subject_name: string | null;
  action_class: string;
  target_metric: string;
  decision_outcome: string;
  delta_metrics: Record<string, unknown> | null;
};

export type YesterdayGoalRow = MorningBriefResponse["goals"][number];

export type YesterdayLoopInput = {
  ledger: readonly YesterdayLedgerRow[];
  outcomes: readonly YesterdayOutcomeRow[];
  goals: readonly YesterdayGoalRow[];
};

const MAX_OUTCOME_LINES = 3;
const MAX_GOAL_LINES = 3;

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function deltaForTargetMetric(o: YesterdayOutcomeRow): number | null {
  if (!o.delta_metrics || typeof o.delta_metrics !== "object") return null;
  return num((o.delta_metrics as Record<string, unknown>)[o.target_metric]);
}

function fmtDelta(metric: string, delta: number): string {
  const sign = delta >= 0 ? "+" : "-";
  const abs = Math.abs(delta);
  if (metric === "spend") return `${sign}$${abs.toFixed(2)}`;
  const v = Math.abs(abs - Math.round(abs)) < 1e-9 ? String(Math.round(abs)) : abs.toFixed(2);
  return `${sign}${v}`;
}

export function helpedRead(o: YesterdayOutcomeRow, delta: number): string | null {
  if (o.decision_outcome !== "approved") return null;
  if (o.target_metric === "spend") {
    return delta <= 0
      ? "Looks like it helped: spend went down."
      : "Spend still went up, so it may not have helped.";
  }
  if (o.target_metric === "roas") {
    return delta >= 0
      ? "Looks like it helped: returns improved."
      : "Returns dipped, so it may not have helped.";
  }
  return null;
}

export function buildYesterdayLines(input: YesterdayLoopInput): string[] {
  const lines: string[] = [];

  if (input.ledger.length === 0) {
    lines.push(labelLine("No autonomous actions ran yesterday.", "observed"));
  } else {
    const started = input.ledger.filter(
      (r) => r.action === "dispatch" || r.action === "dispatched",
    ).length;
    const finished = input.ledger.filter(
      (r) => r.action === "completed" && r.outcome !== "failed",
    ).length;
    const failed = input.ledger.filter(
      (r) => r.action === "dispatch_failed" || r.outcome === "failed",
    ).length;
    const agents = Array.from(
      new Set(
        input.ledger
          .map((r) => r.target_agent_slug)
          .filter((s): s is string => typeof s === "string" && s.length > 0),
      ),
    ).slice(0, 5);
    const who = agents.length > 0 ? ` (${agents.join(", ")})` : "";
    if (started > 0) {
      const bits: string[] = [];
      if (finished > 0) bits.push(`${finished} finished`);
      if (failed > 0) bits.push(`${failed} failed`);
      const tail = bits.length > 0 ? `: ${bits.join(", ")}` : "";
      lines.push(
        labelLine(
          `Your team ran ${started} autonomous task${started === 1 ? "" : "s"} yesterday${tail}${who}.`,
          "observed",
        ),
      );
    } else {
      lines.push(
        labelLine(`Autopilot checked in on running work; nothing new started${who}.`, "observed"),
      );
    }
  }

  for (const o of input.outcomes.slice(0, MAX_OUTCOME_LINES)) {
    const name = (o.subject_name ?? o.action_class).slice(0, 80);
    const verb = o.decision_outcome === "approved" ? "approved" : "declined";
    const delta = deltaForTargetMetric(o);
    if (delta === null) {
      lines.push(
        labelLine(
          `We measured "${name}" after you ${verb} it; no clear ${o.target_metric} change to report yet.`,
          "observed",
        ),
      );
      continue;
    }
    lines.push(
      labelLine(
        `After you ${verb} "${name}": ${o.target_metric} changed by ${fmtDelta(o.target_metric, delta)} in the weeks after.`,
        "observed",
      ),
    );
    const helped = helpedRead(o, delta);
    if (helped) lines.push(labelLine(helped, "inferred"));
  }

  for (const g of input.goals.slice(0, MAX_GOAL_LINES)) {
    const progress =
      g.current_value == null
        ? "unmeasured"
        : g.target_value == null
          ? `at ${g.current_value}, no target set`
          : `${g.current_value} of ${g.target_value}`;
    lines.push(labelLine(`Goal "${g.objective}": ${g.target_metric} ${progress}.`, "observed"));
  }

  return lines;
}

export async function fetchYesterdayLoopRows(
  tenant_id: string,
  now: Date,
): Promise<{ ledger: YesterdayLedgerRow[]; outcomes: YesterdayOutcomeRow[] } | null> {
  try {
    const sb = serviceClient();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const [ledgerRes, outcomesRes] = await Promise.all([
      sb
        .from("autopilot_action_ledger")
        .select("action, target_agent_slug, outcome, created_at")
        .eq("tenant_id", tenant_id)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(200),
      sb
        .from("action_outcomes")
        .select("subject_name, action_class, target_metric, decision_outcome, delta_metrics")
        .eq("tenant_id", tenant_id)
        .eq("reconcile_status", "measured")
        .gte("measured_at", since)
        .order("measured_at", { ascending: false })
        .limit(10),
    ]);
    if (ledgerRes.error) return null;
    return {
      ledger: (ledgerRes.data ?? []) as YesterdayLedgerRow[],
      outcomes: outcomesRes.error ? [] : ((outcomesRes.data ?? []) as YesterdayOutcomeRow[]),
    };
  } catch {
    return null;
  }
}
