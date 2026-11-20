
import { runGeneric } from "@/services/agents/generic-dispatcher";
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import { productPmBacklogSchema } from "./output-schema";
import { processProductPmBacklog } from "./post-run";
import { classifyProductPmMode } from "./classify";
import { deliberatePmEnvelope } from "./deliberation";

export async function productPmPostProcess(
  ctx: AgentContext,
  result: DispatcherResult,
  payload?: unknown,
): Promise<void> {
  if (!result.parse_ok || !result.parsed) return;
  await deliberatePmEnvelope(ctx, result);
  if (
    typeof result.parsed === "object" &&
    result.parsed !== null &&
    (result.parsed as { refused?: unknown }).refused === true
  ) {
    delete (result.parsed as { artifact_label?: unknown }).artifact_label;
  }
  const parsed = productPmBacklogSchema.safeParse(result.parsed);
  if (!parsed.success) {
    console.warn(
      `[pm post-process] envelope schema mismatch — skipping post-run: ${parsed.error.issues[0]?.message ?? parsed.error.message}`,
    );
    return;
  }
  const rawMode = (payload as { mode?: unknown } | undefined)?.mode;
  const runMode: PostRunMode = toRunMode(rawMode);
  const isBuildAppSpec = (payload as { stage?: unknown } | undefined)?.stage === "spec";
  const engineerHandoff =
    (payload as { pm_engineer_handoff?: unknown } | undefined)
      ?.pm_engineer_handoff === true;
  const operatorDbReadThisRun = (result.tool_calls ?? []).some(
    (t) => typeof t.name === "string" && t.name.startsWith("operator_db"),
  );
  const operatorDbTraces = (result.tool_calls ?? []).filter(
    (t) => typeof t.name === "string" && t.name.startsWith("operator_db"),
  );
  try {
    const { brief, dispatched, skipped } = await processProductPmBacklog(
      ctx,
      parsed.data,
      { runMode, isBuildAppSpec, operatorDbReadThisRun, operatorDbTraces, engineerHandoff },
    );
    result.parsed = brief;
    if (typeof brief.rendered_markdown === "string" && brief.rendered_markdown.length > 0) {
      const dispatcherRescued =
        !!result.envelope_rescue_kind && parsed.data.status !== "actionable";
      if (!dispatcherRescued) {
        result.output_text = brief.rendered_markdown;
      }
    }
    console.log(
      `[pm post-process] mode=${runMode} dispatched=${dispatched.length} skipped=${skipped.length} (${skipped.map((s) => s.reason).join(",")})`,
    );
  } catch (e) {
    const msg = (e as Error).message;
    console.warn(`[pm post-process] post-run failed: ${msg}`);
    result.parse_error = result.parse_error
      ? `${result.parse_error}; post_run_failed:${msg.slice(0, 200)}`
      : `post_run_failed:${msg.slice(0, 200)}`;
  }
}

export type PostRunMode = "delivery" | "strategy_memo" | "iterate";

export type PmPromptMode = PostRunMode | "build_spec";

export function pmPromptMode(args: {
  stage: unknown;
  trigger: string | undefined;
  userText: string;
}): PmPromptMode {
  if (args.stage === "spec") return "build_spec";
  return classifyProductPmMode({ trigger: args.trigger, userText: args.userText });
}

export function toRunMode(rawMode: unknown): PostRunMode {
  return rawMode === "iterate" || rawMode === "strategy_memo" ? rawMode : "delivery";
}

export async function productPmDispatcher(
  ctx: AgentContext,
  payload: unknown,
): Promise<DispatcherResult> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const userText = typeof p.goal === "string" ? p.goal : "";
  const mode = pmPromptMode({ stage: p.stage, trigger: ctx.trigger, userText });
  const result = await runGeneric(ctx, { ...p, mode });
  await productPmPostProcess(ctx, result, p);
  return result;
}

export function __classifyForTest(trigger: string, userText: string): string {
  return classifyProductPmMode({ trigger, userText });
}
