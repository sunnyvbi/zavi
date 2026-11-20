
import type { AgentContext, DispatcherResult } from "@/services/agents/types";
import { makeDraftCtx } from "@/services/agents/generic-dispatcher";

export { planIncludesChannel, isPreviewClaim, isDryPreviewRun, previewRunMode, asPreviewRunMode } from "./preview-plan";
export type { PreviewRunMode } from "./preview-plan";

export {
  PREVIEW_READ_TOOLS,
  PREVIEW_DENIED_TOOLS,
  PREVIEW_KEEP_CARDS_TOOLS,
  PREVIEW_TOOL_DENIED_REASON,
  isPreviewAllowedTool,
} from "./preview-tools";

export function makePreviewDryCtx(ctx: AgentContext, opts: { keepCards?: boolean } = {}): AgentContext {
  return { ...makeDraftCtx(ctx), preview_dry: true, ...(opts.keepCards === true ? { preview_keep_cards: true } : {}) };
}

export function stripDryPreviewResult(result: DispatcherResult): DispatcherResult {
  return {
    output_text: "",
    parsed: null,
    parse_ok: result.parse_ok === true,
    raw_response_text: "",
    prompt_snapshot: "",
    usage: result.usage,
    ...(result.auth_seat ? { auth_seat: result.auth_seat } : {}),
    ...(result.routing ? { routing: result.routing } : {}),
    ...(result.stop_reason ? { stop_reason: result.stop_reason } : {}),
    side_effect: { kind: "none" },
    preview_action_types: Array.isArray(result.preview_action_types)
      ? result.preview_action_types.filter((t): t is string => typeof t === "string").slice(0, 50)
      : [],
  };
}

export const PREVIEW_RUN_FAILED = "preview_run_failed";
