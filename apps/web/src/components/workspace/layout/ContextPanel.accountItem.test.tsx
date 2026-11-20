// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ role: "owner" }));

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
  openStatic: vi.fn(),
  setActiveTab: vi.fn(),
  setTabThreadId: vi.fn(),
  treeAgents: [
    { slug: "fundraising" },
    { slug: "engineer", locked_tier: "pro" },
    { slug: "supply-demand-balancer" },
    { slug: "c-abcd1234", name: "Review Replier", custom: true },
  ],
  supplyDemandEligible: true,
  userEmail: "qa@example.com",
  get role() {
    return h.role;
  },
  creditsRemaining: 100,
};

vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => workspace, useWorkspaceOptional: () => workspace }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("../HowZaviWorksModal", () => ({ HowZaviWorksModal: () => null, howZaviConnectDestination: vi.fn() }));
vi.mock("../useAgentThreads", () => ({ useWorkspaceThreads: () => ({ loaded: true, threads: [] }) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  refreshBuildSessions: vi.fn(async () => {}),
  readBuildSessions: () => ({ currentSessionId: null, loaded: true }),
  useBuildSessions: () => ({ loaded: true, currentSessionId: null, sessions: [] }),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({ prefetchChatThread: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut: vi.fn() } }) }));
vi.mock("../setup/draftStarter", () => ({ runDraftStarter: async () => ({}), shouldAutoStartDraft: () => false }));
vi.mock("@/lib/api", () => ({
  apiUrl: (p: string) => p,
  apiFetch: vi.fn((url: string) => {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }),
}));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));
vi.mock("./workspacePrefs", () => ({}));

import { ContextPanel } from "./ContextPanel";
import { SetupProvider } from "../setup/SetupProvider";

const noop = () => {};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("profile menu Account row", () => {
  it("opens Settings on the Account section", async () => {
    render(
      <SetupProvider>
        <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />
      </SetupProvider>,
    );
    const trigger = screen.getAllByRole("button").filter((b) => b.textContent?.includes("qa@example.com")).pop()!;
    fireEvent.click(trigger);
    const item = await screen.findByRole("menuitem", { name: "Account" });
    await waitFor(() => expect((item as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(item);

    await waitFor(() => expect(workspace.openTab).toHaveBeenCalled());
    const arg = workspace.openTab.mock.calls[0][0] as { kind: string; payload: Record<string, unknown> };
    expect(arg.kind).toBe("settings");
    expect(arg.payload.section).toBe("account");
    expect(typeof arg.payload.requestedAt).toBe("number");
  });
});
