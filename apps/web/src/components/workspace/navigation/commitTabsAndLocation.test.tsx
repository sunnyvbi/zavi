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
import { commitTabsAndLocation } from "./workspaceRoutes";

const X = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";

const HOME: TabDescriptor = {
  id: "home-default",
  kind: "home",
  title: "Home",
  payload: { kind: "home" },
  dirty: false,
  pinned: true,
};

function agentTab(id: string, slug: string, threadId: string | null) {
  return {
    id,
    kind: "agent",
    title: slug,
    payload: { kind: "agent", slug, threadId },
    dirty: false,
    pinned: false,
  } as TabDescriptor;
}

type Api = {
  tabs: TabDescriptor[];
  activeTabId: string;
  setTabs: (update: (prev: TabDescriptor[]) => TabDescriptor[]) => void;
  activateTab: (tab: TabDescriptor) => void;
};

function mount(initial: TabDescriptor[]) {
  const seen: string[] = [];
  const api = {} as Api;
  function Harness() {
    const [stored, setTabs] = useState(initial);
    const nav = useWorkspaceNavigation(stored);
    seen.push(nav.activeTabId);
    Object.assign(api, {
      tabs: nav.tabs,
      activeTabId: nav.activeTabId,
      setTabs,
      activateTab: nav.activateTab,
    });
    return null;
  }
  render(<Harness />);
  return { seen, api };
}

async function bindAfterAwait(
  api: Api,
  tabId: string,
  threadId: string,
  order: "fixed" | "old",
) {
  await Promise.resolve();
  const tab = api.tabs.find((t) => t.id === tabId)!;
  const next = {
    ...tab,
    payload: { ...tab.payload, threadId },
  } as TabDescriptor;
  const update = () =>
    api.setTabs((prev) =>
      prev.some((t) => t.id === tabId)
        ? prev.map((t) => (t.id === tabId ? next : t))
        : [...prev, next],
    );
  if (order === "fixed") {
    commitTabsAndLocation(update, () => api.activateTab(next));
  } else {
    api.activateTab(next);
    update();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("commitTabsAndLocation", () => {
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

  it("control: the old split order renders a throwaway tab in between", async () => {
    window.history.replaceState(null, "", `/workspace/${A}`);
    const { seen, api } = mount([HOME, agentTab("t1", "operator", A)]);
    await settle();
    const before = seen.length;
    await bindAfterAwait(api, "t1", B, "old");
    await settle();
    expect(seen.slice(before).some((id) => id !== "t1")).toBe(true);
  });

  it("History rebind A → B never activates a route tab", async () => {
    window.history.replaceState(null, "", `/workspace/${A}`);
    const { seen, api } = mount([HOME, agentTab("t1", "operator", A)]);
    await settle();
    const before = seen.length;
    await bindAfterAwait(api, "t1", B, "fixed");
    await settle();
    const after = seen.slice(before);
    expect(after.some((id) => id.startsWith("route-"))).toBe(false);
    expect(api.activeTabId).toBe("t1");
    expect(window.location.pathname).toBe(`/workspace/${B}`);
    expect(window.location.search).toBe("");
  });

  it("first send in a fresh stored tab (null → X) stays on that tab", async () => {
    window.history.replaceState(null, "", "/workspace?agent=growth-lead");
    const { seen, api } = mount([HOME, agentTab("t2", "growth-lead", null)]);
    await settle();
    expect(api.activeTabId).toBe("t2");
    const before = seen.length;
    await bindAfterAwait(api, "t2", X, "fixed");
    await settle();
    expect(seen.slice(before).every((id) => id === "t2")).toBe(true);
  });

  it("first send in a route tab (opened by URL) keeps the same tab id throughout", async () => {
    window.history.replaceState(null, "", "/workspace?agent=growth-lead");
    const { seen, api } = mount([HOME]);
    await settle();
    const routeId = api.activeTabId;
    expect(routeId).toBe("route-growth-lead-new");
    const before = seen.length;
    await bindAfterAwait(api, routeId, X, "fixed");
    await settle();
    expect(seen.slice(before).every((id) => id === routeId)).toBe(true);
    expect(window.location.pathname).toBe(`/workspace/${X}`);
    expect(window.location.search).toBe("");
  });

  it("without navigate it is a plain tab update (no URL change)", async () => {
    window.history.replaceState(null, "", "/workspace");
    const { api } = mount([HOME, agentTab("t3", "operator", null)]);
    await settle();
    const search = window.location.search;
    commitTabsAndLocation(() =>
      api.setTabs((prev) => [...prev, agentTab("bg", "engineer", X)]),
    );
    await settle();
    expect(window.location.search).toBe(search);
    expect(api.tabs.some((t) => t.id === "bg")).toBe(true);
  });
});
