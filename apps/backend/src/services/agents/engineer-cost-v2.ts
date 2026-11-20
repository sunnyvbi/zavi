
import { getSetting } from "@/services/settings";
import { MODELS } from "@/services/llm/models";
import { isSdkHarnessMetaTool } from "@/services/agents/sdk-builtins";

export const ENGINEER_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EngineerEffort = (typeof ENGINEER_EFFORTS)[number];

export type EngineerCostV2Config = {
  enabled: boolean;
  deepEffort: EngineerEffort;
};

export const ENGINEER_COST_V2_DEFAULTS: EngineerCostV2Config = {
  enabled: true,
  deepEffort: "high",
};

export function engineerCostV2FromValues(
  rawEnabled: unknown,
  rawEffort: unknown,
): EngineerCostV2Config {
  const enabled = !(rawEnabled === false || rawEnabled === "false");
  const deepEffort =
    typeof rawEffort === "string" && (ENGINEER_EFFORTS as readonly string[]).includes(rawEffort)
      ? (rawEffort as EngineerEffort)
      : ENGINEER_COST_V2_DEFAULTS.deepEffort;
  return { enabled, deepEffort };
}

type SettingGetter = (key: "engineer_cost_v2" | "engineer_deep_effort") => Promise<unknown>;

export async function loadEngineerCostV2Config(
  get: SettingGetter = (k) => getSetting(k),
): Promise<EngineerCostV2Config> {
  try {
    const [enabled, effort] = await Promise.all([
      get("engineer_cost_v2"),
      get("engineer_deep_effort"),
    ]);
    return engineerCostV2FromValues(enabled, effort);
  } catch (e) {
    console.warn(
      `[engineer-cost-v2] settings read failed, using defaults: ${(e as Error).message}`,
    );
    return { ...ENGINEER_COST_V2_DEFAULTS };
  }
}

function rejectedThinkingTypes(model: string): readonly string[] {
  if (model === MODELS.anthropic.opus || model === MODELS.anthropic.sonnet) {
    return ["disabled", "enabled"];
  }
  if (model === "claude-sonnet-5") return ["enabled"];
  return [];
}

export function sdkRunModelFor(variantModel: string | undefined, agentModel: string): string {
  return variantModel ?? agentModel;
}

const AGENT_DEFAULT_EFFORT: Readonly<Record<string, { model: string; effort: EngineerEffort }>> = {
  operator: { model: MODELS.anthropic.sonnet, effort: "xhigh" },
  cgo: { model: MODELS.anthropic.opus, effort: "xhigh" },
};

export function agentDefaultEffort(agentSlug: string, model: string): EngineerEffort | undefined {
  const entry = AGENT_DEFAULT_EFFORT[agentSlug];
  return entry && entry.model === model ? entry.effort : undefined;
}

export function sdkOptionsForModel(args: {
  agentSlug: string;
  model: string;
  variantOptions: Record<string, unknown>;
  costV2: EngineerCostV2Config | null;
}): { options: Record<string, unknown>; strippedThinking: string | null } {
  const options = { ...args.variantOptions };
  let strippedThinking: string | null = null;
  const thinking = options.thinking as { type?: string } | undefined;
  if (thinking?.type && rejectedThinkingTypes(args.model).includes(thinking.type)) {
    strippedThinking = thinking.type;
    delete options.thinking;
  }
  if (options.effort === undefined) {
    const agentDefault = agentDefaultEffort(args.agentSlug, args.model);
    if (agentDefault) options.effort = agentDefault;
  }
  if (args.model === MODELS.anthropic.opus && options.effort === undefined) {
    options.effort =
      args.agentSlug === "engineer" && args.costV2?.enabled ? args.costV2.deepEffort : "high";
  }
  return { options, strippedThinking };
}

export const ENGINEER_V2_EPISODIC_K = 5;

export function engineerTaskText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const p = payload as Record<string, unknown>;
  for (const key of [
    "current_message",
    "current_user_text_raw",
    "task_description",
    "intent",
    "text",
  ]) {
    const v = p[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

const CODE_RUN_TRIGGERS = new Set(["handoff", "a2a", "slack", "manual"]);

export function isEngineerCodeRun(trigger: string, payload: unknown): boolean {
  const p =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  if (typeof p.stage === "string" && p.stage.length > 0) return true;
  if (trigger === "chat") return p.cto_chat_intent === "ship";
  return CODE_RUN_TRIGGERS.has(trigger) && engineerTaskText(p).length > 0;
}

export const ENGINEER_V2_STEP_CAPS: Readonly<Record<string, number>> = {
  [MODELS.anthropic.sonnet]: 40,
  [MODELS.anthropic.opus]: 80,
  "claude-sonnet-5": 40,
};

export function engineerStepCap(args: {
  agentSlug: string;
  model: string;
  costV2Enabled: boolean;
}): number | null {
  if (args.agentSlug !== "engineer" || !args.costV2Enabled) return null;
  return ENGINEER_V2_STEP_CAPS[args.model] ?? null;
}

export const STEP_WARNING_FROM = 0.75;

export function stepBudgetWarning(used: number, cap: number): string | null {
  if (cap <= 0 || used < Math.ceil(cap * STEP_WARNING_FROM)) return null;
  const left = Math.max(0, cap - used);
  return (
    `${left} steps left: finish or hand back. ` +
    `To hand back, stop calling tools and emit your pr_proposal with "incomplete": true ` +
    `and a "remaining" list of what is left; what you changed so far opens as a PR marked incomplete.`
  );
}

export const STEP_HANDBACK_TURNS = 2;

export const STEP_BUDGET_SPENT_REASON =
  "Step budget reached: hand back now. No more tool calls will run. Stop calling tools and emit your " +
  'pr_proposal with "incomplete": true and a "remaining" list of what is left. ' +
  "Another tool call ends the run.";

type StepPostOutput = {
  hookSpecificOutput?: {
    hookEventName: "PostToolUse" | "PostToolUseFailure";
    additionalContext: string;
  };
};
type StepPreOutput = {
  continue?: false;
  stopReason?: string;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
};

export function makeStepBudgetHook(
  cap: number,
  onStop: () => void = () => {},
): {
  pre: (input?: { tool_name?: unknown }) => Promise<StepPreOutput>;
  hook: (input: { hook_event_name?: string; tool_name?: unknown }) => Promise<StepPostOutput>;
  noteAssistantMessage: (messageId: string | undefined) => void;
  used: () => number;
  exhausted: () => boolean;
  stopped: () => boolean;
} {
  let used = 0;
  let turn = 0;
  let lastMessageId: string | undefined;
  let exhaustedTurn: number | null = null;
  let stopped = false;
  const deny = (reason: string) => ({
    hookEventName: "PreToolUse" as const,
    permissionDecision: "deny" as const,
    permissionDecisionReason: reason,
  });
  return {
    used: () => used,
    exhausted: () => used >= cap,
    stopped: () => stopped,
    noteAssistantMessage: (messageId) => {
      if (!messageId || messageId === lastMessageId) return;
      lastMessageId = messageId;
      turn += 1;
    },
    pre: async (input) => {
      if (isSdkHarnessMetaTool(input?.tool_name)) return {};
      if (used < cap) {
        used += 1;
        if (used === cap) exhaustedTurn = turn;
        return {};
      }
      if (!stopped && exhaustedTurn !== null && turn === exhaustedTurn) {
        return { hookSpecificOutput: deny(STEP_BUDGET_SPENT_REASON) };
      }
      if (!stopped) {
        stopped = true;
        onStop();
      }
      return {
        continue: false,
        stopReason: "step_budget_exhausted",
        hookSpecificOutput: deny(STEP_BUDGET_SPENT_REASON),
      };
    },
    hook: async (input) => {
      if (isSdkHarnessMetaTool(input?.tool_name)) return {};
      const warning = stepBudgetWarning(used, cap);
      if (!warning) return {};
      const hookEventName =
        input?.hook_event_name === "PostToolUseFailure" ? "PostToolUseFailure" : "PostToolUse";
      return { hookSpecificOutput: { hookEventName, additionalContext: warning } };
    },
  };
}

export type ProductBuildLane = "small_edit" | "scaffold";

export function productBuildLane(payload: unknown): ProductBuildLane | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p.stage === "scaffold") return "scaffold";
  if (p.stage === "build" && p.refine_mode === true && p.small_edit === true && p.repair_mode !== true) {
    return "small_edit";
  }
  return null;
}
