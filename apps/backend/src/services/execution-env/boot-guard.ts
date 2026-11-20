const PROD_SUPABASE_REF = "wmycgyjsenvgtczlupoe";

export interface BootGuardResult {
  ok: boolean;
  reason?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function checkExecutionEnvSafe(env: NodeJS.ProcessEnv = process.env): BootGuardResult {
  if (env.EXECUTION_ENV !== "staging") return { ok: true };

  const url = env.SUPABASE_URL ?? "";
  const host = hostOf(url);
  const stagingRef = env.STAGING_SUPABASE_PROJECT_REF;

  if (host.includes(PROD_SUPABASE_REF) || url.includes(PROD_SUPABASE_REF)) {
    return {
      ok: false,
      reason: `EXECUTION_ENV=staging but SUPABASE_URL points at the PROD project (${PROD_SUPABASE_REF}). Refusing to boot.`,
    };
  }
  if (!stagingRef) {
    return {
      ok: false,
      reason: "EXECUTION_ENV=staging but STAGING_SUPABASE_PROJECT_REF is unset — cannot prove the process is isolated to a staging project. Refusing to boot.",
    };
  }
  if (!host.includes(stagingRef)) {
    return {
      ok: false,
      reason: `EXECUTION_ENV=staging but SUPABASE_URL host (${host || "unparseable"}) does not match STAGING_SUPABASE_PROJECT_REF (${stagingRef}). Refusing to boot.`,
    };
  }
  return { ok: true };
}

export function assertExecutionEnvSafe(env: NodeJS.ProcessEnv = process.env): void {
  const r = checkExecutionEnvSafe(env);
  if (!r.ok) throw new Error(`[boot-guard] ${r.reason}`);
}
