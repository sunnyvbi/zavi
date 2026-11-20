import { tabUrlParam } from "@/lib/workspace/tabUrl";

export const START_ROUTE = "/start";
export const WEBSITE_PAST_WORK_ROUTE = "/onboarding/past-work";
export const WORKSPACE_ROUTE = "/workspace";
export const PAST_WORK_MODE_PARAM = "pastWork";
export const WEBSITE_RESUME_PARAM = "resume";
export const CONNECT_SEARCH_PARAM = "connectSearch";
export const CONNECT_APP_PARAM = "connectApp";
export const CONNECT_ERROR_PARAM = "composio_error";
export const SETUP_STEP_PARAM = "setupStep";
export type SetupScreen = "past-work" | "connect-apps" | "your-business";
export const SETUP_PAST_WORK_STEP: SetupScreen = "past-work";
export const SETUP_CONNECT_STEP: SetupScreen = "connect-apps";
export const SETUP_BUSINESS_STEP: SetupScreen = "your-business";
export const SETUP_CONNECTORS_PARAM = "connectors";
export const WORKSPACE_CONNECT_APPS_ROUTE = `${WORKSPACE_ROUTE}?tab=${tabUrlParam("autopilot")}&${SETUP_STEP_PARAM}=${SETUP_CONNECT_STEP}`;
export const ONBOARDING_QUERY_PARAMS = [PAST_WORK_MODE_PARAM, CONNECT_SEARCH_PARAM, CONNECT_APP_PARAM, SETUP_STEP_PARAM, SETUP_CONNECTORS_PARAM] as const;

export function setupNavigationHref(
  pathname: string,
  params: URLSearchParams,
  changes: Partial<Record<typeof CONNECT_SEARCH_PARAM | typeof CONNECT_APP_PARAM | typeof CONNECT_ERROR_PARAM | "connect_error" | "provider" | typeof SETUP_STEP_PARAM | typeof PAST_WORK_MODE_PARAM | typeof SETUP_CONNECTORS_PARAM, string | null>>,
  hash: string,
): string {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  const query = next.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}

export function websiteSignupNext(
  website: string,
  params: URLSearchParams,
): string {
  const next = new URLSearchParams(params);
  next.delete("step");
  next.delete("plan");
  next.delete("term");
  next.set("website", website);
  next.set(WEBSITE_RESUME_PARAM, "website");
  return `${WEBSITE_PAST_WORK_ROUTE}?${next}`;
}

export function websiteResearchHref(website: string, params: URLSearchParams): string {
  const next = new URLSearchParams(params);
  next.delete(WEBSITE_RESUME_PARAM);
  next.set("website", website);
  return `${START_ROUTE}?${next}`;
}

export function isOnboardingNext(next: string | null | undefined): next is string {
  return !!next && (next.startsWith(START_ROUTE) || next.startsWith(WEBSITE_PAST_WORK_ROUTE));
}

export function onboardingLoginHref(next: string): string {
  return `/login?signup=1&next=${encodeURIComponent(next)}`;
}

export function pastWorkModeHref(
  pathname: string,
  params: URLSearchParams,
  mode: "paste" | "files",
  hash: string,
): string {
  const next = new URLSearchParams(params);
  if (mode === "files") next.set(PAST_WORK_MODE_PARAM, mode);
  else next.delete(PAST_WORK_MODE_PARAM);
  const query = next.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}
