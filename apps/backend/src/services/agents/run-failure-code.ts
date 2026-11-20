export function hasRunFailureCode(e: unknown): e is Error & { run_failure_code: string } {
  if (!(e instanceof Error)) return false;
  const code = (e as unknown as { run_failure_code?: unknown }).run_failure_code;
  return typeof code === "string" && code.length > 0;
}

export const APP_DATABASE_SETUP_FAILED_COPY =
  "Couldn't set up your site's database. No changes were published. Retry.";

export const APP_HOSTING_NOT_READY_COPY =
  "Couldn't set up your site's hosting. No changes were published. Retry.";

export function appSetupFailureCopy(signal: string | null | undefined): string {
  return (signal ?? "").includes(APP_HOSTING_NOT_READY_COPY)
    ? APP_HOSTING_NOT_READY_COPY
    : APP_DATABASE_SETUP_FAILED_COPY;
}

export const BUILDER_POLICY_REFUSED_CODE = "builder_policy_refused";

export class BuilderPolicyRefusedError extends Error {
  readonly run_failure_code = BUILDER_POLICY_REFUSED_CODE;
  readonly paths: readonly string[];
  constructor(paths: readonly string[], founderCopy: string) {
    super(`${BUILDER_POLICY_REFUSED_CODE}: ${founderCopy}`);
    this.name = "BuilderPolicyRefusedError";
    this.paths = paths;
  }
}

export function isBuilderPolicyRefusal(signal: string | null | undefined): boolean {
  return typeof signal === "string" && /\bbuilder_policy_refused:/.test(signal);
}

export function builderPolicyRefusalCopy(signal: string | null | undefined): string | null {
  if (!isBuilderPolicyRefusal(signal)) return null;
  const copy = (signal as string).slice((signal as string).indexOf("builder_policy_refused:") + "builder_policy_refused:".length);
  return copy.split("\n")[0].trim() || null;
}
