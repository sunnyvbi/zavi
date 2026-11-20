
import type { TabDescriptor } from "@/lib/workspace/types";
import { HOME_AGENT_SLUG } from "@/lib/workspace/tabUrl";
import { resolveWorkspaceTab } from "./workspaceRoutes";

type TabPayload = TabDescriptor["payload"];

export function payloadOwnsThread(payload: TabPayload): boolean {
  return (
    payload.kind === "agent" ||
    payload.kind === "dispute-detail" ||
    payload.kind === "home" ||
    payload.kind === "build" ||
    payload.kind === "autopilot"
  );
}

export function bindActivatesTab(
  kind: TabDescriptor["kind"],
  asked: boolean,
  onScreen: boolean,
  unbinding = false,
): boolean {
  if (kind === "agent" || kind === "build") return asked || onScreen;
  if (kind === "home") return asked || (onScreen && unbinding);
  return false;
}

export function planThreadBind(
  tabs: readonly TabDescriptor[],
  tabId: string,
  threadId: string | null,
  location: string,
  asked: boolean,
): { next: TabDescriptor; activate: boolean } | null {
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab || !payloadOwnsThread(tab.payload)) return null;
  const next = { ...tab, payload: { ...tab.payload, threadId } } as TabDescriptor;
  const onScreen = resolveWorkspaceTab([...tabs], location).id === tabId;
  const unbinding =
    threadId === null &&
    typeof (tab.payload as { threadId?: unknown }).threadId === "string";
  return { next, activate: bindActivatesTab(tab.kind, asked, onScreen, unbinding) };
}

export type OperatorChatBinding = {
  isOperatorChat: boolean;
  threadId: string | null | undefined;
};

export function operatorChatBinding(
  tab: TabDescriptor | undefined,
  operatorSlug: string,
): OperatorChatBinding {
  const payload = tab?.payload;
  if (!payload) return { isOperatorChat: false, threadId: null };
  if (payload.kind === "home") {
    return { isOperatorChat: true, threadId: payload.threadId ?? null };
  }
  if (payload.kind === "agent" && payload.slug === operatorSlug) {
    return { isOperatorChat: true, threadId: payload.threadId };
  }
  return { isOperatorChat: false, threadId: null };
}

export type ChatBinding = {
  slug: string | null;
  threadId: string | null | undefined;
};

export function activeChatBinding(
  tab: TabDescriptor | undefined,
  homeSlug: string,
): ChatBinding {
  const payload = tab?.payload;
  if (!payload) return { slug: null, threadId: null };
  if (payload.kind === "home") {
    return { slug: homeSlug, threadId: payload.threadId ?? null };
  }
  if (payload.kind === "agent") {
    return { slug: payload.slug, threadId: payload.threadId };
  }
  if (payload.kind === "build") {
    return { slug: homeSlug, threadId: payload.threadId ?? null };
  }
  return { slug: null, threadId: null };
}

export type AgentThreadOpenStep =
  | { kind: "activate"; tabId: string }
  | { kind: "bind"; tabId: string }
  | { kind: "open" };

export function agentThreadOpenStep(
  tabs: readonly TabDescriptor[],
  slug: string,
  threadId: string,
  opts?: { preferHome?: boolean },
): AgentThreadOpenStep {
  if (opts?.preferHome === true && slug === HOME_AGENT_SLUG) {
    const open = tabs.find(
      (t) => t.payload.kind === "agent" && t.payload.slug === slug && t.payload.threadId === threadId,
    );
    if (open) return { kind: "activate", tabId: open.id };
    const home = tabs.find((t) => t.payload.kind === "home");
    if (home) {
      if (home.payload.kind === "home" && home.payload.threadId === threadId) {
        return { kind: "activate", tabId: home.id };
      }
      return { kind: "bind", tabId: home.id };
    }
  }
  const existing = tabs.filter((t) => t.payload.kind === "agent" && t.payload.slug === slug);
  if (existing.length === 0) return { kind: "open" };
  const bound = existing.find((t) => t.payload.kind === "agent" && t.payload.threadId === threadId);
  if (bound) return { kind: "activate", tabId: bound.id };
  return { kind: "bind", tabId: existing[existing.length - 1]!.id };
}
