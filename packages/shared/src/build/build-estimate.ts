const MIN = 60_000;

const APP_STAGE_EXPECTED_MS: Record<string, number> = {
  provision: 2 * MIN,
  spec: 4 * MIN,
  scaffold: 25 * MIN,
  build: 20 * MIN,
  qa: 8 * MIN,
  deploy: 5 * MIN,
};

const SITE_STAGE_EXPECTED_MS: Record<string, number> = {
  ...APP_STAGE_EXPECTED_MS,
  provision: 1 * MIN,
  build: 7 * MIN,
  deploy: 3 * MIN,
};

export function stageExpectedMs(stage: string, site: boolean): number | null {
  const table = site ? SITE_STAGE_EXPECTED_MS : APP_STAGE_EXPECTED_MS;
  return Object.prototype.hasOwnProperty.call(table, stage) ? table[stage] : null;
}

export type EstimateStage = {
  status: string;
  started_at?: string | null;
  expected_ms?: number | null;
};

export const ESTIMATE_SLOW_FACTOR = 1.25;

export const WAITING_FOR_PICK = "Waiting for you to pick a website";

export type EstimateOptions = {
  awaitingPick?: boolean;
};

const FINISHED = new Set(["done", "success", "succeeded", "skipped"]);
const STOPPED = new Set(["failed", "halted", "cancelled", "canceled"]);
const RUNNING = new Set(["active", "running", "dispatched", "building", "in_progress", "provisioning"]);

function budget(stage: EstimateStage): number | null {
  const ms = stage.expected_ms;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function buildRemainingMs(
  stages: ReadonlyArray<EstimateStage>,
  nowMs: number,
  options: EstimateOptions = {},
): number | null {
  if (options.awaitingPick === true) return null;
  let remaining = 0;
  let open = false;
  for (const stage of stages) {
    if (FINISHED.has(stage.status)) continue;
    if (STOPPED.has(stage.status)) return null;
    const expected = budget(stage);
    if (expected === null) return null;
    open = true;
    if (!RUNNING.has(stage.status)) {
      remaining += expected;
      continue;
    }
    const start = stage.started_at ? Date.parse(stage.started_at) : NaN;
    const spent = Number.isFinite(start) ? Math.max(0, nowMs - start) : 0;
    if (spent > ESTIMATE_SLOW_FACTOR * expected) return null;
    remaining += Math.max(0, expected - spent);
  }
  return open ? remaining : null;
}

export function buildEstimateText(
  stages: ReadonlyArray<EstimateStage>,
  nowMs: number,
  options: EstimateOptions = {},
): string | null {
  if (options.awaitingPick === true) return WAITING_FOR_PICK;
  const ms = buildRemainingMs(stages, nowMs);
  if (ms === null) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
}

export function currentBuildStage<T extends EstimateStage & { stage: string }>(stages: ReadonlyArray<T>): string | null {
  const running = stages.find((s) => RUNNING.has(s.status));
  if (running) return running.stage;
  const next = stages.find((s) => !FINISHED.has(s.status));
  return next ? next.stage : null;
}
