// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, render, screen, cleanup, within, fireEvent, waitFor } from "@testing-library/react";

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
const running = { enabled: true, docs: { status: "pending", files: 0, facts: 0 }, connectors: { status: "pending" }, done: false, home_seen: false, draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: true } };

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

const openedKinds = () => workspace.openTab.mock.calls.map(([d]) => (d as { kind: string; payload: Record<string, unknown> }));

const ROWS: ReadonlyArray<readonly [string, () => void]> = [
  ["Home", () => expect(workspace.openAgentTab).toHaveBeenCalledWith("operator", { newThread: true, push: true })],
  ["Growth Channels", () => expect(openedKinds().map((d) => d.kind)).toEqual(["channels"])],
  ["Analytics", () => expect(openedKinds().map((d) => d.kind)).toEqual(["analytics"])],
  ["Messaging", () => expect(openedKinds().map((d) => d.kind)).toEqual(["messaging"])],
  ["Agent Builder", () => expect(openedKinds()).toEqual([expect.objectContaining({ kind: "agent-builder", payload: { kind: "agent-builder", agentId: null } })])],
  ["Artifacts", () => expect(openedKinds().map((d) => d.kind)).toEqual(["artifacts"])],
  ["Connectors", () => expect(openedKinds().map((d) => d.kind)).toEqual(["brain"])],
  ["Fundraising", () => expect(openedKinds().map((d) => d.kind)).toEqual(["fundraising"])],
  ["Supply & Demand", () => expect(openedKinds().map((d) => d.kind)).toEqual(["supply-demand"])],
  ["Engineer", () => expect(openedKinds().map((d) => d.kind)).toEqual(["settings"])],
];

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\&]/g, "\\$&");

async function runSetup(which: "panel" | "rail") {
  mount(which);
  await act(async () => {
    h.answer!(running);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function resetCalls() {
  workspace.openTab.mockClear();
  workspace.openAgentTab.mockClear();
  workspace.openBuildTab.mockClear();
}

afterEach(() => {
  cleanup();
  h.answer = null;
  h.role = "owner";
  resetCalls();
});

describe("no setup lock: an owner mid-setup can open every sidebar destination", () => {
  it.each(["panel", "rail"] as const)("%s: setup running for an owner, every row is enabled, no lock tooltip or note, and the setup itself opens nothing", async (which) => {
    await runSetup(which);
    expect(workspace.openTab).not.toHaveBeenCalled();
    expect(workspace.openBuildTab).not.toHaveBeenCalled();
    expect(workspace.openAgentTab).not.toHaveBeenCalled();
    const scopes = which === "panel"
      ? [screen.getByRole("navigation", { name: "Destinations" }), screen.getByRole("navigation", { name: "Custom agents" })]
      : [screen.getByRole("navigation", { name: "Destinations" })];
    const buttons = scopes.flatMap((nav) => within(nav).getAllByRole("button")) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThanOrEqual(13);
    for (const b of buttons) {
      expect(b.disabled, b.textContent ?? "").toBe(false);
      expect(b.getAttribute("aria-busy")).toBeNull();
      expect(b.getAttribute("title")).not.toBe("Finish the welcome steps first");
      expect(b.className).not.toMatch(/cursor-not-allowed/);
    }
    expect(document.querySelector('[title="Finish the welcome steps first"]')).toBeNull();
    expect(screen.queryByText(/opens when your growth strategy is ready/)).toBeNull();
  });

  it.each(["panel", "rail"] as const)("%s: clicking each formerly locked row while setup runs opens its own destination", async (which) => {
    await runSetup(which);
    const scope = () => (which === "panel" ? within(screen.getByRole("navigation", { name: "Destinations" })) : screen);
    for (const [name, check] of ROWS) {
      resetCalls();
      fireEvent.click(scope().getByRole("button", { name: new RegExp(`^${escape(name)}`) }));
      check();
    }
    resetCalls();
    fireEvent.click(scope().getByRole("button", { name: /^Build$/ }));
    await waitFor(() => expect(workspace.openBuildTab).toHaveBeenCalledTimes(1));
  });

  it("panel: the custom agent row and Recent's New Chat open while setup runs", async () => {
    await runSetup("panel");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Custom agents" })).getByRole("button", { name: /^Review Replier/ }));
    expect(openedKinds()).toEqual([expect.objectContaining({ kind: "agent-builder", payload: { kind: "agent-builder", agentId: "c-abcd1234" } })]);
    const newChat = screen.getByRole("button", { name: "New Chat" }) as HTMLButtonElement;
    expect(newChat.disabled).toBe(false);
    fireEvent.click(newChat);
    expect(workspace.openAgentTab).toHaveBeenCalledWith("operator", { newThread: true, push: true });
  });

  it("panel: the account menu entries stay usable while setup runs", async () => {
    await runSetup("panel");
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = within(screen.getByRole("menu", { name: "Account" }));
    for (const name of ["Settings", "Account", "Board", "Members", "Feedback"]) {
      const item = menu.getByRole("menuitem", { name: new RegExp(name) }) as HTMLButtonElement;
      expect(item.disabled, name).toBe(false);
    }
    const help = menu.getByRole("menuitem", { name: /Help/ });
    expect(help.tagName).toBe("A");
    expect(help.getAttribute("href")).toBe("/talk-to-team");
    resetCalls();
    fireEvent.click(menu.getByRole("menuitem", { name: /Settings/ }));
    expect(openedKinds().map((d) => d.kind)).toEqual(["settings"]);
  });

  it("the plan lock is not the setup lock: the Pro-only Engineer row keeps its plan lock icon in the panel while the setup lock is gone", async () => {
    await runSetup("panel");
    const engineer = within(screen.getByRole("navigation", { name: "Destinations" })).getByRole("button", { name: /^Engineer/ }) as HTMLButtonElement;
    expect(engineer.disabled).toBe(false);
    expect(engineer.querySelector(".lucide-lock")).not.toBeNull();
    const fundraising = within(screen.getByRole("navigation", { name: "Destinations" })).getByRole("button", { name: /^Fundraising/ });
    expect(fundraising.querySelector(".lucide-lock")).toBeNull();
  });
});
