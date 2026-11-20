import { flushSync } from "react-dom";
import { CONNECT_ERROR_PARAM, ONBOARDING_QUERY_PARAMS, SETUP_STEP_PARAM } from "@/lib/onboardingRoutes";
import type { TabDescriptor } from "@/lib/workspace/types";
import {
  HOME_AGENT_SLUG,
  isUrlTabKind,
  tabUrlParam,
  urlTabKindFromParam,
} from "@/lib/workspace/tabUrl";
import { WORKSPACE_AGENT_SLUG_RE, WORKSPACE_UUID_RE } from "../deepLinkSeed";

export const CHANNEL_PARAM = "channel";
export const CHANNEL_CARD_PARAM = "action";
export const DECISION_PARAM = "decision";
export const GROWTH_CHAT_PARAM = "chat";

function decisionOf(payload: TabDescriptor["payload"]): string | null {
  if (payload.kind !== "needs-you" && payload.kind !== "autopilot") return null;
  const d = payload.decision;
  return typeof d === "string" && WORKSPACE_UUID_RE.test(d) ? d : null;
}

export const FIND_FILTER_PARAMS = [
  "platform",
  "keyword",
  "niches",
  "lane",
  "max_price",
  "max_days",
  "min_followers",
  "country",
  "sort",
] as const;

export const CHANNEL_DRAWER_PARAMS = [
  "drawer",
  "package",
  "application",
  "brief",
  "offer",
  "creator",
  "job",
  "paid",
  "cancelled",
  "hire_cancelled",
  "from",
  "over",
  "locations",
  "reposted",
  ...FIND_FILTER_PARAMS,
] as const;

export const WORKSPACE_PATH = "/workspace";
export const NEW_THREAD_PARAM = "new";
export const BOARD_TAB_PARAM = "board";
export const BUILD_THREAD_PARAM = "buildThread";
export const AGENT_BUILDER_TAB_PARAM = "agent-builder";
export const AGENT_BUILDER_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c-[a-z0-9]{8,12})$/i;
export const TOOLKIT_HASHES = [
  "#integrations",
  "#skills",
  "#data-access",
  "#goals",
];
export const MEMORY_HASHES = ["#memory", "#personalization"];
export const MEMORY_HIGHLIGHT_PARAM = "h";
export const WORKSPACE_LOCATION_EVENT = "workspace:location";
export const DATA_ACCESS_ENTRY_PARAMS = ["access", "entry"] as const;

export function isBareWorkspaceLanding(href: string): boolean {
  const url = new URL(href, "https://workspace.local");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return path === WORKSPACE_PATH && url.search === "" && url.hash === "";
}

export function readWorkspaceLocation() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export function workspaceSkipHref(location: string): string {
  const url = new URL(location, "https://workspace.local");
  return `${url.pathname}${url.search}#zavi-main`;
}

export function notifyWorkspaceLocation() {
  window.dispatchEvent(new Event(WORKSPACE_LOCATION_EVENT));
}

export function replaceWorkspaceLocation(href: string) {
  if (href === readWorkspaceLocation()) return;
  window.history.replaceState(window.history.state, "", href);
  notifyWorkspaceLocation();
}

export function pushWorkspaceLocation(href: string) {
  if (href === readWorkspaceLocation()) return;
  window.history.pushState(window.history.state, "", href);
  notifyWorkspaceLocation();
}

export function workspaceThreadPath(threadId: string) {
  return `${WORKSPACE_PATH}/${threadId}`;
}

export function threadIdFromWorkspacePath(pathname: string): string | null {
  const match = pathname.match(/^\/workspace\/([^/]+)\/?$/);
  return match && WORKSPACE_UUID_RE.test(match[1]!) ? match[1]! : null;
}

function isAgentInnerTabParam(value: string): boolean {
  return (
    !urlTabKindFromParam(value) &&
    value !== BOARD_TAB_PARAM &&
    value !== "build" &&
    value !== "dispute-detail" &&
    value !== "run"
  );
}

export function commitTabsAndLocation(
  updateTabs: () => void,
  navigate?: () => void,
): void {
  if (!navigate) {
    updateTabs();
    return;
  }
  flushSync(() => {
    updateTabs();
    navigate();
  });
}

export function workspaceTabHref(tab: TabDescriptor, current: string) {
  const live = new URL(current, "https://workspace.local");
  const params = new URLSearchParams();
  let path = WORKSPACE_PATH;
  let hash = "";
  if (tab.payload.kind === "agent") {
    const threadId =
      tab.payload.threadId && WORKSPACE_UUID_RE.test(tab.payload.threadId)
        ? tab.payload.threadId
        : null;
    const blank = tab.payload.threadId === null;
    if (threadId) path = workspaceThreadPath(threadId);
    else if (blank && tab.payload.slug === HOME_AGENT_SLUG) {
    } else {
      params.set("agent", tab.payload.slug);
      if (blank) params.set("thread", NEW_THREAD_PARAM);
    }
    const liveThread = threadIdFromWorkspacePath(live.pathname);
    const sameConversation = threadId
      ? liveThread === threadId
      : !liveThread &&
        (live.searchParams.get("agent") ?? HOME_AGENT_SLUG) ===
          tab.payload.slug;
    const liveTab = live.searchParams.get("tab");
    if (sameConversation && liveTab && isAgentInnerTabParam(liveTab)) {
      params.set("tab", liveTab);
    }
  } else if (tab.payload.kind === "build") {
    params.set("tab", "build");
    if (tab.payload.sessionId) params.set("build", tab.payload.sessionId);
    const bound = tab.payload.threadId;
    if (bound === null) params.set(BUILD_THREAD_PARAM, NEW_THREAD_PARAM);
    else if (bound && WORKSPACE_UUID_RE.test(bound))
      params.set(BUILD_THREAD_PARAM, bound);
  } else if (tab.payload.kind === "dispute-detail") {
    params.set("tab", "dispute-detail");
    params.set("dispute", tab.payload.disputeId);
  } else if (tab.payload.kind === "run") {
    params.set("tab", "run");
    params.set("run", tab.payload.runId);
  } else if (tab.payload.kind === "agent-builder") {
    params.set("tab", AGENT_BUILDER_TAB_PARAM);
    const agentId = tab.payload.agentId;
    if (agentId && AGENT_BUILDER_ID_RE.test(agentId)) {
      params.set("agent", agentId);
      const runId = tab.payload.runId;
      if (runId && WORKSPACE_UUID_RE.test(runId)) params.set("run", runId);
    }
  } else if (
    tab.payload.kind === "home" &&
    tab.payload.threadId &&
    WORKSPACE_UUID_RE.test(tab.payload.threadId)
  ) {
    path = workspaceThreadPath(tab.payload.threadId);
  } else if (tab.kind === "home") {
    params.set("tab", BOARD_TAB_PARAM);
  } else if (isUrlTabKind(tab.kind)) {
    params.set("tab", tabUrlParam(tab.kind));
  }
  if (tab.kind === "brain") {
    hash = TOOLKIT_HASHES.includes(live.hash) ? live.hash : "#integrations";
  } else if (tab.kind === "home" || tab.kind === "analytics") {
    hash = TOOLKIT_HASHES.includes(live.hash) ? "" : live.hash;
  }
  if (
    tab.payload.kind === "channels" &&
    typeof tab.payload.channel === "string" &&
    tab.payload.channel
  ) {
    params.set(CHANNEL_PARAM, tab.payload.channel);
    const action = tab.payload.action;
    if (typeof action === "string" && WORKSPACE_UUID_RE.test(action)) params.set(CHANNEL_CARD_PARAM, action);
  }
  if (tab.kind === "needs-you" || tab.kind === "autopilot") {
    const named = decisionOf(tab.payload);
    const liveDecision = live.searchParams.get(DECISION_PARAM);
    const samePage = urlTabKindFromParam(live.searchParams.get("tab")) === tab.kind;
    const decision = named ?? (samePage && liveDecision && WORKSPACE_UUID_RE.test(liveDecision) ? liveDecision : null);
    if (decision) params.set(DECISION_PARAM, decision);
    const liveChat = live.searchParams.get(GROWTH_CHAT_PARAM);
    if (tab.kind === "autopilot" && samePage && liveChat && WORKSPACE_UUID_RE.test(liveChat))
      params.set(GROWTH_CHAT_PARAM, liveChat);
  }
  if (live.searchParams.get("tab") === tab.kind) {
    const keys =
      tab.kind === "artifacts"
        ? ["q", "artifact_type", "artifact_view"]
        : tab.kind === "analytics"
          ? ["channel"]
          : tab.kind === "channels"
            ? ["channel", ...CHANNEL_DRAWER_PARAMS]
            : tab.kind === "brain"
              ? [...DATA_ACCESS_ENTRY_PARAMS]
              : tab.kind === "memory"
                ? [MEMORY_HIGHLIGHT_PARAM]
                : [];
    for (const key of keys) {
      const value = live.searchParams.get(key);
      if (value && !params.has(key)) params.set(key, value);
    }
    const card = live.searchParams.get(CHANNEL_CARD_PARAM);
    if (tab.kind === "channels" && card && params.get(CHANNEL_PARAM) === live.searchParams.get(CHANNEL_PARAM)) {
      params.set(CHANNEL_CARD_PARAM, card);
    }
  }
  if (tab.kind === "settings" && live.searchParams.get("tab") === "settings")
    hash = live.hash;
  for (const key of ONBOARDING_QUERY_PARAMS) {
    const value = live.searchParams.get(key);
    if (value) params.set(key, value);
  }
  const connectError = live.searchParams.get(CONNECT_ERROR_PARAM);
  if (connectError && live.searchParams.has(SETUP_STEP_PARAM)) params.set(CONNECT_ERROR_PARAM, connectError);
  const failedConnect = live.searchParams.get("connect_error");
  if (failedConnect && live.searchParams.has(SETUP_STEP_PARAM)) {
    params.set("connect_error", failedConnect);
    params.set("provider", live.searchParams.get("provider") ?? "");
  }
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}${hash}`;
}

export function resolveWorkspaceTab(
  tabs: TabDescriptor[],
  href: string,
): TabDescriptor {
  const url = new URL(href, "https://workspace.local");
  const params = url.searchParams;
  const pathThread = threadIdFromWorkspacePath(url.pathname);
  const builderTab = !pathThread && params.get("tab") === AGENT_BUILDER_TAB_PARAM;
  const rawSlug = pathThread || builderTab ? null : params.get("agent");
  const explicitSlug =
    rawSlug && WORKSPACE_AGENT_SLUG_RE.test(rawSlug) ? rawSlug : null;
  const rawThread = params.get("thread");
  const threadId: string | null | undefined =
    pathThread ??
    (rawThread === NEW_THREAD_PARAM
      ? null
      : rawThread && WORKSPACE_UUID_RE.test(rawThread)
        ? rawThread
        : undefined);
  const boundHome =
    pathThread && !builderTab
      ? tabs.find(
          (tab) =>
            tab.payload.kind === "home" && tab.payload.threadId === pathThread,
        )
      : undefined;
  const boundThread = threadId
    ? tabs.find(
        (tab) =>
          tab.payload.kind === "agent" && tab.payload.threadId === threadId,
      )
    : undefined;
  if (boundHome && !boundThread) return boundHome;
  const slug =
    explicitSlug ??
    (boundThread?.payload.kind === "agent" ? boundThread.payload.slug : null);
  const rawKind = params.get("tab");
  const kind = rawKind === "feed" ? "channels" : rawKind;
  let payload: TabDescriptor["payload"];
  if (builderTab) {
    const agentId = params.get("agent");
    const validAgent = !!agentId && AGENT_BUILDER_ID_RE.test(agentId);
    const runId = params.get("run");
    payload = {
      kind: "agent-builder",
      agentId: validAgent ? agentId : null,
      ...(validAgent && runId && WORKSPACE_UUID_RE.test(runId) ? { runId } : {}),
    };
  } else if (slug) payload = { kind: "agent", slug, threadId };
  else if (threadId) {
    payload = { kind: "agent", slug: HOME_AGENT_SLUG, threadId: null };
  } else if (kind === BOARD_TAB_PARAM) payload = { kind: "home" };
  else if (kind === "build") {
    const sessionId = params.get("build");
    const rawBuildThread = params.get(BUILD_THREAD_PARAM);
    const buildThread =
      rawBuildThread === NEW_THREAD_PARAM
        ? null
        : rawBuildThread && WORKSPACE_UUID_RE.test(rawBuildThread)
          ? rawBuildThread
          : undefined;
    payload = {
      kind,
      sessionId:
        sessionId && WORKSPACE_UUID_RE.test(sessionId) ? sessionId : null,
      ...(buildThread === undefined ? {} : { threadId: buildThread }),
    };
  } else if (kind === "dispute-detail" && params.get("dispute"))
    payload = { kind, disputeId: params.get("dispute")!, threadId: null };
  else if (kind === "run" && params.get("run"))
    payload = { kind, runId: params.get("run")! };
  else if (MEMORY_HASHES.includes(url.hash) && (!kind || kind === "brain"))
    payload = { kind: "memory" };
  else if (urlTabKindFromParam(kind)) {
    const urlKind = urlTabKindFromParam(kind)!;
    const decision = params.get(DECISION_PARAM);
    payload =
      (urlKind === "needs-you" || urlKind === "autopilot") && decision && WORKSPACE_UUID_RE.test(decision)
        ? { kind: urlKind, decision }
        : ({ kind: urlKind } as TabDescriptor["payload"]);
  }
  else if (TOOLKIT_HASHES.includes(url.hash)) payload = { kind: "brain" };
  else payload = { kind: "agent", slug: HOME_AGENT_SLUG, threadId: null };
  const target = payload;
  const existing = [...tabs].reverse().find((tab) => {
    const candidate = tab.payload;
    if (candidate.kind !== target.kind) return false;
    if (target.kind === "agent")
      return (
        candidate.kind === "agent" &&
        candidate.slug === target.slug &&
        (target.threadId === undefined ||
          candidate.threadId === target.threadId)
      );
    if (target.kind === "dispute-detail")
      return (
        candidate.kind === "dispute-detail" &&
        candidate.disputeId === target.disputeId
      );
    if (target.kind === "run")
      return candidate.kind === "run" && candidate.runId === target.runId;
    return true;
  });
  if (existing) {
    if (target.kind === "agent-builder") return { ...existing, payload: target };
    if ((target.kind === "needs-you" || target.kind === "autopilot") && "decision" in target)
      return { ...existing, payload: target };
    if (target.kind !== "build") return existing;
    const urlNamesThread = "threadId" in target;
    const boundBuildThread =
      existing.payload.kind === "build" ? existing.payload.threadId : undefined;
    return {
      ...existing,
      payload: urlNamesThread ? target : { ...target, threadId: boundBuildThread },
    };
  }
  const identity =
    target.kind === "agent"
      ? `${target.slug}-${target.threadId ?? "new"}`
      : target.kind === "dispute-detail"
        ? target.disputeId
        : target.kind === "run"
          ? target.runId
          : target.kind;
  return {
    id: `route-${identity}`,
    kind: target.kind,
    title:
      target.kind === "agent"
        ? target.slug
        : target.kind === "needs-you"
          ? "Needs you"
          : target.kind[0].toUpperCase() + target.kind.slice(1),
    payload: target,
    dirty: false,
    pinned: target.kind === "home",
  };
}
