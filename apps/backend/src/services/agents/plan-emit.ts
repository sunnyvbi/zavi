
import { PlanBodySchema, ClassifySchema } from "./thread-event-types";
import type { ThreadEventBody } from "./thread-event-types";
import { inngest } from "../../../workers/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { redactTrajectory } from "../memory/redact-trajectory";

const PLAN_EMIT_ENABLED_SLUGS: ReadonlySet<string> = new Set([
  "engineer",
  "operator",
]);

const PLAN_RE = /<plan>\s*([\s\S]*?)\s*<\/plan>/i;

function pickClassify(o: Record<string, unknown>) {
  if (!o.classify || typeof o.classify !== "object") return undefined;
  const parsed = ClassifySchema.safeParse(o.classify);
  return parsed.success ? parsed.data : undefined;
}

export function extractPlanBlock(text: string): ThreadEventBody<"plan"> | null {
  const m = text.match(PLAN_RE);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const clamped = {
    classify: pickClassify(o),
    summary: typeof o.summary === "string" ? o.summary.slice(0, 2000) : "",
    steps: Array.isArray(o.steps)
      ? o.steps
          .filter((s): s is string => typeof s === "string")
          .slice(0, 8)
          .map((s) => s.slice(0, 280))
      : [],
    files: Array.isArray(o.files)
      ? o.files
          .filter((f): f is string => typeof f === "string")
          .slice(0, 20)
          .map((f) => f.slice(0, 512))
      : [],
  };
  const parsed = PlanBodySchema.safeParse(clamped);
  return parsed.success ? parsed.data : null;
}

export function isEmptyPlan(plan: ThreadEventBody<"plan">): boolean {
  if (plan.classify) return false;
  if (plan.summary.trim().length > 0) return false;
  if (plan.steps.some((s) => s.trim().length > 0)) return false;
  return true;
}

export type PlanEmitState = { emitted: boolean };

async function sendPlanCriticEvent(args: {
  run_id: string;
  tenant_id: string;
  agent_slug: string;
  plan: ThreadEventBody<"plan">;
}): Promise<void> {
  try {
    await inngest.send({
      name: "agent.plan-critic-needed",
      data: {
        run_id: args.run_id,
        tenant_id: args.tenant_id,
        agent_slug: args.agent_slug,
        plan: args.plan,
      },
    });
  } catch (e) {
    console.warn(
      `[plan-emit] sendPlanCriticEvent failed for run=${args.run_id}: ${(e as Error).message}`,
    );
  }
}

export async function maybeEmitPlan(args: {
  text: string;
  slug: string;
  isFirstTextBlock: boolean;
  state: PlanEmitState;
  emit: (body: ThreadEventBody<"plan">) => Promise<void>;
  run_id?: string;
  tenant_id?: string;
}): Promise<{ residualText: string }> {
  const { text, slug, isFirstTextBlock, state, emit, run_id, tenant_id } = args;
  if (!PLAN_EMIT_ENABLED_SLUGS.has(slug)) return { residualText: text };
  if (state.emitted || !isFirstTextBlock) return { residualText: text };
  const plan = extractPlanBlock(text);
  if (!plan) return { residualText: text };
  if (isEmptyPlan(plan)) {
    return { residualText: text.replace(PLAN_RE, "").trim() };
  }
  state.emitted = true;
  await emit(plan);
  if (slug === "engineer" && run_id && tenant_id) {
    await sendPlanCriticEvent({
      run_id,
      tenant_id,
      agent_slug: slug,
      plan,
    });
  }
  return { residualText: text.replace(PLAN_RE, "").trim() };
}

const LEADING_PLAN_RE = /^\s*<plan>/i;

export function stripPlanBlock(text: string, slug: string): string {
  if (!PLAN_EMIT_ENABLED_SLUGS.has(slug)) return text;
  if (!text || !LEADING_PLAN_RE.test(text)) return text;
  return text.replace(PLAN_RE, "").trim();
}

export async function prependPriorPlanIfPresent(args: {
  slug: string;
  runId: string;
  sb: Pick<SupabaseClient, "from">;
}): Promise<string | null> {
  const { slug, runId, sb } = args;
  if (!PLAN_EMIT_ENABLED_SLUGS.has(slug)) return null;
  try {
    const { data, error } = await sb
      .from("thread_event")
      .select("body")
      .eq("agent_run_id", runId)
      .eq("kind", "plan")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn(
        `[plan-emit] prependPriorPlanIfPresent read failed (run=${runId}): ${error.message}`,
      );
      return null;
    }
    if (!data?.body) return null;
    const redacted = redactTrajectory(data.body).value;
    return formatPriorPlanSystemBlock(redacted);
  } catch (e) {
    console.warn(
      `[plan-emit] prependPriorPlanIfPresent threw (run=${runId}): ${(e as Error).message}`,
    );
    return null;
  }
}

export function formatPriorPlanSystemBlock(body: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(body, null, 2);
  } catch {
    return "";
  }
  if (json.length > 8000) json = json.slice(0, 8000) + "\n…[truncated]";
  return [
    "<prior_plan>",
    "Your `<plan>` block from an earlier turn of this same run. Keep using this plan unless the latest user message materially changes the ask.",
    "Do NOT re-emit `<plan>` — the dispatcher already persisted it; subsequent turns inherit it.",
    "",
    json,
    "</prior_plan>",
  ].join("\n");
}
