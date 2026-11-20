// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";

const h = vi.hoisted(() => ({ setup: null as null | { locked: boolean; buildOpen: boolean } }));

const workspace = {
  tabs: [
    { id: "home-default", kind: "home", title: "Home", payload: { kind: "home" }, dirty: false, pinned: true },
    { id: "growth", kind: "autopilot", title: "Growth Strategy", payload: { kind: "autopilot" }, dirty: false, pinned: false },
  ],
  activeTabId: "growth",
  buildSessionId: null,
  tenantName: "Paws & Suds",
  openAgentTab: vi.fn(),
  openBuildTab: vi.fn(),
  openTab: vi.fn(),
  setActiveTab: vi.fn(),
  setTabThreadId: vi.fn(),
  treeAgents: [],
  supplyDemandEligible: false,
  userEmail: "qa@example.com",
  role: "owner",
  creditsRemaining: 100,
};

vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => workspace }));
vi.mock("../setup/SetupProvider", () => ({ useSetupOptional: () => h.setup }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("../HowZaviWorksModal", () => ({ HowZaviWorksModal: () => null, howZaviConnectDestination: vi.fn() }));
vi.mock("../useAgentThreads", () => ({
  useWorkspaceThreads: () => ({
    loaded: true,
    threads: [
      {
        id: "t-growth",
        agent_slug: "operator",
        title: "Growth plan questions",
        last_message_at: "2026-09-29T17:40:00Z",
        created_at: "2026-09-29T17:39:00Z",
        last_message: null,
        run_status: "done",
      },
    ],
  }),
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  refreshBuildSessions: vi.fn(async () => {}),
  readBuildSessions: () => ({ currentSessionId: "b8b5d121-0000-4000-8000-000000000000", loaded: true }),
  useBuildSessions: () => ({
    loaded: true,
    currentSessionId: "b8b5d121-0000-4000-8000-000000000000",
    sessions: [
      {
        id: "b8b5d121-0000-4000-8000-000000000000",
        title: "Paws & Suds booking site",
        request: "A booking website for my dog grooming salon in Austin, Paws & Suds.",
        state: "building",
        run_status: "running",
        created_at: "2026-09-29T17:39:00Z",
        last_activity_at: "2026-09-29T17:41:00Z",
        refine_count: 0,
        is_current: true,
      },
    ],
  }),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({ prefetchChatThread: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut: vi.fn() } }) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));
vi.mock("./workspacePrefs", () => ({}));

import { ContextPanel, ContextRail } from "./ContextPanel";

const noop = () => {};
const panel = () => render(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />);
const nav = () => within(screen.getByRole("navigation", { name: "Destinations" }));
const buildRow = () => screen.getByRole("button", { name: /Paws & Suds booking site/ });
const chatRow = () => screen.getByRole("button", { name: /Growth plan questions/ });
const inert = (el: HTMLElement) => !!el.closest("[inert]");

beforeEach(() => {
  workspace.openBuildTab.mockClear();
  workspace.openTab.mockClear();
  workspace.openAgentTab.mockClear();
});
afterEach(cleanup);

const SETUPS = [
  ["running with build_open", { locked: true, buildOpen: true }],
  ["running with the key off", { locked: true, buildOpen: false }],
  ["not running", { locked: false, buildOpen: true }],
] as const;

describe("no setup lock on the sidebar, whatever build_open says", () => {
  it.each(SETUPS)("setup %s: Build, Analytics, Home and both Recent rows are open and clickable", async (_label, setup) => {
    h.setup = { ...setup };
    panel();
    for (const name of [/^Build$/, /^Analytics$/, /^Home$/]) expect(nav().getByRole("button", { name })).toHaveProperty("disabled", false);
    expect(inert(buildRow())).toBe(false);
    expect(inert(chatRow())).toBe(false);
    expect(chatRow().closest("[aria-disabled]")).toBeNull();
    const newChat = screen.getByRole("button", { name: "New Chat" });
    expect(newChat).toHaveProperty("disabled", false);
    expect(newChat.getAttribute("title")).toBe("New Chat");

    fireEvent.click(nav().getByRole("button", { name: /^Build$/ }));
    await vi.waitFor(() => expect(workspace.openBuildTab).toHaveBeenCalled());
    workspace.openBuildTab.mockClear();
    fireEvent.click(buildRow());
    expect(workspace.openBuildTab).toHaveBeenCalledWith("b8b5d121-0000-4000-8000-000000000000", { push: true });
    fireEvent.click(chatRow());
    expect(workspace.openAgentTab).toHaveBeenCalledWith("operator", expect.objectContaining({ threadId: "t-growth" }));
    fireEvent.click(nav().getByRole("button", { name: /^Analytics$/ }));
    expect(workspace.openTab).toHaveBeenCalledWith(expect.objectContaining({ kind: "analytics" }));
  });

  it.each(SETUPS)("setup %s: the collapsed rail opens Build and Analytics", async (_label, setup) => {
    h.setup = { ...setup };
    render(<ContextRail onExpand={noop} chatFocus={false} />);
    const build = screen.getByRole("button", { name: /^Build$/ });
    const analytics = screen.getByRole("button", { name: /^Analytics$/ });
    expect(build).toHaveProperty("disabled", false);
    expect(analytics).toHaveProperty("disabled", false);
    expect(analytics.getAttribute("title")).toBe("Analytics");
    fireEvent.click(analytics);
    expect(workspace.openTab).toHaveBeenCalledWith(expect.objectContaining({ kind: "analytics" }));
    fireEvent.click(build);
    await vi.waitFor(() => expect(workspace.openBuildTab).toHaveBeenCalled());
  });
});
