
export function isStaging(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXECUTION_ENV === "staging";
}

export function resolveIssuerUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (isStaging(env) && env.STAGING_ISSUER_URL) return env.STAGING_ISSUER_URL;
  return env.PRAXIS_ISSUER_URL ?? "https://api.zaviagent.com";
}

export function resolveInngestServeHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isStaging(env) && env.STAGING_INNGEST_SERVE_HOST) return env.STAGING_INNGEST_SERVE_HOST;
  return env.INNGEST_SERVE_HOST;
}

export function resolveInngestAppId(env: NodeJS.ProcessEnv = process.env): string {
  return isStaging(env) ? "praxis-staging" : "praxis";
}
