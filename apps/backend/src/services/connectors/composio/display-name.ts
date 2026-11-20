export const TOOLKIT_NAME_OVERRIDES: Record<string, string> = {
  hubspot: "HubSpot",
  clickup: "ClickUp",
  posthog: "PostHog",
  googlesheets: "Google Sheets",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  google_analytics: "Google Analytics",
  microsoft_teams: "Microsoft Teams",
  linkedin: "LinkedIn",
  github: "GitHub",
  gitlab: "GitLab",
};

export function toolkitDisplayName(slug: string): string {
  if (TOOLKIT_NAME_OVERRIDES[slug]) return TOOLKIT_NAME_OVERRIDES[slug];
  return slug
    .split(/[_-]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}
