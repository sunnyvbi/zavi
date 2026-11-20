// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { resetWebsiteFramingForTests } from "@/lib/workspace/buildFraming";

const RUNNING = "177bf5f7-0000-4000-8000-000000000000";

const workspace = {
  tabs: [
    { id: "home-default", kind: "home", title: "Home", payload: { kind: "home" }, dirty: false, pinned: true },
    { id: "build", kind: "build", title: "Build", payload: { kind: "build", sessionId: RUNNING }, dirty: false, pinned: false },
  ],
  activeTabId: "home-default",
  buildSessionId: RUNNING as string | null,
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
vi.mock("../setup/SetupProvider", () => ({ useSetupOptional: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("../HowZaviWorksModal", () => ({ HowZaviWorksModal: () => null, howZaviConnectDestination: vi.fn() }));
vi.mock("../useAgentThreads", () => ({ useWorkspaceThreads: () => ({ loaded: true, threads: [] }) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  refreshBuildSessions: vi.fn(async () => {}),
  readBuildSessions: () => ({ currentSessionId: RUNNING, loaded: true }),
  useBuildSessions: () => ({
    loaded: true,
    currentSessionId: RUNNING,
    sessions: [
      {
        id: RUNNING,
        title: "Paws & Suds booking site",
        request: "A booking website for my dog grooming salon in Austin, Paws & Suds.",
        state: "building",
        run_status: "running",
        created_at: "2026-09-29T17:39:00Z",
        last_activity_at: "2026-09-29T17:41:00Z",
        refine_count: 0,
        is_current: true,
      },
      {
        id: "yoga-0000-4000-8000-000000000000",
        title: "Simple website for my yoga studio",
        request: "Simple website for my yoga studio",
        state: "ready",
        run_status: "done",
        created_at: "2026-09-29T15:00:00Z",
        last_activity_at: "2026-09-29T16:00:00Z",
        refine_count: 3,
        is_current: false,
      },
    ],
  }),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({ prefetchChatThread: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: { signOut: vi.fn() } }) }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(), apiUrl: (p: string) => p }));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));
vi.mock("./workspacePrefs", () => ({}));

import { ContextPanel, ContextRail } from "./ContextPanel";

const noop = () => {};
const fetchMock = vi.fn();

function serveFlags(body: Record<string, unknown> | "fail") {
  fetchMock.mockImplementation(async (url: string) => {
    if (url !== "/api/public/build-framing") throw new Error(`unexpected ${url}`);
    if (body === "fail") return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => body };
  });
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function clickBuild(root: "panel" | "rail") {
  if (root === "panel") {
    render(<ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />);
    await settle();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Destinations" })).getByRole("button", { name: /^Build$/ }),
    );
  } else {
    render(<ContextRail onExpand={noop} chatFocus={false} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /^Build$/ }));
  }
  await vi.waitFor(() => expect(workspace.openBuildTab).toHaveBeenCalled());
}

beforeEach(() => {
  resetWebsiteFramingForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  workspace.openBuildTab.mockClear();
  workspace.buildSessionId = RUNNING;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("B34: the Build nav opens the sites list, not the running build", () => {
  it.each(["panel", "rail"] as const)(
    "%s: with the key on, Build unbinds the running build so the list shows",
    async (root) => {
      serveFlags({ site_list_first: true });
      await clickBuild(root);
      expect(workspace.openBuildTab).toHaveBeenCalledTimes(1);
      expect(workspace.openBuildTab).toHaveBeenCalledWith(null);
      expect(workspace.openBuildTab).not.toHaveBeenCalledWith(RUNNING);
    },
  );

  it.each(["panel", "rail"] as const)(
    "%s: with the key off, Build jumps into the bound running build as before",
    async (root) => {
      serveFlags({ site_list_first: false });
      await clickBuild(root);
      expect(workspace.openBuildTab).toHaveBeenCalledWith(RUNNING);
      expect(workspace.openBuildTab).not.toHaveBeenCalledWith(null);
    },
  );

  it("a failed flag read opens the sites list, the key's default, not the old jump into the running build", async () => {
    serveFlags("fail");
    await clickBuild("panel");
    expect(workspace.openBuildTab).toHaveBeenCalledWith(null);
    expect(workspace.openBuildTab).not.toHaveBeenCalledWith(RUNNING);
  });

  it("with the key on and no bound build, Build still opens the list, not the current build", async () => {
    serveFlags({ site_list_first: true });
    workspace.buildSessionId = null;
    await clickBuild("panel");
    expect(workspace.openBuildTab).toHaveBeenCalledWith(null);
  });
});
