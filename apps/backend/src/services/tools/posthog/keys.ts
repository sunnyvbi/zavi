
export const POSTHOG_VAULT_KEYS = {
  api_key: "posthog.api_key",
  project_id: "posthog.project_id",
  region: "posthog.region",
} as const;

export type PosthogRegion = "us" | "eu";

export const POSTHOG_HOSTS: Record<PosthogRegion, string> = {
  us: "https://us.posthog.com",
  eu: "https://eu.posthog.com",
};

export function isPosthogRegion(v: unknown): v is PosthogRegion {
  return v === "us" || v === "eu";
}
