export type ScreenGroup =
  | "auth"
  | "onboarding"
  | "chat"
  | "agents"
  | "build"
  | "growth"
  | "analytics"
  | "channels"
  | "messaging"
  | "connectors"
  | "toolkit"
  | "settings"
  | "billing"
  | "creator"
  | "invite"
  | "other";

export function failureReason(error: unknown): "timeout" | "network" | "server" {
  if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") return "timeout";
  if (error instanceof TypeError) return "network";
  return "server";
}

export function appEnvironment(isDev: boolean, appEnv: string | undefined): "production" | "development" {
  return !isDev && appEnv === "production" ? "production" : "development";
}

const BACKEND_MIXPANEL_EVENTS = new Set([
  "chat_message_sent",
  "connector_connected",
  "product_feedback_submitted",
]);

export function sendsToMixpanel(event: string): boolean {
  return !BACKEND_MIXPANEL_EVENTS.has(event);
}

type KeyValueStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export async function firstThisDevice(store: KeyValueStore, key: string): Promise<boolean> {
  try {
    if (await store.getItem(key)) return false;
    await store.setItem(key, "1");
    return true;
  } catch {
    return true;
  }
}

const GROUPS = new Set<ScreenGroup>([
  "chat",
  "agents",
  "build",
  "growth",
  "analytics",
  "channels",
  "messaging",
  "connectors",
  "toolkit",
  "settings",
  "creator",
  "invite",
]);

export function screenFromSegments(segments: string[]): { screen_name: string; screen_group: ScreenGroup } {
  let routeGroup: ScreenGroup | null = null;
  const nameSegments = segments.filter((segment) => {
    if (segment === "(auth)") routeGroup = "auth";
    else if (segment === "(onboarding)") routeGroup = "onboarding";
    else return true;
    return false;
  });
  const screen_name = nameSegments.join("/") || "index";
  const first = nameSegments[0];
  const screen_group =
    routeGroup ??
    (first === "settings" && nameSegments[1] === "billing"
      ? "billing"
      : first === "growth-setup" || first === "growth-review"
        ? "growth"
        : GROUPS.has(first as ScreenGroup)
          ? (first as ScreenGroup)
          : "other");
  return { screen_name, screen_group };
}

export type AuthAnalyticsUser = {
  created_at: string;
  last_sign_in_at?: string | null;
  app_metadata?: { provider?: string | null } | null;
};

export function authAnalyticsEvent(user: AuthAnalyticsUser): {
  event: "signup_completed" | "logged_in";
  method: string;
} {
  const created = Date.parse(user.created_at);
  const signedIn = user.last_sign_in_at ? Date.parse(user.last_sign_in_at) : created;
  const signup = signedIn - created < 60_000;
  return {
    event: signup ? "signup_completed" : "logged_in",
    method: user.app_metadata?.provider ?? "email",
  };
}
