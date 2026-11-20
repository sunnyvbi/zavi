
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import { serviceClient } from "@/services/supabase";
import { tagOperatorFailureShapes } from "./failure-shapes";

async function readClassifyTier(
  runId: string,
): Promise<"tier1" | "tier2" | "tier3" | null> {
  try {
    const { data, error } = await serviceClient()
      .from("thread_event")
      .select("body")
      .eq("agent_run_id", runId)
      .eq("kind", "plan")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data?.body) return null;
    const tier = (data.body as { classify?: { tier?: unknown } }).classify?.tier;
    if (tier === "tier1" || tier === "tier2" || tier === "tier3") return tier;
    return null;
  } catch {
    return null;
  }
}

function extractQuestion(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const k of ["current_message", "intent", "user_text", "text", "question", "prompt", "message"]) {
    if (typeof p[k] === "string" && (p[k] as string).length > 0) return p[k] as string;
  }
  return null;
}

export async function operatorPostProcess(
  ctx: AgentContext,
  result: DispatcherResult,
  payload?: unknown,
): Promise<void> {
  try {
    const classify_tier = await readClassifyTier(ctx.runId);
    const shapes = tagOperatorFailureShapes({
      output_text: result.output_text,
      classify_tier,
      tool_calls: result.tool_calls,
      question: extractQuestion(payload),
    });
    result.operator_failure_shapes = shapes;
    if (shapes.length > 0) {
      console.log(
        `[operator post-run] tagged failure shapes for run=${ctx.runId}: ${shapes.join(",")}`,
      );
    }
  } catch (e) {
    console.warn(
      `[operator post-run] failure-shape tagging threw for run=${ctx.runId}: ${(e as Error).message}`,
    );
  }
}
