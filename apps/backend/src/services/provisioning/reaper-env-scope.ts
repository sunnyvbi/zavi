export interface ReaperScopeResult {
  allowed: boolean;
  reason?: string;
}

export function reaperAllowedInEnv(env: NodeJS.ProcessEnv = process.env): ReaperScopeResult {
  if (env.EXECUTION_ENV === "staging") {
    return {
      allowed: false,
      reason: "infra reaper is hard-OFF in staging (EXECUTION_ENV=staging) — staging reaping lands in Phase 2 once a complete staging vendor cred set exists. Refusing to enumerate vendor resources.",
    };
  }
  return { allowed: true };
}

export function reaperEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.INFRA_REAPER_ENABLED ?? "").trim().toLowerCase();
  return v !== "0" && v !== "false";
}
