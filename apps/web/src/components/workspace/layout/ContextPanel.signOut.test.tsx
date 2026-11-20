// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspace = {
  tabs: [{ id: "home-default", kind: "home", title: "Home", payload: { kind: "home" }, dirty: false, pinned: true }],
  activeTabId: "home-default",
  tenantName: "UpcarAI",
  openAgentTab: vi.fn(),
  openBuildTab: vi.fn(),
  openTab: vi.fn(),
  treeAgents: [],
  supplyDemandEligible: false,
  userEmail: "qa@example.com",
  role: "owner",
  creditsRemaining: 100,
};

const push = vi.fn();
let resolveSignOut: () => void = () => {};
const signOut = vi.fn(() => new Promise<{ error: null }>((r) => (resolveSignOut = () => r({ error: null }))));

vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => workspace }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("../HowZaviWorksModal", () => ({ HowZaviWorksModal: () => null, howZaviConnectDestination: vi.fn() }));
vi.mock("../useAgentThreads", () => ({ useWorkspaceThreads: () => ({ threads: [], loaded: false }) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ useBuildSessions: () => ({ sessions: [], loaded: false }) }));
vi.mock("@/lib/workspace/useChatThread", () => ({ prefetchChatThread: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut } }) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));

import { ContextPanel } from "./ContextPanel";

const realLocation = window.location;
const replace = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, replace } });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  vi.clearAllMocks();
});

describe("ContextPanel sign out", () => {
  it("replaces the workspace history entry with a full load of /login, only after the session is cleared", async () => {
    render(<ContextPanel onCollapse={() => {}} theme="system" onSetTheme={() => {}} chatFocus={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out/ }));

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(replace).not.toHaveBeenCalled();

    await act(async () => resolveSignOut());

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/login");
    expect(push).not.toHaveBeenCalled();
  });
});
