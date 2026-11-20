export const SDK_RUN_CEILING_CODE = "sdk_run_ceiling" as const;

export class SdkRunCeilingError extends Error {
  readonly run_failure_code = SDK_RUN_CEILING_CODE;
  constructor(ceilingMs: number) {
    const minutes = Math.max(1, Math.round(ceilingMs / 60_000));
    super(`${SDK_RUN_CEILING_CODE}: the run hit its ${minutes}-minute time limit and was stopped`);
    this.name = "SdkRunCeilingError";
  }
}

export function relabelIfCeilingHit(err: unknown, ceilingHit: boolean, ceilingMs: number): unknown {
  if (!ceilingHit) return err;
  if (err instanceof SdkRunCeilingError) return err;
  const msg = err instanceof Error ? err.message : "";
  if (msg === "run_cancelled" || msg === "kill_switch") return err;
  return new SdkRunCeilingError(ceilingMs);
}
