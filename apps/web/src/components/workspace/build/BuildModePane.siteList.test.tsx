// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const confirmAction = vi.fn();
const cancelRun = vi.fn(async () => null);
let sessionState: Record<string, unknown> = {};
let sessionsState: Record<string, unknown> = { currentSessionId: null, sessions: [], loaded: true };

vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: vi.fn(),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => sessionsState,
  readBuildSessions: () => sessionsState,
  refreshBuildSessions: vi.fn(async () => {}),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({
  confirmAction: (...args: unknown[]) => confirmAction(...args),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantName: "Acme", role: "owner" }),
  useWorkspaceOptional: () => ({ tenantName: "Acme", role: "owner" }),
}));
vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiUrl: (p: string) => p,
}));

import { BuildModePane } from "./BuildModePane";
import { resetWebsiteFramingForTests } from "@/lib/workspace/buildFraming";
import { startBuildSession } from "@/lib/workspace/useBuildSession";

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    loaded: true,
    notFound: false,
    loadError: null,
    authExpired: false,
    run: null,
    isCurrent: true,
    previewUrl: null,
    previewKind: "none",
    liveUrl: null,
    repoUrl: null,
    refines: [],
    refinesLoaded: true,
    sendRefine: vi.fn(),
    refineSubmitting: false,
    cancelRun,
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

const rows = Array.from({ length: 7 }, (_, i) => ({
  id: `s${i}`,
  title: i === 0 ? "Paws & Suds booking site" : i === 1 ? "Simple website for my yoga studio" : `Site ${i}`,
  request: "",
  state: i === 0 ? "building" : "ready",
  run_status: i === 0 ? "running" : "done",
  created_at: "2026-09-29T15:00:00Z",
  last_activity_at: "2026-09-29T16:00:00Z",
  refine_count: i === 1 ? 3 : 0,
  is_current: i === 0,
}));

const fetchMock = vi.fn();

function serveFlags(body: Record<string, unknown> | "fail") {
  fetchMock.mockImplementation(async (url: string) => {
    if (url !== "/api/public/build-framing") throw new Error(`unexpected ${url}`);
    if (body === "fail") return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => body };
  });
}

type PaneProps = { sessionId: string | null; resetNonce: number };

function mount(initial: PaneProps) {
  const onOpenSession = vi.fn();
  const onNewBuild = vi.fn();
  const el = (p: PaneProps) => (
    <BuildModePane
      sessionId={p.sessionId}
      previewOpen={false}
      focusNonce={0}
      resetNonce={p.resetNonce}
      onOpenPreview={vi.fn()}
      onPreviewUnavailable={vi.fn()}
      onPreviewProgress={vi.fn()}
      onOpenSession={onOpenSession}
      onNewBuild={onNewBuild}
    />
  );
  const view = render(el(initial));
  return { onOpenSession, rerender: (p: PaneProps) => view.rerender(el(p)) };
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const siteList = () => {
  const page = screen.queryByTestId("build-site-list");
  return page ? within(page).queryByRole("region", { name: "Your sites" }) : null;
};
const buildBox = () => screen.queryByRole("button", { name: "Build app" });

beforeEach(() => {
  resetWebsiteFramingForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  Element.prototype.scrollIntoView = vi.fn();
  sessionState = baseSession();
  sessionsState = { currentSessionId: "s0", sessions: rows, loaded: true };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("B34: Build opens a Your sites list with a New site button", () => {
  it("lands on the list, not the build box, and lists every site beyond the old cap of 5", async () => {
    serveFlags({ site_list_first: true });
    const { onOpenSession } = mount({ sessionId: null, resetNonce: 0 });
    await settle();
    const list = siteList();
    expect(list).not.toBeNull();
    expect(buildBox()).toBeNull();
    expect(screen.queryByLabelText("Your builds")).toBeNull();
    const items = within(list!).getAllByRole("listitem");
    expect(items).toHaveLength(7);
    expect(within(items[0]).getByRole("button").textContent).toMatch(/, Building, current$/);
    expect(items[0].getAttribute("aria-current")).toBe("true");
    expect(within(items[1]).getByRole("button").textContent).toMatch(/, Ready$/);
    expect(items[1].textContent).not.toMatch(/changes?\b|·/);
    fireEvent.click(within(items[1]).getByRole("button"));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("New site swaps the list for the build box", async () => {
    serveFlags({ site_list_first: true });
    mount({ sessionId: null, resetNonce: 0 });
    await settle();
    fireEvent.click(within(siteList()!).getByRole("button", { name: /New site/ }));
    expect(siteList()).toBeNull();
    expect(buildBox()).not.toBeNull();
  });

  it("l4.7: the new-site screen calls the same list Your sites, never Your builds", async () => {
    serveFlags({ site_list_first: true });
    mount({ sessionId: null, resetNonce: 0 });
    await settle();
    fireEvent.click(within(siteList()!).getByRole("button", { name: /New site/ }));
    expect(buildBox()).not.toBeNull();
    expect(screen.queryByLabelText("Your builds")).toBeNull();
    expect(screen.queryByText(/Your builds/i)).toBeNull();
    expect(siteList()).toBeNull();
    const list = screen.getByRole("region", { name: "Your sites" });
    expect(within(list).getByRole("heading", { level: 3, name: "Your sites" })).toBeTruthy();
    expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(within(list).queryByRole("button", { name: /New site/ })).toBeNull();
  });

  it("the site count sits beside the Your sites label, leaving New site alone on the right", async () => {
    serveFlags({ site_list_first: true });
    mount({ sessionId: null, resetNonce: 0 });
    await settle();
    const list = siteList()!;
    const heading = within(list).getByRole("heading", { level: 3, name: "Your sites" });
    const count = within(list).getByText(String(rows.length));
    const newSite = within(list).getByRole("button", { name: /New site/ });
    const group = heading.parentElement!;
    const row = group.parentElement!;

    expect(count.parentElement).toBe(group);
    expect(Array.from(group.children)).toEqual([heading, count]);
    expect(heading.contains(count)).toBe(false);
    expect(heading.textContent).toBe("Your sites");
    expect(group.className).not.toMatch(/justify-between/);
    expect(Array.from(row.children)).toEqual([group, newSite]);
    expect(Array.from(newSite.parentElement!.children)).not.toContain(count);
    expect(within(list).getAllByText(String(rows.length))).toHaveLength(1);
  });

  it("leaving a build through the nav shows the list; New build from inside a build shows the box", async () => {
    serveFlags({ site_list_first: true });
    sessionState = baseSession({ loaded: false });
    const pane = mount({ sessionId: "s0", resetNonce: 0 });
    await settle();
    expect(siteList()).toBeNull();

    sessionState = baseSession();
    pane.rerender({ sessionId: null, resetNonce: 0 });
    expect(siteList()).not.toBeNull();
    expect(buildBox()).toBeNull();

    sessionState = baseSession({ loaded: false });
    pane.rerender({ sessionId: "s1", resetNonce: 0 });
    sessionState = baseSession();
    pane.rerender({ sessionId: null, resetNonce: 1 });
    expect(siteList()).toBeNull();
    expect(buildBox()).not.toBeNull();

    sessionState = baseSession({ loaded: false });
    pane.rerender({ sessionId: "s2", resetNonce: 1 });
    sessionState = baseSession();
    pane.rerender({ sessionId: null, resetNonce: 1 });
    expect(siteList()).not.toBeNull();
    expect(buildBox()).toBeNull();
  });

  it("a founder with no sites yet gets the build box", async () => {
    serveFlags({ site_list_first: true });
    sessionsState = { currentSessionId: null, sessions: [], loaded: true };
    mount({ sessionId: null, resetNonce: 0 });
    await settle();
    expect(siteList()).toBeNull();
    expect(buildBox()).not.toBeNull();
  });

  it("a cold load with the flag and the site list both still in flight never flashes the build box before the list", async () => {
    let answerFlags: (body: Record<string, unknown>) => void = () => {};
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          if (url !== "/api/public/build-framing") throw new Error(`unexpected ${url}`);
          answerFlags = (body) => resolve({ ok: true, json: async () => body });
        }),
    );
    sessionsState = { currentSessionId: null, sessions: [], loaded: false, failed: false };
    let boxEverShown = false;
    const watch = new MutationObserver(() => {
      if (buildBox() || screen.queryByText(/Describe what you want to build/)) boxEverShown = true;
    });
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    const pane = mount({ sessionId: null, resetNonce: 0 });
    await settle();
    expect(screen.getByTestId("build-site-list-pending")).toBeTruthy();

    await act(async () => {
      answerFlags({ site_list_first: true });
    });
    await settle();
    expect(screen.getByTestId("build-site-list-pending")).toBeTruthy();

    sessionsState = { currentSessionId: "s0", sessions: rows, loaded: true, failed: false };
    pane.rerender({ sessionId: null, resetNonce: 0 });
    await settle();
    watch.disconnect();
    expect(siteList()).not.toBeNull();
    expect(boxEverShown).toBe(false);
  });

  it("the sites loading first still waits for the flag instead of showing the build box", async () => {
    let answerFlags: (body: Record<string, unknown>) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise((resolve) => (answerFlags = (body) => resolve({ ok: true, json: async () => body }))),
    );
    mount({ sessionId: null, resetNonce: 0 });
    await settle();
    expect(buildBox()).toBeNull();
    expect(screen.getByTestId("build-site-list-pending")).toBeTruthy();
    await act(async () => {
      answerFlags({ site_list_first: true });
    });
    await settle();
    expect(siteList()).not.toBeNull();
  });

  it("New build from inside a build shows the box at once, even while the flag is still unknown", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    sessionState = baseSession({ loaded: false });
    const pane = mount({ sessionId: "s0", resetNonce: 0 });
    sessionState = baseSession();
    sessionsState = { currentSessionId: "s0", sessions: rows, loaded: false, failed: false };
    pane.rerender({ sessionId: null, resetNonce: 1 });
    expect(screen.queryByTestId("build-site-list-pending")).toBeNull();
    expect(buildBox()).not.toBeNull();
  });

  it.each([
    ["the key resolves off while the sites are still loading", { site_list_first: false }, { loaded: false, failed: false, sessions: [] }],
    ["the site list read failed", { site_list_first: true }, { loaded: false, failed: true, sessions: [] }],
    ["the flag is unknown and there are no sites", null, { loaded: true, failed: false, sessions: [] }],
  ] as const)("the build box shows without waiting when %s", async (_label, flags, sites) => {
    if (flags) serveFlags(flags);
    else fetchMock.mockImplementation(() => new Promise(() => {}));
    sessionsState = { currentSessionId: null, ...sites };
    mount({ sessionId: null, resetNonce: 0 });
    await settle();
    expect(screen.queryByTestId("build-site-list-pending")).toBeNull();
    expect(buildBox()).not.toBeNull();
  });

  it("a failed flag read shows the Your sites list, the key's default, not the old build box", async () => {
    serveFlags("fail");
    mount({ sessionId: null, resetNonce: 0 });
    await settle();
    expect(siteList()).not.toBeNull();
    expect(buildBox()).toBeNull();
    expect(within(siteList()!).getByRole("button", { name: /New site/ })).toBeTruthy();
  });

  it("with the key off the old build box with a capped Your builds list shows", async () => {
    serveFlags({ site_list_first: false });
    mount({ sessionId: null, resetNonce: 0 });
    await settle();
    expect(siteList()).toBeNull();
    expect(buildBox()).not.toBeNull();
    const old = screen.getByLabelText("Your builds");
    expect(within(old).getAllByRole("listitem")).toHaveLength(5);
    expect(within(old).queryByRole("button", { name: /New site/ })).toBeNull();
    const heading = within(old).getByRole("heading", { level: 3, name: "Your builds" });
    const count = within(old).getByText(String(rows.length));
    expect(Array.from(heading.parentElement!.children)).toEqual([heading, count]);
    expect(heading.parentElement!.className).toMatch(/justify-between/);
    expect(heading.parentElement!.className).toMatch(/items-baseline/);
  });
});
