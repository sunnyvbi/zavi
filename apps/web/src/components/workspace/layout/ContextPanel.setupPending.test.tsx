// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, render, screen, cleanup, within, fireEvent } from "@testing-library/react";

const h = vi.hoisted(() => ({
  answer: null as null | ((body: Record<string, unknown>) => void),
  role: "owner",
}));

const workspace = {
  tabs: [
    { id: "home-default", kind: "home", title: "Home", payload: { kind: "home" }, dirty: false, pinned: true },
    { id: "growth", kind: "autopilot", title: "Growth Strategy", payload: { kind: "autopilot" }, dirty: false, pinned: false },
  ],
  activeTabId: "home-default",
  buildSessionId: null,
  tenantName: "Paws & Suds",
  openAgentTab: vi.fn(),
  openBuildTab: vi.fn(),
  openTab: vi.fn(),
  openStatic: vi.fn(),
  setActiveTab: vi.fn(),
  setTabThreadId: vi.fn(),
  treeAgents: [],
  supplyDemandEligible: false,
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
    if (url === "/api/workspace/setup") {
      return new Promise((resolve) => {
        h.answer = (body) => resolve({ ok: true, status: 200, json: async () => body });
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }),
}));
vi.mock("./AppearanceMenu", () => ({ AppearanceMenu: () => null }));
vi.mock("./workspacePrefs", () => ({}));

import { ContextPanel, ContextRail } from "./ContextPanel";
import { SetupProvider } from "../setup/SetupProvider";

const noop = () => {};
const FORMERLY_GATED = ["Home", "Growth Channels", "Analytics", "Messaging", "Build", "Agent Builder", "Artifacts", "Connectors"];
const LOCK_NOTE = /opens when your growth strategy is ready/;
const running = { enabled: true, done: false, build_open: false, home_seen: false, docs: { status: "pending", files: 0, facts: 0 }, connectors: { status: "pending" }, draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: true } };

function mount(which: "panel" | "rail") {
  return render(
    <SetupProvider>
      {which === "panel" ? (
        <ContextPanel onCollapse={noop} theme="system" onSetTheme={noop} chatFocus={false} />
      ) : (
        <ContextRail onExpand={noop} chatFocus={false} />
      )}
    </SetupProvider>,
  );
}

function rows(which: "panel" | "rail"): HTMLButtonElement[] {
  const scope = which === "panel" ? within(screen.getByRole("navigation", { name: "Destinations" })) : screen;
  return FORMERLY_GATED.map((name) => scope.getByRole("button", { name: new RegExp(`^${name}$`) }) as HTMLButtonElement);
}

function watchLocks(buttons: HTMLButtonElement[]): string[] {
  const locked: string[] = [];
  const observer = new MutationObserver(() => {
    for (const b of buttons) if (b.disabled || b.hasAttribute("aria-busy")) locked.push(b.textContent ?? "");
  });
  for (const b of buttons) observer.observe(b, { attributes: true });
  return locked;
}

function expectOpen(buttons: HTMLButtonElement[]) {
  for (const b of buttons) {
    expect(b.disabled, b.getAttribute("aria-label") ?? b.textContent ?? "").toBe(false);
    expect(b.getAttribute("aria-busy")).toBeNull();
    expect(b.getAttribute("title")).not.toBe("Finish the welcome steps first");
  }
}

afterEach(() => {
  cleanup();
  h.answer = null;
  h.role = "owner";
  workspace.openTab.mockClear();
  workspace.openAgentTab.mockClear();
  workspace.openBuildTab.mockClear();
});

describe("the nav is open from first paint, whatever the setup read says", () => {
  it.each(["panel", "rail"] as const)("%s: rows are open through a slow read and stay open when it says setup is running for an owner", async (which) => {
    mount(which);
    const buttons = rows(which);
    expectOpen(buttons);
    expect(screen.queryByText(LOCK_NOTE)).toBeNull();
    const locked = watchLocks(buttons);
    await act(async () => {
      h.answer!(running);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expectOpen(rows(which));
    expect(locked).toEqual([]);
    expect(screen.queryByText(LOCK_NOTE)).toBeNull();
    expect(workspace.openTab).not.toHaveBeenCalled();
    expect(workspace.openBuildTab).not.toHaveBeenCalled();
  });

  it.each(["panel", "rail"] as const)("%s: a click during the slow read opens its page instead of waiting on the setup state", async (which) => {
    mount(which);
    const analytics = rows(which)[FORMERLY_GATED.indexOf("Analytics")]!;
    fireEvent.click(analytics);
    expect(workspace.openTab.mock.calls.map(([d]) => (d as { kind: string }).kind)).toEqual(["analytics"]);
  });

  it.each(["panel", "rail"] as const)("%s: rows stay open when the read says setup is off", async (which) => {
    mount(which);
    await act(async () => {
      h.answer!({ enabled: false });
    });
    expectOpen(rows(which));
    expect(screen.queryByText(LOCK_NOTE)).toBeNull();
  });

  it("a member gets open rows from the first paint", () => {
    h.role = "member";
    mount("panel");
    expectOpen(rows("panel"));
  });
});
