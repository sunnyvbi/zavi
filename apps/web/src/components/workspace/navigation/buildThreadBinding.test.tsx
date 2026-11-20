// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useState } from "react";
import type { TabDescriptor } from "@/lib/workspace/types";

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: vi.fn() }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: vi.fn() }));

import { useWorkspaceNavigation } from "./useWorkspaceNavigation";
import { resolveWorkspaceTab, workspaceTabHref } from "./workspaceRoutes";

const SESSION = "11111111-1111-4111-8111-111111111111";
const BUILD_THREAD = "22222222-2222-4222-8222-222222222222";
const OTHER_THREAD = "33333333-3333-4333-8333-333333333333";

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
    id: "tab-build",
    kind: "build",
    title: "Build",
    payload: payload as TabDescriptor["payload"],
    dirty: false,
    pinned: false,
  };
}

const boundThreadOf = (tab: TabDescriptor | undefined) =>
  tab && tab.payload.kind === "build" ? tab.payload.threadId : "NO BUILD TAB";

type Api = {
  tabs: TabDescriptor[];
  setTabs: (update: (prev: TabDescriptor[]) => TabDescriptor[]) => void;
  activateTab: (tab: TabDescriptor) => void;
};

function mount(initial: TabDescriptor[]) {
  const api = {} as Api;
  function Harness() {
    const [stored, setTabs] = useState(initial);
    const nav = useWorkspaceNavigation(stored);
    Object.assign(api, {
      tabs: nav.tabs,
      setTabs,
      activateTab: nav.activateTab,
    });
    return null;
  }
  render(<Harness />);
  return api;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

const buildOf = (api: Api) => api.tabs.find((t) => t.payload.kind === "build");

function bind(api: Api, threadId: string | null) {
  const tab = api.tabs.find((t) => t.id === "tab-build")!;
  const next = { ...tab, payload: { ...tab.payload, threadId } } as TabDescriptor;
  api.setTabs((prev) => prev.map((t) => (t.id === "tab-build" ? next : t)));
}

describe("resolveWorkspaceTab and the build tab's bound thread", () => {
  const BUILD_URL = `/workspace?tab=build&build=${SESSION}`;

  it("keeps the thread the tab already bound", () => {
    const active = resolveWorkspaceTab(
      [HOME, buildTab({ bound: true, value: BUILD_THREAD })],
      BUILD_URL,
    );
    expect(active.payload.kind).toBe("build");
    expect(boundThreadOf(active)).toBe(BUILD_THREAD);
  });

  it("keeps a deliberately blank build chat blank rather than resolve-latest", () => {
    const active = resolveWorkspaceTab(
      [HOME, buildTab({ bound: true, value: null })],
      BUILD_URL,
    );
    expect(boundThreadOf(active)).toBeNull();
  });

  it("leaves a never-bound build tab asking for the latest conversation", () => {
    const active = resolveWorkspaceTab([HOME, buildTab({ bound: false })], BUILD_URL);
    expect(boundThreadOf(active)).toBeUndefined();
  });

  it("still tracks the session id the URL names", () => {
    const active = resolveWorkspaceTab(
      [HOME, buildTab({ bound: true, value: BUILD_THREAD })],
      "/workspace?tab=build",
    );
    expect(active.payload.kind === "build" && active.payload.sessionId).toBeNull();
    expect(boundThreadOf(active)).toBe(BUILD_THREAD);
  });

  it("survives the tab's own href, the URL every activation writes", () => {
    const tab = buildTab({ bound: true, value: BUILD_THREAD });
    const href = workspaceTabHref(tab, BUILD_URL);
    expect(boundThreadOf(resolveWorkspaceTab([HOME, tab], href))).toBe(BUILD_THREAD);
  });
});

describe("the tabs the Build surface actually reads", () => {
  let actEnv: unknown;
  beforeEach(() => {
    actEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
      .IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT =
      false;
  });
  afterEach(() => {
    cleanup();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT =
      actEnv;
    window.history.replaceState(null, "", "/");
  });

  it("carries the bound thread through the nav layer, not just the stored list", async () => {
    window.history.replaceState(null, "", `/workspace?tab=build&build=${SESSION}`);
    const api = mount([HOME, buildTab({ bound: true, value: BUILD_THREAD })]);
    await settle();
    expect(boundThreadOf(buildOf(api))).toBe(BUILD_THREAD);
  });

  it("shows a History pick beside the app instead of swallowing it", async () => {
    window.history.replaceState(null, "", `/workspace?tab=build&build=${SESSION}`);
    const api = mount([HOME, buildTab({ bound: false })]);
    await settle();
    expect(boundThreadOf(buildOf(api))).toBeUndefined();
    bind(api, OTHER_THREAD);
    await settle();
    expect(boundThreadOf(buildOf(api))).toBe(OTHER_THREAD);
  });

  it("holds the binding across a re-render that rewrites the location", async () => {
    window.history.replaceState(null, "", `/workspace?tab=build&build=${SESSION}`);
    const api = mount([HOME, buildTab({ bound: false })]);
    await settle();
    bind(api, BUILD_THREAD);
    await settle();
    api.activateTab(buildOf(api)!);
    await settle();
    expect(boundThreadOf(buildOf(api))).toBe(BUILD_THREAD);
  });

  it("does not leak the build's thread onto another tab", async () => {
    window.history.replaceState(null, "", `/workspace?tab=build&build=${SESSION}`);
    const api = mount([HOME, buildTab({ bound: true, value: BUILD_THREAD })]);
    await settle();
    const home = api.tabs.find((t) => t.payload.kind === "home")!;
    expect((home.payload as { threadId?: unknown }).threadId).toBeUndefined();
  });
});
