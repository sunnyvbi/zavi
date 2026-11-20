import { PASTE_RUN_STAGE } from "@/services/email-cards/paste-run";

export const REQUESTED_VIDEO_RUN_STAGE = "generated-video-requested-card";

const RECORD_ONLY_RUN_STAGES: ReadonlySet<string> = new Set([PASTE_RUN_STAGE, REQUESTED_VIDEO_RUN_STAGE]);

export function isRecordOnlyRun(agentDefinitionHash: unknown): boolean {
  return typeof agentDefinitionHash === "string" && RECORD_ONLY_RUN_STAGES.has(agentDefinitionHash);
}
