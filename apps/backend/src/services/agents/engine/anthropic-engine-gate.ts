
function isTruthyFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "on" || v === "1" || v === "true" || v === "all" || v === "yes";
}

function parseCsvTenants(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function shouldUseAnthropicEngine(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
  configAllowlist?: readonly unknown[],
): boolean {
  try {
    if (!tenantId) return false;

    const flag = env.PRAXIS_ANTHROPIC_ENGINE;

    if (isTruthyFlag(flag)) return true;

    const envAllow = parseCsvTenants(env.PRAXIS_ANTHROPIC_ENGINE_TENANTS);
    if (envAllow.has(tenantId)) return true;

    if (Array.isArray(configAllowlist)) {
      if (
        configAllowlist.some(
          (entry) => typeof entry === "string" && entry === tenantId,
        )
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}
