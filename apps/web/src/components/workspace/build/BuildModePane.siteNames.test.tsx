// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";

let sessionState: Record<string, unknown> = {};
let sessionsState: Record<string, unknown> = {};

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
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn() }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantName: "Apna Tutor", role: "owner" }),
  useWorkspaceOptional: () => ({ tenantName: "Apna Tutor", role: "owner" }),
}));
vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));
vi.mock("@/lib/workspace/useGithubRepos", () => ({
  useGithubRepos: () => ({ state: { status: "loading" }, pending: false, setDefault: vi.fn() }),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiUrl: (p: string) => p,
}));

import { BuildModePane } from "./BuildModePane";
import { resetWebsiteFramingForTests } from "@/lib/workspace/buildFraming";

const OLD_RUN = "11111111-0000-4000-8000-00000000000a";
const NEW_RUN = "22222222-0000-4000-8000-00000000000b";

function row(id: string, title: string, site: Record<string, unknown> | undefined) {
  return {
    id,
    title,
    request: title,
    state: "ready",
    run_status: "done",
    created_at: "2026-10-01T09:00:00Z",
    last_activity_at: "2026-10-01T09:30:00Z",
    refine_count: 0,
    is_current: true,
    ...(site ? { site } : {}),
  };
}

const ROWS = [
  row(NEW_RUN, "Build product: Apna Tutor — a yoga site", {
    hostname: "still-water-yoga-693dfbdb-bbbbbb.zaviagent.com",
    live_url: "https://still-water-yoga-693dfbdb-bbbbbb.zaviagent.com",
    status: "live",
    name: "Still Water Yoga",
    repo: "Praxis-build/still-water-yoga-693dfbdb-bbbbbb",
  }),
  row(OLD_RUN, "Build product: Apna Tutor — a dog grooming site", {
    hostname: "paws-suds-693dfbdb-aaaaaa.zaviagent.com",
    live_url: "https://paws-suds-693dfbdb-aaaaaa.zaviagent.com",
    status: "live",
    name: "Paws & Suds",
    repo: "Praxis-build/paws-suds-693dfbdb-aaaaaa",
  }),
  row("old-run", "Old tutoring app", undefined),
];

function readySession() {
  return {
    loaded: true,
    notFound: false,
    loadError: null,
    authExpired: false,
    run: { id: OLD_RUN, objective: "Build product: Apna Tutor — a dog grooming site", status: "done", createdAt: null, updatedAt: null, stages: [], failure: null },
    isCurrent: true,
    previewUrl: null,
    previewKind: "final",
    liveUrl: "https://paws-suds-693dfbdb-aaaaaa.zaviagent.com",
    repoUrl: null,
    refines: [],
    refinesLoaded: true,
    sendRefine: vi.fn(),
    refineSubmitting: false,
    cancelRun: vi.fn(),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
    publish: { status: "none" },
    appReady: true,
  };
}

const fetchMock = vi.fn(async (url: string) => {
  if (url !== "/api/public/build-framing") throw new Error(`unexpected ${url}`);
  return { ok: true, json: async () => ({ site_list_first: true }) };
});

function mount(sessionId: string | null) {
  render(
    <BuildModePane
      sessionId={sessionId}
      previewOpen={false}
      focusNonce={0}
      resetNonce={0}
      onOpenPreview={vi.fn()}
      onPreviewUnavailable={vi.fn()}
      onPreviewProgress={vi.fn()}
      onOpenSession={vi.fn()}
      onNewBuild={vi.fn()}
    />,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  resetWebsiteFramingForTests();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Element.prototype.scrollIntoView = vi.fn();
  sessionState = readySession();
  sessionsState = {
    currentSessionId: NEW_RUN,
    sessions: ROWS,
    loaded: true,
    flags: { siteNames: true, siteRepoChip: true, siteListDetails: true },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DEL-1323 B34: Your sites titles each row with the site's name", () => {
  it("site rows show the site's name with its hostname under it; an old-flow row keeps its title", async () => {
    sessionState = { ...readySession(), run: null };
    mount(null);
    await settle();
    const list = screen.getByRole("region", { name: "Your sites" });
    const items = within(list).getAllByRole("listitem");
    expect(within(items[0]).getByText("Still Water Yoga")).toBeTruthy();
    expect(within(items[0]).getByText("still-water-yoga-693dfbdb-bbbbbb.zaviagent.com")).toBeTruthy();
    expect(within(items[1]).getByText("Paws & Suds")).toBeTruthy();
    expect(within(items[2]).getByText("Old tutoring app")).toBeTruthy();
    expect(within(list).queryByText(/Build product: Apna Tutor/)).toBeNull();
  });

  it("with the key off the rows keep the build titles", async () => {
    sessionState = { ...readySession(), run: null };
    sessionsState = { ...sessionsState, flags: { siteNames: false, siteRepoChip: false, siteListDetails: false } };
    mount(null);
    await settle();
    const list = screen.getByRole("region", { name: "Your sites" });
    expect(within(list).getByText("Build product: Apna Tutor — a yoga site")).toBeTruthy();
    expect(within(list).queryByText("Still Water Yoga")).toBeNull();
  });
});

describe("DEL-1323 B33: the build page names the open site, not the workspace", () => {
  it("an older site's page says 'Editing Paws & Suds', never the workspace or the newer site", async () => {
    mount(OLD_RUN);
    await settle();
    const strip = screen.getByText(/Editing/);
    expect(strip.textContent).toContain("Editing Paws & Suds.");
    expect(strip.textContent).not.toContain("Apna Tutor");
    expect(strip.textContent).not.toContain("Still Water Yoga");
  });
});

describe("an owner never sees the build's internal ids", () => {
  it("the build page shows no build ID, no copy-ID button and no Zavi-made repo name", async () => {
    mount(OLD_RUN);
    await settle();
    expect(screen.getByText(/Editing/)).toBeTruthy();
    expect(screen.queryByText(/\bBuild [0-9a-f]{8}\b/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy build ID/ })).toBeNull();
    expect(screen.queryByText(/paws-suds-693dfbdb-aaaaaa(?!\.zaviagent)/)).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/Praxis-build\//);
  });
});
