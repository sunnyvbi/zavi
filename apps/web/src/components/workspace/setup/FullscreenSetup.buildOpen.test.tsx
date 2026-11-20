// @vitest-environment jsdom
vi.mock("next/navigation", async () => import("./setupNavigation.testSupport"));
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

type Tab = { id: string; kind: string; title: string; payload: Record<string, unknown>; dirty: boolean; pinned: boolean };
type Snapshot = {
  tabs: Tab[];
  activeTabId: string;
  role: string;
  buildSessionId: string | null;
  openTab: (d: Omit<Tab, "id">) => string;
  openBuildTab: (id?: string | null) => string;
};

const h = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const s = {
    tabs: [] as Tab[],
    activeTabId: "",
    calls: [] as string[],
    fetches: [] as string[],
    setup: null as unknown,
    snap: null as Snapshot | null,
  };
  const buildTab = (id: string | null): Tab => ({ id: "build", kind: "build", title: "Build", payload: { kind: "build", sessionId: id }, dirty: false, pinned: false });
  const make = (): Snapshot => {
    const build = s.tabs.find((t) => t.kind === "build");
    return {
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      role: "owner",
      buildSessionId: (build?.payload.sessionId as string | null | undefined) ?? null,
      openTab: (d) => {
        s.calls.push(`open:${d.kind}`);
        activate(s.tabs.find((t) => t.kind === d.kind) ?? { ...d, id: d.kind });
        return d.kind;
      },
      openBuildTab: (id) => {
        s.calls.push(`build:${id}`);
        activate(s.tabs.find((t) => t.kind === "build") ?? buildTab(id ?? null));
        return "build";
      },
    };
  };
  const emit = () => {
    s.snap = make();
    listeners.forEach((l) => l());
  };
  const activate = (tab: Tab) => {
    if (!s.tabs.some((t) => t.id === tab.id)) s.tabs = [...s.tabs, tab];
    s.activeTabId = tab.id;
    emit();
  };
  return {
    s,
    buildTab,
    reset(tabs: Tab[], active: string, setup: unknown) {
      s.tabs = tabs;
      s.activeTabId = active;
      s.calls = [];
      s.fetches = [];
      s.setup = setup;
      s.snap = make();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    read: () => s.snap as Snapshot,
  };
});

vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var" } }));
vi.mock("../WorkspaceShell", async () => {
  const React = await import("react");
  const use = () => React.useSyncExternalStore(h.subscribe, h.read);
  return { useWorkspace: use, useWorkspaceOptional: use };
});
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    h.s.fetches.push(path);
    if (path === "/api/workspace/setup") return { ok: true, status: 200, json: async () => h.s.setup };
    if (path === "/api/knowledge/imports") return { ok: true, status: 200, json: async () => ({ files: [] }) };
    if (path === "/api/connectors/company-facts")
      return { ok: true, status: 200, json: async () => ({ facts: [{ key: "company_name", value_text: "Paws & Suds" }] }) };
    if (path === "/api/connectors") return { ok: true, status: 200, json: async () => ({ connectors: [] }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }),
}));
vi.mock("../brain/useActiveTenant", () => ({ useActiveTenant: () => "tenant-paws" }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => false) }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("./PastWorkStep", () => ({ PastWorkStep: ({ onComplete, onSkip, onBack }: { onBack?: () => void; onComplete: () => Promise<unknown>; onSkip: () => Promise<unknown> }) => <div>past work{onBack && <button type="button" onClick={onBack}>Back to your build</button>}<button type="button" onClick={() => void onComplete()}>Add to Zavi</button><button type="button" onClick={() => void onSkip()}>Skip</button></div> }));
vi.mock("./SetupConnectorsStep", () => ({ SetupConnectorsStep: () => <div>connectors step</div> }));
vi.mock("./SetupPolishStep", () => ({ SetupPolishStep: () => <div>polish step</div> }));

import { useWorkspace } from "../WorkspaceShell";
import { SetupProvider } from "./SetupProvider";
import { FullscreenSetup } from "./FullscreenSetup";
import { BuildSetupFrame } from "./BuildSetupPanel";
import * as copy from "./setupCopy";

const BUILD = "b8b5d121-0000-4000-8000-000000000000";
const home: Tab = { id: "home-default", kind: "home", title: "Home", payload: { kind: "home" }, dirty: false, pinned: true };
const running = {
  enabled: true,
  docs: { status: "pending", files: 0, facts: 0 },
  connectors: { status: "pending" },
  done: false,
  home_seen: false,
  draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: true },
};
const buildOpen = { ...running, build_open: true };

function Workspace() {
  const ws = useWorkspace();
  const kind = ws.tabs.find((t) => t.id === ws.activeTabId)?.kind;
  return (
    <SetupProvider>
      <FullscreenSetup />
      <div className="workspace-shell">
        {kind === "build" && (
          <BuildSetupFrame>
            <p>Paws &amp; Suds booking site</p>
            <button type="button">Edit my site</button>
          </BuildSetupFrame>
        )}
        {kind === "autopilot" && <p>Growth Strategy page</p>}
        {kind === "home" && <p>Home page</p>}
      </div>
    </SetupProvider>
  );
}

const dialog = () => screen.queryByRole("dialog", { name: "Set up Zavi" });
const panel = () => screen.queryByRole("complementary", { name: copy.BUILD_PANEL_TITLE });
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  try {
    window.sessionStorage.clear();
  } catch {
    return;
  }
});
afterEach(cleanup);

describe("B10: the welcome setup never covers the founder's build while build_open", () => {
  it("landing on /workspace?tab=build&build=<id> after an idea signup: the build shows, the setup waits in the side panel, no full-screen dialog and no focus trap", async () => {
    h.reset([home, h.buildTab(BUILD)], "build", buildOpen);
    render(<Workspace />);
    await waitFor(() => expect(h.s.fetches).toContain("/api/workspace/setup"));
    await waitFor(() => expect(panel()).not.toBeNull());
    await settle();

    expect(dialog()).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(screen.getByText("Paws & Suds booking site")).toBeTruthy();
    expect(h.s.calls).toEqual([]);
    expect(h.s.activeTabId).toBe("build");

    const edit = screen.getByRole("button", { name: "Edit my site" });
    act(() => edit.focus());
    await settle();
    expect(document.activeElement).toBe(edit);

    fireEvent.click(screen.getByRole("button", { name: /Continue setup/ }));
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(h.s.calls).toEqual(["open:autopilot"]);
    expect(screen.getByText("past work")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: copy.SETUP_BACK_TO_BUILD }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(h.s.calls).toEqual(["open:autopilot", `build:${BUILD}`]);
    expect(h.s.activeTabId).toBe("build");
    expect(panel()).not.toBeNull();
    expect(screen.getByRole("button", { name: "Edit my site" })).toBeTruthy();
  });

  it("dismissing the side panel leaves the build open and still no full-screen setup", async () => {
    h.reset([home, h.buildTab(BUILD)], "build", buildOpen);
    render(<Workspace />);
    await waitFor(() => expect(panel()).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: copy.BUILD_PANEL_DISMISS }));
    await settle();
    expect(panel()).toBeNull();
    expect(dialog()).toBeNull();
    expect(screen.getByRole("button", { name: "Edit my site" })).toBeTruthy();
    expect(h.s.calls).toEqual([]);
  });

  it.each([
    ["build_open", buildOpen],
    ["key off", running],
  ] as const)("%s on Home with a build in the tabs: Home stays the active tab, nothing opens Growth or the build", async (_label, setup) => {
    h.reset([home, h.buildTab(BUILD)], "home-default", setup);
    render(<Workspace />);
    await waitFor(() => expect(h.s.fetches).toContain("/api/workspace/setup"));
    await waitFor(() => expect(dialog()).not.toBeNull());
    await settle();
    await settle();
    expect(h.s.calls).toEqual([]);
    expect(h.s.activeTabId).toBe("home-default");
    expect(screen.getByText("Home page")).toBeTruthy();
  });

  it("build_open on Home: the full-screen setup offers the way back to the build, and only that click opens it", async () => {
    h.reset([home, h.buildTab(BUILD)], "home-default", buildOpen);
    render(<Workspace />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    await settle();
    expect(h.s.calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: copy.SETUP_BACK_TO_BUILD }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(h.s.calls).toEqual([`build:${BUILD}`]);
    expect(h.s.activeTabId).toBe("build");
    expect(panel()).not.toBeNull();
  });

  it("build_open with no build yet (a website signup) stays on Home under the full-screen setup, with no way back to a build", async () => {
    h.reset([home], "home-default", buildOpen);
    render(<Workspace />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    await settle();
    expect(h.s.calls).toEqual([]);
    expect(h.s.activeTabId).toBe("home-default");
    expect(screen.queryByRole("button", { name: copy.SETUP_BACK_TO_BUILD })).toBeNull();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
  });

  it("key off (no build_open): the Build tab stays put and the full-screen setup covers it", async () => {
    h.reset([home, h.buildTab(BUILD)], "build", running);
    render(<Workspace />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    await settle();
    expect(h.s.calls).toEqual([]);
    expect(h.s.activeTabId).toBe("build");
    expect(panel()).toBeNull();
    expect(screen.queryByRole("button", { name: copy.SETUP_BACK_TO_BUILD })).toBeNull();
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
  });
});

describe("a website build sign-up never gets the setup steps", () => {
  const fromScratch = { ...buildOpen, from_scratch: true };

  it("on the build: no side panel asking to continue setup, no dialog", async () => {
    h.reset([home, h.buildTab(BUILD)], "build", fromScratch);
    render(<Workspace />);
    await waitFor(() => expect(h.s.fetches).toContain("/api/workspace/setup"));
    await settle();
    expect(panel()).toBeNull();
    expect(dialog()).toBeNull();
    expect(screen.queryByText("past work")).toBeNull();
    expect(screen.getByText("Paws & Suds booking site")).toBeTruthy();
  });

  it("opening Growth Strategy directly shows the page, not Past work or the business questions", async () => {
    h.reset([home, h.buildTab(BUILD), { id: "autopilot", kind: "autopilot", title: "Growth", payload: { kind: "autopilot" }, dirty: false, pinned: false }], "autopilot", fromScratch);
    render(<Workspace />);
    await waitFor(() => expect(h.s.fetches).toContain("/api/workspace/setup"));
    await settle();
    expect(dialog()).toBeNull();
    expect(screen.queryByText("past work")).toBeNull();
    expect(screen.queryByText("polish step")).toBeNull();
  });

  it("the growth flow (no from_scratch) still gets the setup steps on Growth Strategy", async () => {
    h.reset([home, { id: "autopilot", kind: "autopilot", title: "Growth", payload: { kind: "autopilot" }, dirty: false, pinned: false }], "autopilot", running);
    render(<Workspace />);
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(screen.getByText("past work")).toBeTruthy();
  });
});
