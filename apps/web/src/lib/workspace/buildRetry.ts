import type { BuildStageRow } from "./useBuildPreview";

const RETRY_STEP_NAME: Record<string, string> = {
  provision: "workspace setup",
  spec: "request",
  scaffold: "app structure",
  build: "interface",
  qa: "app checks",
  deploy: "publishing",
};

const RUNNING_STAGE: ReadonlySet<string> = new Set([
  "active",
  "building",
  "dispatched",
  "in_progress",
  "provisioning",
  "queued",
  "running",
]);

export function retryingStepLabel(stages: ReadonlyArray<BuildStageRow>): string | null {
  for (const stage of stages) {
    if (!RUNNING_STAGE.has(stage.status)) continue;
    if (typeof stage.attempt !== "number" || !Number.isFinite(stage.attempt) || stage.attempt < 2) continue;
    const name = RETRY_STEP_NAME[stage.stage];
    if (!name) continue;
    return `Retrying ${name}, attempt ${Math.floor(stage.attempt)}`;
  }
  return null;
}
