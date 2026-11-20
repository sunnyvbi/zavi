import type { TabKind } from "./types";

export const URL_TAB_KINDS = [
  "agent-builder",
  "analytics",
  "artifacts",
  "autopilot",
  "brain",
  "channels",
  "competitor",
  "engineer",
  "fundraising",
  "members",
  "meet",
  "memory",
  "messaging",
  "needs-you",
  "onboarding",
  "settings",
  "supply-demand",
  "website",
] as const satisfies readonly TabKind[];

export type UrlTabKind = (typeof URL_TAB_KINDS)[number];

export const HOME_AGENT_SLUG = "operator";

export function workspaceAgentHref(slug: string): string {
  return slug === HOME_AGENT_SLUG
    ? "/workspace"
    : `/workspace?agent=${encodeURIComponent(slug)}`;
}

export function isUrlTabKind(value: unknown): value is UrlTabKind {
  return (
    typeof value === "string" &&
    (URL_TAB_KINDS as readonly string[]).includes(value)
  );
}

const TAB_URL_PARAMS: Partial<Record<UrlTabKind, string>> = {
  autopilot: "growth-strategy",
};

const LEGACY_TAB_URL_PARAMS: Record<string, UrlTabKind> = {
  feed: "channels",
  autopilot: "autopilot",
};

export function tabUrlParam(kind: UrlTabKind): string {
  return TAB_URL_PARAMS[kind] ?? kind;
}

export const AD_BUDGET_URL = `/workspace?tab=${tabUrlParam("autopilot")}#ad-budget`;
export const AD_CONNECTIONS_URL = `/workspace?tab=${tabUrlParam("brain")}#integration`;
export const AD_BILLING_URL = `/workspace?tab=${tabUrlParam("settings")}#billing`;

export const MEMORY_URL = `/workspace?tab=${tabUrlParam("memory")}`;

export function memoryUrl(highlight: readonly string[] = []): string {
  if (highlight.length === 0) return MEMORY_URL;
  return `${MEMORY_URL}&h=${highlight.map((id) => encodeURIComponent(id)).join(",")}`;
}

export function urlTabKindFromParam(value: unknown): UrlTabKind | null {
  if (typeof value !== "string") return null;
  for (const kind of URL_TAB_KINDS) {
    if (tabUrlParam(kind) === value) return kind;
  }
  return LEGACY_TAB_URL_PARAMS[value] ?? null;
}
