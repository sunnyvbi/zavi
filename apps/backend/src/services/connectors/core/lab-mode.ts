
export function isVariantsLabProcess(): boolean {
  return process.env.PRAXIS_VARIANTS_LAB === "1";
}

export function labRefreshRefusedMessage(provider: string): string {
  return `variants lab: ${provider} token needs a refresh; skipped so prod credentials aren't rotated`;
}

export function isMirrorProcess(): boolean {
  return process.env.PRAXIS_MIRROR === "1";
}

export const ROTATING_REFRESH_PROVIDERS: ReadonlySet<string> = new Set([
  "jira",
  "x_social",
  "tiktok",
  "reddit_ads",
  "reddit_social",
  "microsoft_ads",
  "snapchat_ads",
  "pinterest_ads",
  "higgsfield",
]);

export function mirrorRefreshRefusedMessage(provider: string): string {
  return `mirror: ${provider} token expired; it rotates on refresh, so refresh it in prod and re-run the mirror copy`;
}

export function assertNoLabRefresh(provider: string): void {
  if (isVariantsLabProcess()) throw new Error(labRefreshRefusedMessage(provider));
  if (isMirrorProcess() && ROTATING_REFRESH_PROVIDERS.has(provider)) {
    throw new Error(mirrorRefreshRefusedMessage(provider));
  }
}
