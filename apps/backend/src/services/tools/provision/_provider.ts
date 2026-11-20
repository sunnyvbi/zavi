
export function provisionFlagOn(flagEnv: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[flagEnv];
  if (raw === undefined || raw === "") return true;
  const v = raw.trim().toLowerCase();
  return v !== "0" && v !== "false";
}

export function cred(envKey: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[envKey];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function shouldProvisionReal(opts: {
  flagEnv: string;
  requiredCreds: string[];
  dryRunRequested: boolean;
  env?: NodeJS.ProcessEnv;
}): { real: boolean; reason: string; missingCreds: string[] } {
  const env = opts.env ?? process.env;
  if (opts.dryRunRequested) {
    return { real: false, reason: "dry_run_requested", missingCreds: [] };
  }
  if (!provisionFlagOn(opts.flagEnv, env)) {
    return { real: false, reason: "flag_off", missingCreds: [] };
  }
  const missingCreds = opts.requiredCreds.filter((k) => cred(k, env) === undefined);
  if (missingCreds.length > 0) {
    return { real: false, reason: "creds_missing", missingCreds };
  }
  return { real: true, reason: "ok", missingCreds: [] };
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
