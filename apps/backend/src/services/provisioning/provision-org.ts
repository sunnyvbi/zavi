export const DEFAULT_PROVISION_ORG = "praxis-built";

export function resolveProvisionOrg(env: Record<string, string | undefined> = process.env): string {
  const org = (env.PRAXIS_GITHUB_ORG ?? "").trim();
  return org || DEFAULT_PROVISION_ORG;
}
