
import {
  AGENT_DISPATCH_STAGES,
  DECISION_CLASS,
  type PipelineStage,
} from "@/services/agents/autopilot-pipeline-contract";

const AUTOPILOT_STAGES: ReadonlySet<string> = new Set<string>(AGENT_DISPATCH_STAGES);

const AUTOPILOT_DECISION_CLASSES: ReadonlySet<string> = new Set<string>([
  DECISION_CLASS.PROVISION_REPO,
  DECISION_CLASS.PROVISION_HOSTING,
  DECISION_CLASS.PROVISION_DOMAIN,
  DECISION_CLASS.PROVISION_EMAIL,
]);

export const AUTOPILOT_ELIGIBLE_CLASSES: readonly string[] = [
  ...AGENT_DISPATCH_STAGES,
  ...AUTOPILOT_DECISION_CLASSES,
] as const;

export function isAutopilotClassRun(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;

  const stage = p.stage;
  if (typeof stage === "string" && AUTOPILOT_STAGES.has(stage)) return true;

  const decisionClass = p.decision_class;
  if (typeof decisionClass === "string" && AUTOPILOT_DECISION_CLASSES.has(decisionClass)) {
    return true;
  }

  return false;
}

export function autopilotStageOf(payload: unknown): PipelineStage | null {
  if (!payload || typeof payload !== "object") return null;
  const stage = (payload as Record<string, unknown>).stage;
  return typeof stage === "string" && AUTOPILOT_STAGES.has(stage)
    ? (stage as PipelineStage)
    : null;
}

export const AUTOPILOT_ENFORCED_FLAG = {
  pattern: "autopilot_grounding_enforced",
  severity: "hard",
} as const;
