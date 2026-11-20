// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TabDescriptor } from "@/lib/workspace/types";

const SESSION_LIVE = "11111111-1111-4111-8111-111111111111";
const SESSION_OLD = "44444444-4444-4444-8444-444444444444";
const BUILD_CHAT = "22222222-2222-4222-8222-222222222222";
const GROWTH_CHAT = "33333333-3333-4333-8333-333333333333";

const openAgentTab = vi.fn(() => Promise.resolve("t"));
const openBuildTab = vi.fn(() => "build-default");
const setActiveTab = vi.fn();
const setTabThreadId = vi.fn();

const buildTab = (threadId?: string | null): TabDescriptor =>
  ({
    id: "build-default",
    kind: "build",
    title: "Build",
    payload:
      threadId === undefined
        ? { kind: "build", sessionId: SESSION_LIVE }
        : { kind: "build", sessionId: SESSION_LIVE, threadId },
    dirty: false,
    pinned: false,
  }) as TabDescriptor;

const workspace = {
  tabs: [] as TabDescriptor[],
  activeTabId: "build-default",
  buildSessionId: SESSION_LIVE,
  tenantName: "Hush",
  openAgentTab,
  openBuildTab,
  setActiveTab,
  setTabThreadId,
  openTab: vi.fn(),
  treeAgents: [],
  supplyDemandEligible: false,
  userEmail: "qa@example.com",
  role: "owner",
  creditsRemaining: 100,
};

vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => workspace }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("../HowZaviWorksModal", () => ({
  HowZaviWorksModal: () => null,
  howZaviConnectDestination: vi.fn(),
}));
vi.mock("../useAgentThreads", () => ({
  useWorkspaceThreads: () => ({
    threads: [
      {
        id: GROWTH_CHAT,
        agent_slug: "operator",
        title: "Instagram Product Launch Campaign",
        last_message_at: "2026-09-23T10:00:00Z",
        created_at: "2026-09-23T09:00:00Z",
      },
      {
        id: BUILD_CHAT,
        agent_slug: "operator",
        title: "Hush landing page",
        last_message_at: "2026-09-23T08:00:00Z",
        created_at: "2026-09-23T07:00:00Z",
      },
    ],
    loaded: true,
  }),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({
    sessions: [
      {
        id: SESSION_LIVE,
        title: "Hush v2",
        state: "ready",
        is_current: true,
        last_activity_at: "2026-09-23T06:00:00Z",
        created_at: "2026-09-23T05:00:00Z",
      },
      {
        id: SESSION_OLD,
        title: "Hush v1",
        state: "ready",
        is_current: false,
        last_activity_at: "2026-09-22T06:00:00Z",
        created_at: "2026-09-22T05:00:00Z",
      },
    ],
    currentSessionId: SESSION_LIVE,
    loaded: true,
  }),
  refreshBuildSessions: vi.fn(() => Promise.resolve()),
  readBuildSessions: () => ({ sessions: [], currentSessionId: SESSION_LIVE, loaded: true, failed: false }),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({ prefetchChatThread: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut: vi.fn() } }) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));
vi.mock("./workspacePrefs", () => ({}));

import { ContextPanel } from "./ContextPanel";

const noop = () => {};

function mountOnLiveBuild(boundThread: string | null | undefined) {
  workspace.tabs = [buildTab(boundThread)];
  render(
    <ContextPanel
      onCollapse={noop}
      theme="system"
      onSetTheme={noop}
      chatFocus={false}
      buildChatFollowsThread
    />,
  );
}

afterEach(() => {
  cleanup();
  openAgentTab.mockClear();
  openBuildTab.mockClear();
  setActiveTab.mockClear();
  setTabThreadId.mockClear();
});

describe("hopping sessions from the live Build surface", () => {
  it("a growth chat leaves Build for its own surface, so the preview folds", () => {
    mountOnLiveBuild(BUILD_CHAT);
    fireEvent.click(screen.getByRole("button", { name: /Instagram Product Launch Campaign/ }));
    expect(setTabThreadId).not.toHaveBeenCalled();
    expect(openAgentTab).toHaveBeenCalledTimes(1);
    expect(openAgentTab).toHaveBeenCalledWith("operator", { threadId: GROWTH_CHAT, push: true });
  });

  it("the build's own chat stays beside the preview, with a history entry", () => {
    mountOnLiveBuild(BUILD_CHAT);
    fireEvent.click(screen.getByRole("button", { name: /Hush landing page/ }));
    expect(openAgentTab).not.toHaveBeenCalled();
    expect(setTabThreadId).toHaveBeenCalledWith("build-default", BUILD_CHAT, {
      activate: true,
      push: true,
    });
  });

  it("with no chat bound yet, every Zavi row leaves Build", () => {
    mountOnLiveBuild(undefined);
    fireEvent.click(screen.getByRole("button", { name: /Hush landing page/ }));
    expect(setTabThreadId).not.toHaveBeenCalled();
    expect(openAgentTab).toHaveBeenCalledWith("operator", { threadId: BUILD_CHAT, push: true });
  });

  it("an older build opens as itself and Back can return", () => {
    mountOnLiveBuild(BUILD_CHAT);
    fireEvent.click(screen.getByRole("button", { name: /Hush v1/ }));
    expect(openBuildTab).toHaveBeenCalledTimes(1);
    expect(openBuildTab).toHaveBeenCalledWith(SESSION_OLD, { push: true });
    expect(openAgentTab).not.toHaveBeenCalled();
  });
});

describe("History rows with the pinned Home tab open", () => {
  const homeTab = {
    id: "home-default",
    kind: "home",
    title: "Home",
    payload: { kind: "home" },
    dirty: false,
    pinned: true,
  } as TabDescriptor;

  it("an operator row keeps the agent-tab rule: it never binds into Home", () => {
    workspace.tabs = [homeTab];
    workspace.activeTabId = "home-default";
    try {
      render(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} buildChatFollowsThread />);
      fireEvent.click(screen.getByRole("button", { name: /Instagram Product Launch Campaign/ }));
      expect(setTabThreadId).not.toHaveBeenCalled();
      expect(openAgentTab).toHaveBeenCalledWith("operator", { threadId: GROWTH_CHAT, push: true });
    } finally {
      workspace.activeTabId = "build-default";
    }
  });
});
