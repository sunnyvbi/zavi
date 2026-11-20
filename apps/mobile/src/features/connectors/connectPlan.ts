import {
  COMPOSIO_PREFIX,
  PIPEDREAM_PREFIX,
  UMBRELLA_GITHUB_LOGIN,
  connectorSettingsPath,
  railFor,
  satisfyingSlugs,
  type ConnectInfo,
} from "@zavi/shared";

const WEB = "https://www.zaviagent.com";

export type KeyFormKind = "stripe" | "operator_db" | "posthog" | "sentry" | "figma" | "supabase";

export type ConnectPlan =
  | { kind: "oauth"; path: string }
  | { kind: "composio"; toolkit: string }
  | { kind: "form"; form: KeyFormKind }
  | { kind: "web"; url: string };

const startPath = (route: string) => `/api/connectors/${route}/start`;

const DEDICATED_OAUTH_ROUTES: Readonly<Record<string, string>> = {
  meta_ads: "meta-ads",
  google_ads: "google-ads",
  google_analytics: "google-analytics",
  google_search_console: "google-search-console",
  google_calendar: "google-calendar",
  google_sheets: "google-sheets",
};

const RAIL_APPS: Readonly<Record<string, string>> = {
  instagram_social: "instagram",
  reddit_social: "reddit",
};

const PIPEDREAM_TO_COMPOSIO: Readonly<Record<string, string>> = {
  instagram_business: "instagram",
  youtube_data_api: "youtube",
  youtube_analytics_api: "youtube",
};

const KEY_FORMS: ReadonlySet<string> = new Set<KeyFormKind>([
  "stripe",
  "operator_db",
  "posthog",
  "sentry",
  "figma",
  "supabase",
]);

const KEY_FORM_OAUTH: Readonly<Record<string, string>> = {
  higgsfield: startPath("higgsfield"),
};

function railPlan(toolkit: string, nativeRoute: string): ConnectPlan {
  return railFor(toolkit) === "composio"
    ? { kind: "composio", toolkit }
    : { kind: "oauth", path: startPath(nativeRoute) };
}

function webPlan(info: ConnectInfo): ConnectPlan {
  return { kind: "web", url: `${WEB}${connectorSettingsPath(info)}` };
}

export function planConnect(slug: string, info: ConnectInfo): ConnectPlan {
  if (info.connect === "key_form") {
    if (KEY_FORMS.has(slug)) return { kind: "form", form: slug as KeyFormKind };
    const oauth = KEY_FORM_OAUTH[slug];
    if (oauth) return { kind: "oauth", path: oauth };
    return webPlan(info);
  }
  if (info.connect === "composio") {
    return { kind: "composio", toolkit: slug.startsWith(COMPOSIO_PREFIX) ? slug.slice(COMPOSIO_PREFIX.length) : slug };
  }
  if (info.connect === "pipedream") {
    const app = slug.startsWith(PIPEDREAM_PREFIX) ? slug.slice(PIPEDREAM_PREFIX.length) : slug;
    const twin = Object.prototype.hasOwnProperty.call(PIPEDREAM_TO_COMPOSIO, app) ? PIPEDREAM_TO_COMPOSIO[app] : undefined;
    if (twin === "instagram") return railPlan(twin, "instagram_social");
    if (twin) return { kind: "composio", toolkit: twin };
    return webPlan(info);
  }
  const rail = RAIL_APPS[slug];
  if (rail) return railPlan(rail, slug);
  if (slug === "google_analytics") return railPlan("google_analytics", "google-analytics");
  if (slug === "google_search_console") return railPlan("google_search_console", "google-search-console");
  const dedicated = DEDICATED_OAUTH_ROUTES[slug];
  if (dedicated) return { kind: "oauth", path: startPath(dedicated) };
  return { kind: "oauth", path: startPath(encodeURIComponent(slug)) };
}

export type ConnectorListRow = {
  slug: string;
  account_login?: string | null;
  connected_at?: string | null;
};

export function isZaviManagedGithubLogin(login: string | null | undefined): boolean {
  return (login ?? "").toLowerCase() === UMBRELLA_GITHUB_LOGIN.toLowerCase();
}

export function findConnectorRow(
  rows: readonly ConnectorListRow[],
  slug: string,
): ConnectorListRow | null {
  const slugs = satisfyingSlugs(slug);
  return (
    rows.find(
      (r) => slugs.includes(r.slug) && !(r.slug === "github" && isZaviManagedGithubLogin(r.account_login)),
    ) ?? null
  );
}

function satisfyingRows(rows: readonly ConnectorListRow[], slug: string): ConnectorListRow[] {
  const slugs = satisfyingSlugs(slug);
  return rows.filter(
    (r) => slugs.includes(r.slug) && !(r.slug === "github" && isZaviManagedGithubLogin(r.account_login)),
  );
}

type RequestLike = { slug: string; mode: "connect" | "reconnect"; created_at: string };

export function isRequestSatisfied(rows: readonly ConnectorListRow[], req: RequestLike): boolean {
  const match = satisfyingRows(rows, req.slug);
  if (req.mode === "connect") return match.length > 0;
  const asked = Date.parse(req.created_at);
  return match.some((r) => {
    const at = r.connected_at ? Date.parse(r.connected_at) : NaN;
    return Number.isFinite(at) && Number.isFinite(asked) && at > asked;
  });
}

export function satisfactionKey(rows: readonly ConnectorListRow[], req: RequestLike): string | null {
  if (!isRequestSatisfied(rows, req)) return null;
  return satisfyingRows(rows, req.slug)
    .map((r) => `${r.slug}@${r.connected_at ?? ""}`)
    .sort()
    .join("|");
}

export function setupConnectorGate(
  requiredMissing: readonly string[],
  rows: readonly ConnectorListRow[] | null,
): "ready" | "loading" | "missing" {
  if (requiredMissing.length === 0) return "ready";
  if (rows === null) return "loading";
  return requiredMissing.every((c) => findConnectorRow(rows, c)) ? "ready" : "missing";
}

export type KeyFormValues = Record<string, string>;

export function keyFormReady(form: KeyFormKind, v: KeyFormValues): boolean {
  const s = (k: string) => v[k] ?? "";
  switch (form) {
    case "stripe":
      return s("api_key").length >= 12;
    case "operator_db":
      return s("connection_string").length >= 8;
    case "posthog":
      return s("api_key").length > 0;
    case "sentry":
      return s("auth_token").length >= 10 && s("org_slug").trim().length > 0;
    case "figma":
      return s("api_key").trim().length >= 20;
    case "supabase":
      return s("access_token").trim().length >= 20;
  }
}

export function probeFailureReason(raw: string | undefined): string | null {
  const s = (raw ?? "").toLowerCase();
  if (/password|authentication|auth failed|access denied|not authorized|unrecognizedclient|security token|signature/.test(s)) {
    return "The username or password was rejected.";
  }
  if (/does not exist|unknown database/.test(s)) return "That database name wasn't found.";
  if (/enotfound|getaddrinfo/.test(s)) return "That host name couldn't be found.";
  if (/timed out|timeout|etimedout/.test(s)) return "The connection timed out.";
  if (/econnrefused|aggregateerror|refused/.test(s)) return "Nothing answered at that host and port.";
  return null;
}
