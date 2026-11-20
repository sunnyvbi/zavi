import { describe, expect, it } from "vitest";
import type { TabDescriptor } from "@/lib/workspace/types";
import { resolveWorkspaceTab, workspaceTabHref } from "./workspaceRoutes";

const SESSION = "11111111-1111-4111-8111-111111111111";
const BUILD_CHAT = "22222222-2222-4222-8222-222222222222";
const OTHER_CHAT = "33333333-3333-4333-8333-333333333333";

const HOME: TabDescriptor = {
  id: "home-default",
  kind: "home",
  title: "Home",
  payload: { kind: "home" },
  dirty: false,
  pinned: true,
};

type BuildPayload = { kind: "build"; sessionId: string | null; threadId?: string | null };

function buildTab(thread: { bound: boolean; value?: string | null }): TabDescriptor {
  const payload: BuildPayload = { kind: "build", sessionId: SESSION };
  if (thread.bound) payload.threadId = thread.value ?? null;
  return {
    id: "build-default",
    kind: "build",
    title: "Build",
    payload: payload as TabDescriptor["payload"],
    dirty: false,
    pinned: false,
  };
}

const threadOf = (tab: TabDescriptor) =>
  tab.payload.kind === "build" ? tab.payload.threadId : "NOT A BUILD TAB";

const sessionOf = (tab: TabDescriptor) =>
  tab.payload.kind === "build" ? tab.payload.sessionId : "NOT A BUILD TAB";

describe("the build tab's conversation travels in the URL", () => {
  it("writes the bound conversation into the build href", () => {
    const href = workspaceTabHref(buildTab({ bound: true, value: BUILD_CHAT }), "/workspace");
    const url = new URL(href, "https://workspace.local");
    expect(url.searchParams.get("tab")).toBe("build");
    expect(url.searchParams.get("build")).toBe(SESSION);
    expect(url.searchParams.get("buildThread")).toBe(BUILD_CHAT);
    expect(url.pathname).toBe("/workspace");
  });

  it("spells a deliberately blank build chat as new, and an unbound one as nothing", () => {
    const blank = new URL(
      workspaceTabHref(buildTab({ bound: true, value: null }), "/workspace"),
      "https://workspace.local",
    );
    expect(blank.searchParams.get("buildThread")).toBe("new");
    const unbound = new URL(
      workspaceTabHref(buildTab({ bound: false }), "/workspace"),
      "https://workspace.local",
    );
    expect(unbound.searchParams.has("buildThread")).toBe(false);
  });

  it("lands on the conversation the URL names, not the one the tab last held", () => {
    const stale = buildTab({ bound: true, value: OTHER_CHAT });
    const active = resolveWorkspaceTab(
      [HOME, stale],
      `/workspace?tab=build&build=${SESSION}&buildThread=${BUILD_CHAT}`,
    );
    expect(active.id).toBe("build-default");
    expect(sessionOf(active)).toBe(SESSION);
    expect(threadOf(active)).toBe(BUILD_CHAT);
  });

  it("restores the conversation from the URL alone, as after a reload", () => {
    const fresh = buildTab({ bound: false });
    const active = resolveWorkspaceTab(
      [HOME, fresh],
      `/workspace?tab=build&build=${SESSION}&buildThread=${BUILD_CHAT}`,
    );
    expect(threadOf(active)).toBe(BUILD_CHAT);
  });

  it("keeps the tab's own binding when the URL says nothing about a conversation", () => {
    const active = resolveWorkspaceTab(
      [HOME, buildTab({ bound: true, value: BUILD_CHAT })],
      `/workspace?tab=build&build=${SESSION}`,
    );
    expect(threadOf(active)).toBe(BUILD_CHAT);
  });

  it("round-trips every thread state through href and back", () => {
    for (const thread of [
      { bound: true, value: BUILD_CHAT },
      { bound: true, value: null },
      { bound: false },
    ]) {
      const tab = buildTab(thread);
      const href = workspaceTabHref(tab, "/workspace");
      expect(threadOf(resolveWorkspaceTab([HOME, tab], href))).toBe(threadOf(tab));
    }
  });

  it("never lets a build URL's conversation hijack an agent tab holding the same thread", () => {
    const agent: TabDescriptor = {
      id: "t-operator",
      kind: "agent",
      title: "operator",
      payload: { kind: "agent", slug: "operator", threadId: BUILD_CHAT },
      dirty: false,
      pinned: false,
    };
    const active = resolveWorkspaceTab(
      [HOME, agent, buildTab({ bound: false })],
      `/workspace?tab=build&build=${SESSION}&buildThread=${BUILD_CHAT}`,
    );
    expect(active.payload.kind).toBe("build");
    expect(active.id).toBe("build-default");
  });

  it("ignores a malformed buildThread instead of binding garbage", () => {
    const active = resolveWorkspaceTab(
      [HOME, buildTab({ bound: true, value: BUILD_CHAT })],
      `/workspace?tab=build&build=${SESSION}&buildThread=javascript:alert(1)`,
    );
    expect(threadOf(active)).toBe(BUILD_CHAT);
  });
});
