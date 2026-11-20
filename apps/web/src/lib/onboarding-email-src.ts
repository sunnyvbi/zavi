export const ONBOARDING_SRC_RE = /^onb_([1-9][0-9]?)$/;

export function onboardingSrcOf(src: unknown): string | null {
  return typeof src === "string" && ONBOARDING_SRC_RE.test(src) ? src : null;
}
