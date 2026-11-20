
export const PROD_SUPABASE_REF = "wmycgyjsenvgtczlupoe";

const SUFFIX_RE = /^(-[a-z0-9]{1,10})?$/;

export function isProdBackend(env: Record<string, string | undefined> = process.env): boolean {
  try {
    return new URL(String(env.SUPABASE_URL ?? "")).hostname.toLowerCase() === `${PROD_SUPABASE_REF}.supabase.co`;
  } catch {
    return false;
  }
}

export class NonProdEnvNotIsolated extends Error {
  constructor(public readonly missing_key: string) {
    super(`${missing_key} is required on a backend that is not on the prod Supabase project`);
    this.name = "NonProdEnvNotIsolated";
  }
}

export function envHostSuffix(env: Record<string, string | undefined> = process.env): string {
  const suffix = String(env.SITE_HOSTNAME_SUFFIX ?? "").trim();
  if (!SUFFIX_RE.test(suffix)) throw new NonProdEnvNotIsolated("a valid SITE_HOSTNAME_SUFFIX (e.g. -dev)");
  if (!suffix && !isProdBackend(env)) throw new NonProdEnvNotIsolated("SITE_HOSTNAME_SUFFIX (e.g. -dev)");
  return suffix;
}
