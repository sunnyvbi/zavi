
import { serviceClient } from "@/services/supabase";
import { redactTrajectory, REDACTION_VERSION } from "./redact-trajectory";
import { trustTierFor } from "./trust-tier";
import { carriesCapturedPageContext } from "@/services/agents/untrusted-context";
import { deriveEpisodeProvenance } from "./episode-provenance";
import { getBoolSetting } from "@/services/settings";
import { OPERATOR_FAILURE_SHAPES } from "@/agents/operator/failure-shapes";

const OPERATOR_FAILURE_SHAPE_SET = new Set<string>(OPERATOR_FAILURE_SHAPES);

const MAX_FIELD = 8_000;
const MAX_TRAJECTORY_JSON = 64_000;

export type TerminalUpdate = {
  status?: unknown;
  error?: unknown;
  parse_error?: unknown;
  output_text?: unknown;
  cost_usd?: unknown;
  tool_calls?: unknown;
};

export type SignalRunRow = {
  agent_slug: string;
  tenant_id: string;
  trigger: string;
  started_at?: string | null;
  finished_at?: string | null;
  payload?: unknown;
};

function cap(s: unknown, n: number): string | null {
  if (typeof s !== "string") return null;
  return s.length > n ? s.slice(0, n) : s;
}

export function extractQuestion(trigger: string, payload: unknown): string | null {
  if (typeof payload === "string") return payload.trim() || null;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const flat =
    p.intent ?? p.user_text ?? p.text ?? p.question ?? p.prompt ??
    p.goal ?? p.objective ?? p.task ?? p.task_description ??
    p.current_message ?? p.message ?? p.input;
  if (typeof flat === "string" && flat.trim()) return flat;
  const nested =
    (p.standing_order as Record<string, unknown> | undefined)?.prompt ??
    (p.slack as Record<string, unknown> | undefined)?.text ??
    (p.email as Record<string, unknown> | undefined)?.body;
  if (typeof nested === "string" && nested.trim()) return nested;
  if (trigger === "mcp") {
    try {
      return JSON.stringify(p).slice(0, 50_000);
    } catch {
      return null;
    }
  }
  return null;
}

export async function writeMemorySignal(args: {
  run_id: string;
  row: SignalRunRow;
  update: TerminalUpdate;
  captureSource?: "persistTerminal" | "backfill";
  failureShapes?: string[];
}): Promise<void> {
  const { run_id, row, update, captureSource = "persistTerminal", failureShapes } = args;

  const status = typeof update.status === "string" ? update.status : null;
  if (!status) return;

  const trigger = row.trigger || "manual";

  const errorText =
    (typeof update.error === "string" && update.error) ||
    (typeof update.parse_error === "string" && update.parse_error) ||
    null;

  const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
  const finishedMs = row.finished_at ? Date.parse(row.finished_at) : NaN;
  const endMs = Number.isFinite(finishedMs) ? finishedMs : Date.now();
  const ms = Number.isFinite(startedMs) ? endMs - startedMs : null;

  let episodeProvenance: ReturnType<typeof deriveEpisodeProvenance> = null;
  try {
    if (await getBoolSetting("memory_episode_provenance", row.tenant_id)) {
      episodeProvenance = deriveEpisodeProvenance(update.tool_calls);
    }
  } catch {
    episodeProvenance = null;
  }

  const rawCore = {
    question: extractQuestion(trigger, row.payload),
    output_text: typeof update.output_text === "string" ? update.output_text : null,
    error: errorText,
    status,
    trigger,
    cost_usd: typeof update.cost_usd === "number" ? update.cost_usd : null,
    ms,
    ...(episodeProvenance ?? {}),
  };
  const { value: redacted, redactions } = redactTrajectory(rawCore);
  const r = redacted as Record<string, unknown>;
  r.question = cap(r.question, MAX_FIELD);
  r.output_text = cap(r.output_text, MAX_FIELD);
  r.error = cap(r.error, MAX_FIELD);

  let trajectory: unknown = redacted;
  try {
    if (JSON.stringify(redacted).length > MAX_TRAJECTORY_JSON) {
      trajectory = { ...(redacted as object), output_text: "[…dropped: over size cap]" };
    }
  } catch {
  }

  const trust_tier = trustTierFor({
    trigger,
    agent_slug: row.agent_slug,
    untrusted_context: carriesCapturedPageContext(row.payload),
  });

  const { error } = await serviceClient().from("memory_signal").insert({
    tenant_id: row.tenant_id,
    agent_run_id: run_id,
    agent_slug: row.agent_slug,
    trigger,
    status,
    signal_kind: "episode",
    trust_tier,
    redacted_trajectory: trajectory,
    provenance: {
      capture_source: captureSource,
      redaction_version: REDACTION_VERSION,
      redactions_applied: redactions,
      ...(Array.isArray(failureShapes)
        ? {
            failure_shapes: failureShapes.filter((t) =>
              OPERATOR_FAILURE_SHAPE_SET.has(t),
            ),
          }
        : {}),
    },
  });

  if (error && error.code !== "23505") {
    throw new Error(`memory_signal insert failed: ${error.message}`);
  }
}

export async function writeOperatorStep(args: {
  run_id: string;
  step_idx: number;
  plan_md?: string | null;
  observations_md?: string | null;
  decisions_md?: string | null;
}): Promise<void> {
  const { run_id, step_idx } = args;

  const { data: runRow, error: lookupErr } = await serviceClient()
    .from("agent_runs")
    .select("tenant_id, agent_slug, trigger, payload")
    .eq("id", run_id)
    .single();
  if (lookupErr || !runRow) return;

  const tenant_id = runRow.tenant_id as string;
  const agent_slug = (runRow.agent_slug as string) ?? "operator";
  const trigger = (runRow.trigger as string | null) ?? "chat";

  const rawStep = {
    plan_md: args.plan_md ?? null,
    observations_md: args.observations_md ?? null,
    decisions_md: args.decisions_md ?? null,
  };
  const { value: redacted, redactions } = redactTrajectory(rawStep);
  const r = redacted as Record<string, unknown>;
  r.plan_md = cap(r.plan_md, MAX_FIELD);
  r.observations_md = cap(r.observations_md, MAX_FIELD);
  r.decisions_md = cap(r.decisions_md, MAX_FIELD);

  let trajectory: unknown = redacted;
  try {
    if (JSON.stringify(redacted).length > MAX_TRAJECTORY_JSON) {
      trajectory = {
        ...(redacted as object),
        observations_md: "[…dropped: over size cap]",
      };
    }
  } catch {
  }

  const trust_tier = trustTierFor({
    trigger,
    agent_slug,
    untrusted_context: carriesCapturedPageContext(runRow.payload),
  });

  const { error } = await serviceClient().from("memory_signal").insert({
    tenant_id,
    agent_run_id: run_id,
    agent_slug,
    trigger,
    status: "success",
    signal_kind: "operator_step",
    step_idx,
    trust_tier,
    redacted_trajectory: trajectory,
    provenance: {
      capture_source: "operator_step",
      redaction_version: REDACTION_VERSION,
      redactions_applied: redactions,
    },
  });

  if (error) {
    throw new Error(`operator_step insert failed: ${error.message}`);
  }
}

export type OperatorStepRow = {
  step_idx: number | null;
  redacted_trajectory: unknown;
};

export async function readOperatorStepScratchpad(
  run_id: string,
  sb: { from: (t: string) => any } = serviceClient() as any,
  limit = 10,
): Promise<OperatorStepRow[]> {
  try {
    const { data, error } = await sb
      .from("memory_signal")
      .select("step_idx, redacted_trajectory")
      .eq("agent_run_id", run_id)
      .eq("signal_kind", "operator_step")
      .order("step_idx", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as OperatorStepRow[];
  } catch {
    return [];
  }
}
