// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

let sessionState: Record<string, unknown> = {};
let sessionsState: Record<string, unknown> = { currentSessionId: "run-1", sessions: [], loaded: true };

vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: vi.fn(),
  undoBuildRefine: vi.fn(),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => sessionsState,
  readBuildSessions: () => sessionsState,
  refreshBuildSessions: vi.fn(async () => {}),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn() }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tenantName: "Acme", role: "owner" }),
  useWorkspaceOptional: () => ({ tenantName: "Acme", role: "owner" }),
}));
vi.mock("@/components/voice/MicButton", () => ({ MicButton: () => null }));
vi.mock("@/lib/workspace/buildFraming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/buildFraming")>()),
  useSiteListFirst: () => false,
}));

import { BuildModePane } from "./BuildModePane";
import { readBuildPublish } from "@/lib/workspace/buildPublish";
import { BUILD_FIXES_EXHAUSTED } from "@zavi/shared";

const LIVE = "https://bakery-9f8e7d.zaviagent.com";
const ADMIN = "https://bakery-9f8e7d.zaviagent.com/admin";
const SITE_STAGES = [
  { stage: "provision", status: "done", finished_at: "2026-10-05T05:31:00Z" },
  { stage: "build", status: "done", finished_at: "2026-10-05T05:39:00Z" },
];

const continueRun = vi.fn(async () => null);

function session(overrides: Record<string, unknown> = {}) {
  return {
    loaded: true,
    notFound: false,
    loadError: null,
    authExpired: false,
    run: {
      id: "run-1",
      objective: "Build product: A bakery site",
      status: "done",
      createdAt: "2026-10-05T05:30:00Z",
      updatedAt: "2026-10-05T05:39:00Z",
      stages: SITE_STAGES,
      failure: null,
    },
    isCurrent: true,
    retired: false,
    previewUrl: "https://3000-sbx.e2b.app",
    previewKind: "instant",
    liveUrl: null,
    adminUrl: null,
    adminSetupEmail: null,
    repoUrl: null,
    refines: [],
    refinesLoaded: true,
    appReady: true,
    appReadyAt: "2026-10-05T05:39:30Z",
    publish: readBuildPublish({ status: "none" }),
    sendRefine: vi.fn(async () => null),
    refineSubmitting: false,
    cancelRun: vi.fn(async () => null),
    stopping: false,
    continueRun,
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function renderPane() {
  return render(
    <BuildModePane
      sessionId="run-1"
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

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  sessionsState = { currentSessionId: "run-1", sessions: [], loaded: true, uiFlags: { publishOnRequest: true } };
  continueRun.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

describe("Build pane card around publish (l2.3 + l2.4)", () => {
  it("before publish: the preview is ready and publishing runs a final check first", () => {
    sessionState = session();
    renderPane();
    expect(screen.getByTestId("build-publish-on-request").textContent).toBe(
      "Your preview is ready. Publishing runs a final check, then puts it live.",
    );
  });

  it("a fix pass after the final check failed says so in plain words, and never the raw smoke signal", () => {
    sessionState = session({
      publish: readBuildPublish({
        status: "publishing",
        started_at: "2026-10-05T05:48:00Z",
        fixing: true,
        reason: "The site's smoke check failed: journey \"open-times\" failed",
      }),
    });
    renderPane();
    const row = screen.getByTestId("build-publish-row");
    expect(row.getAttribute("role")).toBe("status");
    expect(row.textContent).toContain("Publishing stopped: the final check failed, we're fixing it. You can use the preview now.");
    expect(document.body.textContent).not.toContain("open-times");
    expect(document.body.textContent).not.toContain("Fixing a problem");
  });

  it("fixes ran out: the row says the final check stopped publishing, without claiming a fix is running, and points back to Publish", () => {
    sessionState = session({
      publish: readBuildPublish({ status: "failed", started_at: "2026-10-05T05:48:00Z", retryable: true, reason: BUILD_FIXES_EXHAUSTED }),
    });
    renderPane();
    const row = screen.getByTestId("build-publish-row");
    expect(row.textContent).toContain("Publishing stopped: the final check failed.");
    expect(row.textContent).not.toContain("we're fixing it");
    expect(row.textContent).not.toContain("Publishing didn't finish");
    expect(within(row).getByTestId("build-publish-reason").textContent).toBe(BUILD_FIXES_EXHAUSTED);
    expect(row.textContent).toContain("Press Publish to try again.");
    expect(screen.queryByRole("button", { name: "Retry publish" })).toBeNull();
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("once published, the card carries the live address, Open admin and the owner login hint", () => {
    sessionState = session({
      appReady: false,
      liveUrl: LIVE,
      adminUrl: ADMIN,
      adminSetupEmail: "owner@bakery.test",
      previewKind: "final",
      publish: readBuildPublish({ status: "live", url: LIVE }),
    });
    renderPane();
    const row = screen.getByTestId("build-publish-row");
    expect(row.textContent).toContain(`Live at ${LIVE}`);
    expect(within(row).getByTestId("build-open-admin").getAttribute("href")).toBe(`${ADMIN}?from=zavi`);
    const login = within(row).getByTestId("build-admin-login");
    expect(login.textContent).toContain(`Log in to your admin at ${ADMIN}?from=zavi.`);
    expect(login.textContent).toContain("We emailed a one-click login link to owner@bakery.test.");
    expect(document.body.textContent).not.toContain("final check failed");
  });

  it("an admin address never shows on a row that is not live", () => {
    sessionState = session({
      adminUrl: ADMIN,
      publish: readBuildPublish({ status: "publishing", started_at: "2026-10-05T05:48:00Z" }),
    });
    renderPane();
    expect(within(screen.getByTestId("build-publish-row")).queryByTestId("build-open-admin")).toBeNull();
  });
});
