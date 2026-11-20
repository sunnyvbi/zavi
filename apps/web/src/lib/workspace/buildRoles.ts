export const START_SITE_ROLE_ERROR =
  "Only an owner or admin can start a new site in this workspace. You can still change the sites you have.";

export const START_SITE_VIEWER_ERROR = "Only an owner or admin can start a new site in this workspace.";

export function canStartNewSite(role: string | null | undefined): boolean {
  return role == null || role === "owner" || role === "admin";
}

export function startSiteRefusal(role: string | null | undefined): string | null {
  if (canStartNewSite(role)) return null;
  return role === "viewer" ? START_SITE_VIEWER_ERROR : START_SITE_ROLE_ERROR;
}
