// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

vi.mock("@/lib/workspace/builderClarifyFlag", () => ({
  isBuilderClarifyEnabled: () => false,
  isBuilderClarifyDynamicEnabled: () => false,
}));
import { BuildModePane, BuildTranscriptContent, buildActivityNote } from "./BuildModePane";
import { startBuildSession, undoBuildRefine } from "@/lib/workspace/useBuildSession";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { UNDO_PREVIEW_ONLY_CONFIRM } from "@/lib/workspace/buildFraming";
import { BUILD_CHECKS_FAILED, SITE_DATABASE_WAITING } from "@zavi/shared";

const DONE_STAGES = [
  { stage: "provision", status: "done", finished_at: "2026-09-29T07:01:00Z" },
  { stage: "spec", status: "done", finished_at: "2026-09-29T07:03:00Z" },
  { stage: "scaffold", status: "done", finished_at: "2026-09-29T07:06:00Z" },
  { stage: "build", status: "done", finished_at: "2026-09-29T07:12:30Z" },
];

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    objective: "Build product: A bakery site",
    status: "active",
    createdAt: "2026-09-29T07:00:00Z",
    updatedAt: "2026-09-29T07:40:00Z",
    stages: DONE_STAGES,
    failure: null,
    ...overrides,
  };
}

const sendRefine = vi.fn(async () => null);
const cancelRun = vi.fn(async () => null);
const continueRun = vi.fn(async (): Promise<{ code: string; message: string } | null> => null);

function session(overrides: Record<string, unknown> = {}) {
  return {
    loaded: true,
    notFound: false,
    loadError: null,
    authExpired: false,
    run: run(),
    isCurrent: true,
    retired: false,
    previewUrl: "https://3000-sbx.e2b.app",
    previewKind: "instant",
    liveUrl: null,
    repoUrl: null,
    refines: [],
    refinesLoaded: true,
    appReady: true,
    appReadyAt: "2026-09-29T07:13:00Z",
    publish: { status: "publishing", startedAt: "2026-09-29T07:12:40Z", url: "https://bakery.onrender.com" },
    sendRefine,
    refineSubmitting: false,
    cancelRun,
    stopping: false,
    continueRun,
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function renderPane(sessionId: string | null = "run-1") {
  return render(paneElement(sessionId));
}

function paneElement(sessionId: string | null = "run-1") {
  return (
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
    />
  );
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  vi.mocked(startBuildSession).mockReset();
  sendRefine.mockClear();
  cancelRun.mockClear();
  continueRun.mockReset();
  continueRun.mockResolvedValue(null);
  sessionsState = { currentSessionId: "run-1", sessions: [], loaded: true };
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Build pane while the app is ready and publishing", () => {
  it("cold open mid-publish reads as ready, keeps the publish step running, and offers no Stop", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T07:20:00Z"));
    sessionState = session();
    renderPane();

    expect(screen.getByText("Your app is ready")).toBeTruthy();
    expect(screen.queryByText("Building your app")).toBeNull();
    expect(screen.getByText("Built in 12m 30s")).toBeTruthy();
    expect(screen.queryByText(/^Working for/)).toBeNull();

    const row = screen.getByTestId("build-publish-row");
    expect(row.textContent).toContain("Publishing to your address… You can use the preview now.");
    expect(row.textContent).toContain("7m 20s");
    expect(row.querySelector(".animate-spin")).not.toBeNull();

    const step = screen.getByText("Publishing to your address");
    expect(step.className).toMatch(/font-semibold text-ca-xdark/);
    expect(step.parentElement?.querySelector(".animate-spin")).not.toBeNull();

    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop build" })).toBeNull();
    expect(screen.queryByText(/25 to 45 minutes/)).toBeNull();
  });

  it("a publish waiting for a site database tells the founder so, in plain words", () => {
    sessionState = session({
      publish: { status: "publishing", startedAt: "2026-09-29T07:12:40Z", url: null, retryable: false, waiting: true, reason: SITE_DATABASE_WAITING },
    });
    renderPane();
    const row = screen.getByTestId("build-publish-row");
    expect(row.textContent).toContain(`${SITE_DATABASE_WAITING} You can use the preview now.`);
    expect(row.textContent).not.toMatch(/shard|capacity/i);
  });

  it("measures Built in to the first ready observation when the stage has no finish time", () => {
    sessionState = session({
      run: run({ stages: DONE_STAGES.map(({ finished_at: _f, ...rest }) => rest) }),
      appReadyAt: "2026-09-29T07:09:05Z",
    });
    renderPane();
    expect(screen.getByText("Built in 9m 5s")).toBeTruthy();
  });

  it("blocks changes with a plain notice and never sends while publishing, even with a live address on file", () => {
    sessionState = session({ liveUrl: "https://bakery.onrender.com", previewKind: "final" });
    renderPane();

    const notice = screen.getByTestId("build-publish-blocks-changes").textContent ?? "";
    expect(notice).toBe("You can ask for changes once your app is published.");
    expect(notice).not.toMatch(/\d|minute|usually|soon/i);
    const box = screen.getByRole("textbox");
    expect((box as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Make the header green please" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const send = screen.queryByRole("button", { name: "Send update" });
    if (send) fireEvent.click(send);
    expect(sendRefine).not.toHaveBeenCalled();
    expect(screen.queryByText(/Editing/)).toBeNull();
  });

  it("shows Live at the address once publishing lands", () => {
    sessionState = session({
      run: run({ status: "done" }),
      appReady: false,
      liveUrl: "https://bakery.com",
      previewKind: "final",
      publish: { status: "live", startedAt: "2026-09-29T07:12:40Z", url: "https://bakery.com" },
    });
    renderPane();
    const row = screen.getByTestId("build-publish-row");
    expect(row.textContent).toContain("Live at https://bakery.com");
    expect(within(row).getByRole("link").getAttribute("href")).toBe("https://bakery.com/");
    expect(screen.queryByTestId("build-publish-blocks-changes")).toBeNull();
    expect(screen.getByTestId("build-card-badge").textContent).toBe("Ready");
  });
});

describe("Build pane when publishing fails", () => {
  const failedPublish = (overrides: Record<string, unknown> = {}) =>
    session({
      run: run({ status: "paused", failure: { class: "deploy_failed", message: "Render deploy failed" } }),
      publish: { status: "failed", startedAt: "2026-09-29T07:12:40Z", url: "https://bakery.onrender.com", retryable: true },
      ...overrides,
    });

  it("offers Retry publish instead of the paused or failed build actions", () => {
    sessionState = failedPublish();
    renderPane();
    expect(screen.getByText("Your app is ready")).toBeTruthy();
    expect(screen.getByText("Publishing didn't finish")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry publish" })).toBeTruthy();
    expect(screen.queryByText("Build paused")).toBeNull();
    expect(screen.queryByText("Build stopped")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue build" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Try again with the same idea/ })).toBeNull();
    expect(screen.queryByText("Render deploy failed")).toBeNull();
    expect(screen.getByTestId("build-card-badge").textContent).toBe("Publish stopped");
    expect(screen.getByTestId("build-card-badge").querySelector(".bg-ca-danger")).not.toBeNull();
  });

  it("a publish Continue would refuse shows no Retry and points to a new build", () => {
    sessionState = failedPublish({
      run: run({ status: "failed", failure: { class: "acceptance_failed", message: "acceptance" } }),
      publish: { status: "failed", startedAt: "2026-09-29T07:12:40Z", url: null, retryable: false },
    });
    renderPane();
    expect(screen.getByText("Publishing didn't finish")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry publish" })).toBeNull();
    expect(screen.getByText(/Start a new build below to try again/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Start a new build/ })).toBeTruthy();
    expect(screen.queryByText("Build stopped")).toBeNull();
  });

  it.each([
    ["not retryable", false],
    ["retryable", true],
  ])("after a failed publish (%s) the composer starts a new build and never says to wait for publishing", async (_name, retryable) => {
    vi.mocked(startBuildSession).mockResolvedValue({ id: "run-2" });
    sessionState = failedPublish({
      liveUrl: "https://bakery.onrender.com",
      previewKind: "final",
      publish: { status: "failed", startedAt: null, url: null, retryable },
    });
    renderPane();
    expect(screen.queryByTestId("build-publish-blocks-changes")).toBeNull();
    expect(screen.queryByText(/once your app is published/)).toBeNull();
    expect(!!screen.queryByRole("button", { name: "Retry publish" })).toBe(retryable);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(box.placeholder).toBe("Describe what to build next…");
    fireEvent.change(box, { target: { value: "A bakery site with online ordering" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(startBuildSession).toHaveBeenCalledTimes(1));
    expect(sendRefine).not.toHaveBeenCalled();
  });

  it("Retry publish calls continueRun once and shows its error", async () => {
    continueRun.mockResolvedValueOnce({ code: "continue_failed", message: "The publish could not restart (HTTP 409)." });
    sessionState = failedPublish();
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Retry publish" }));
    await waitFor(() => expect(continueRun).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("alert")).textContent).toBe("The publish could not restart (HTTP 409).");
  });

  it("drops a failed retry's error once the publish restarts, so the next failure shows a clean Retry", async () => {
    continueRun.mockResolvedValueOnce({ code: "continue_failed", message: "The publish could not restart (HTTP 409)." });
    sessionState = failedPublish();
    const view = renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Retry publish" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The publish could not restart (HTTP 409).");

    sessionState = session({ run: run({ status: "active" }) });
    view.rerender(paneElement());
    expect(screen.getByTestId("build-publish-row").textContent).toContain("Publishing to your address");

    sessionState = failedPublish();
    view.rerender(paneElement());
    expect(screen.getByRole("button", { name: "Retry publish" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(continueRun).toHaveBeenCalledTimes(1);
  });

  it("clears the old error as soon as a new retry starts", async () => {
    continueRun.mockResolvedValueOnce({ code: "continue_failed", message: "The publish could not restart (HTTP 409)." });
    sessionState = failedPublish();
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Retry publish" }));
    await screen.findByRole("alert");
    continueRun.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Retry publish" }));
    await waitFor(() => expect(continueRun).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables Retry publish with a spinner while the retry is in flight", () => {
    sessionState = failedPublish({ continuing: true });
    renderPane();
    const button = screen.getByRole("button", { name: "Retry publish" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    fireEvent.click(button);
    expect(continueRun).not.toHaveBeenCalled();
  });
});

describe("Recent builds list", () => {
  it("names the publishing and publish-failed sessions", async () => {
    sessionState = session({ run: null });
    sessionsState = {
      currentSessionId: "s1",
      loaded: true,
      sessions: [
        { id: "s1", title: "Bakery", request: "bakery", state: "publishing", run_status: "active", created_at: "2026-09-29T07:00:00Z", last_activity_at: "2026-09-29T07:00:00Z", refine_count: 0, is_current: true },
        { id: "s2", title: "Florist", request: "florist", state: "publish_failed", run_status: "paused", created_at: "2026-09-28T07:00:00Z", last_activity_at: "2026-09-28T07:00:00Z", refine_count: 0, is_current: false },
      ],
    };
    renderPane(null);
    const list = await screen.findByRole("region", { name: "Your builds" });
    const rows = within(list).getAllByRole("button");
    expect(rows[0].textContent).toContain("Publishing, current");
    expect(rows[0].closest("li")?.getAttribute("aria-current")).toBe("true");
    expect(rows[0].closest("li")?.querySelector(".animate-spin")).not.toBeNull();
    expect(rows[1].textContent).toContain("Publishing didn't finish");
    expect(rows[1].textContent).not.toContain("Building");
    expect(rows[1].closest("li")?.querySelector(".animate-spin")).toBeNull();
  });
});

describe("publish on request: the build ends at the preview and never promises publishing", () => {
  const SITE_STAGES = [
    { stage: "provision", status: "done", finished_at: "2026-09-29T07:01:00Z" },
    { stage: "build", status: "active" },
  ];
  const DONE_SITE_STAGES = [
    { stage: "provision", status: "done", finished_at: "2026-09-29T07:01:00Z" },
    { stage: "build", status: "done", finished_at: "2026-09-29T07:06:00Z" },
  ];
  const NONE = { status: "none", startedAt: null, url: null, retryable: false };
  const WITH_DEPLOY = [...SITE_STAGES, { stage: "deploy", status: "pending" }];
  const DONE_WITH_DEPLOY = [...DONE_SITE_STAGES, { stage: "deploy", status: "done", finished_at: "2026-09-29T07:09:00Z" }];
  const flagOn = () => {
    sessionsState = { currentSessionId: "run-1", sessions: [], loaded: true, uiFlags: { publishOnRequest: true } };
  };
  const building = () =>
    session({ run: run({ stages: SITE_STAGES }), appReady: false, appReadyAt: null, previewUrl: null, previewKind: "none", publish: NONE });
  const builtUnpublished = (publish: Record<string, unknown> = NONE) =>
    session({
      run: run({ status: "done", stages: DONE_SITE_STAGES }),
      appReady: true,
      appReadyAt: "2026-09-29T07:06:30Z",
      liveUrl: null,
      previewKind: "instant",
      publish,
    });

  it("while building, the card lists two steps, no publishing step, and its copy does not promise publishing", () => {
    flagOn();
    sessionState = building();
    renderPane();
    expect(screen.getByText("Building your app")).toBeTruthy();
    expect(screen.getByText("Setting up your workspace")).toBeTruthy();
    expect(screen.getByText("Building the interface")).toBeTruthy();
    expect(screen.queryByText("Publishing to your address")).toBeNull();
    expect(screen.getByText("Your app shows up in the preview when it's ready. You can leave this page and come back.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/continues in the background|Publishing to your address|few minutes/);
  });

  it("while building, the card's time left counts only setting up and building, and never a publishing step", () => {
    const T0 = Date.parse("2026-10-02T08:00:00Z");
    const MIN = 60_000;
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(T0 + 2 * MIN);
    const timed = (withDeploy: boolean) => [
      { stage: "provision", status: "done", started_at: new Date(T0 - MIN).toISOString(), expected_ms: MIN },
      { stage: "build", status: "running", started_at: new Date(T0).toISOString(), expected_ms: 10 * MIN },
      ...(withDeploy ? [{ stage: "deploy", status: "pending", expected_ms: 3 * MIN }] : []),
    ];
    flagOn();
    sessionState = session({ run: run({ stages: timed(false) }), appReady: false, appReadyAt: null, previewUrl: null, previewKind: "none", publish: NONE });
    const view = renderPane();
    expect(buildActivityNote("About 8 minutes left", true)).toBe(
      "About 8 minutes left. Your app shows up in the preview when it's ready. You can leave this page and come back.",
    );
    expect(screen.getByText(buildActivityNote("About 8 minutes left", true))).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/continues in the background|Publishing to your address|few minutes/);
    act(() => void vi.advanceTimersByTime(3 * MIN));
    expect(screen.getByText(buildActivityNote("About 5 minutes left", true))).toBeTruthy();
    view.unmount();

    sessionState = session({ run: run({ stages: timed(true) }), appReady: false, appReadyAt: null, previewUrl: null, previewKind: "none", publish: NONE });
    renderPane();
    expect(screen.getByText(buildActivityNote("About 8 minutes left"))).toBeTruthy();
    expect(buildActivityNote("About 8 minutes left")).toContain("Publishing to your address continues in the background");
    expect(buildActivityNote(null, true)).toBe("Your app shows up in the preview when it's ready. You can leave this page and come back.");
    expect(buildActivityNote(null)).toBe("Publishing to your address continues in the background. You can leave this page and come back.");
    for (const text of [buildActivityNote("About 8 minutes left", true), buildActivityNote(null, true)]) {
      expect(text).not.toMatch(/few minutes|live|continues in the background|Publishing/);
    }
  });

  it("setting off but the build's own graph has no publish stage: still two steps and no publishing promise", () => {
    sessionState = building();
    renderPane();
    expect(screen.getByText("Setting up your workspace")).toBeTruthy();
    expect(screen.getByText("Building the interface")).toBeTruthy();
    expect(screen.queryByText("Publishing to your address")).toBeNull();
    expect(document.body.textContent).not.toMatch(/continues in the background/);
  });

  it.each([
    ["off", false],
    ["on", true],
  ])("a build whose graph has a publish stage lists three steps and keeps today's copy with the setting %s", (_name, on) => {
    if (on) flagOn();
    sessionState = session({
      run: run({ stages: WITH_DEPLOY }),
      appReady: false,
      appReadyAt: null,
      previewUrl: null,
      previewKind: "none",
      publish: NONE,
    });
    renderPane();
    expect(screen.getByText("Setting up your workspace")).toBeTruthy();
    expect(screen.getByText("Building the interface")).toBeTruthy();
    expect(screen.getByText("Publishing to your address")).toBeTruthy();
    expect(document.body.textContent).toContain("Publishing to your address continues in the background. You can leave this page and come back.");
  });

  it("with the setting off and no stage known yet, the card keeps today's steps and copy", () => {
    sessionState = session({ run: run({ stages: [] }), appReady: false, appReadyAt: null, previewUrl: null, previewKind: "none", publish: NONE });
    renderPane();
    expect(screen.getByText("Publishing to your address")).toBeTruthy();
    expect(document.body.textContent).toContain("continues in the background");
  });

  it("a done, never-published build says its preview is ready and that publishing runs a final check first", () => {
    flagOn();
    sessionState = builtUnpublished();
    renderPane();
    expect(screen.getByText("Your app is ready")).toBeTruthy();
    expect(screen.getByTestId("build-publish-on-request").textContent).toBe(
      "Your preview is ready. Publishing runs a final check, then puts it live.",
    );
    expect(screen.queryByTestId("build-publish-row")).toBeNull();
    expect(screen.queryByText("Publishing to your address")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Live at|is live|Publishing to|Publishing stopped|Publishing didn/);
    expect(screen.queryByRole("button", { name: "Retry publish" })).toBeNull();
  });

  it("a done, never-published build whose preview stopped does not claim the preview has it", () => {
    flagOn();
    sessionState = { ...builtUnpublished(), previewState: "stopped" };
    renderPane();
    const note = screen.getByTestId("build-publish-on-request").textContent ?? "";
    expect(note).toBe(
      "Your app is built, but its preview stopped. Restart it from the preview, then press Publish to put it on its address.",
    );
    expect(note).not.toContain("ready in the preview");
  });

  it("while its preview restarts, the note goes back to the ready copy", () => {
    flagOn();
    sessionState = { ...builtUnpublished(), previewState: "starting" };
    renderPane();
    expect(screen.getByTestId("build-publish-on-request").textContent).toBe(
      "Your preview is ready. Publishing runs a final check, then puts it live.",
    );
  });

  it("setting off or missing: a done run with no publish stage still tells the user to press Publish", () => {
    sessionState = builtUnpublished();
    renderPane();
    expect(screen.getByTestId("build-publish-on-request").textContent).toBe(
      "Your preview is ready. Publishing runs a final check, then puts it live.",
    );
    expect(screen.queryByText("Publishing to your address")).toBeNull();
  });

  it.each([
    ["off", false],
    ["on", true],
  ])("a done run that has a publish stage never shows the Publish note with the setting %s", (_name, on) => {
    if (on) flagOn();
    sessionState = { ...builtUnpublished(), run: run({ status: "done", stages: DONE_WITH_DEPLOY }) };
    renderPane();
    expect(screen.queryByTestId("build-publish-on-request")).toBeNull();
    expect(document.body.textContent).not.toContain("Press Publish");
    expect(screen.getByText("Publishing to your address")).toBeTruthy();
  });

  it("an earlier build that was replaced never tells the user to press Publish", () => {
    flagOn();
    sessionState = { ...builtUnpublished(), isCurrent: false };
    renderPane();
    expect(screen.queryByTestId("build-publish-on-request")).toBeNull();
  });

  it("once Publish is pressed the card shows publishing, and a failure shows the reason and points back to Publish", () => {
    flagOn();
    sessionState = builtUnpublished({ status: "publishing", startedAt: "2026-09-29T07:30:00Z", url: null, retryable: false });
    const view = renderPane();
    expect(screen.getByTestId("build-publish-row").textContent).toContain("Publishing to your address… You can use the preview now.");
    expect(screen.queryByTestId("build-publish-on-request")).toBeNull();

    sessionState = builtUnpublished({
      status: "failed",
      startedAt: "2026-09-29T07:30:00Z",
      url: null,
      retryable: true,
      reason: "The site's smoke check failed: login",
    });
    view.rerender(paneElement());
    const row = screen.getByTestId("build-publish-row");
    expect(row.textContent).toContain("Publishing didn't finish");
    expect(row.textContent).toContain("The site's smoke check failed: login");
    expect(row.textContent).toContain("Press Publish to try again.");
    expect(row.textContent).not.toContain("Start a new build");
    expect(screen.queryByRole("button", { name: "Retry publish" })).toBeNull();
    expect(continueRun).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/Live at|is live/);
  });

  it("a finished, unpublished build (app ready on a done run) reads as built, not as still building or publishing", () => {
    flagOn();
    sessionState = builtUnpublished();
    renderPane();
    expect(screen.getByText("Your app is ready")).toBeTruthy();
    expect(screen.queryByText("Building your app")).toBeNull();
    expect(screen.getByText(/^Built in 6m/)).toBeTruthy();
    expect(screen.queryByText(/^Working for/)).toBeNull();
    expect(document.body.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.queryByTestId("build-publish-blocks-changes")).toBeNull();
  });

  it("while the pressed publish runs, changes wait with a plain notice and nothing is sent", () => {
    flagOn();
    sessionState = builtUnpublished({ status: "publishing", startedAt: "2026-09-29T07:30:00Z", url: null, retryable: false });
    renderPane();
    expect(screen.getByTestId("build-publish-blocks-changes").textContent).toBe(
      "You can ask for changes once your app is published.",
    );
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Make the header green please" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sendRefine).not.toHaveBeenCalled();
    expect(vi.mocked(startBuildSession)).not.toHaveBeenCalled();
  });

  it("a done run that has a publish stage does not lock the composer on the same publishing payload, as today", () => {
    flagOn();
    sessionState = {
      ...builtUnpublished({ status: "publishing", startedAt: "2026-09-29T07:30:00Z", url: null, retryable: false }),
      run: run({ status: "done", stages: DONE_WITH_DEPLOY }),
    };
    renderPane();
    expect(screen.queryByTestId("build-publish-blocks-changes")).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("the chat transcript's ready card says the same, decided by the build and not only the setting", () => {
    const transcript = (
      publishOnRequest: boolean,
      publish: Record<string, unknown> = NONE,
      stages: Array<Record<string, unknown>> = DONE_SITE_STAGES,
    ) =>
      render(
        <BuildTranscriptContent
          sessionId="run-1"
          session={{ ...builtUnpublished(publish), run: run({ status: "done", stages }) } as never}
          publishOnRequest={publishOnRequest}
        />,
      );
    const on = transcript(true);
    expect(screen.getByText("Your app is ready")).toBeTruthy();
    expect(screen.getByTestId("build-publish-on-request").textContent).toBe(
      "Your preview is ready. Publishing runs a final check, then puts it live.",
    );
    expect(screen.queryByText("Your site is live")).toBeNull();
    on.unmount();

    const failed = transcript(true, { status: "failed", startedAt: null, url: null, retryable: false, reason: "The site did not build" });
    expect(screen.getByTestId("build-publish-state").textContent).toBe(
      "Publishing to your address didn't finish. The site did not build Press Publish to try again.",
    );
    expect(screen.queryByTestId("build-publish-on-request")).toBeNull();
    failed.unmount();

    const off = transcript(false);
    expect(screen.getByTestId("build-publish-on-request")).toBeTruthy();
    off.unmount();

    const unknown = transcript(false, NONE, []);
    expect(screen.queryByTestId("build-publish-on-request")).toBeNull();
    unknown.unmount();

    transcript(true, NONE, DONE_WITH_DEPLOY);
    expect(screen.queryByTestId("build-publish-on-request")).toBeNull();
  });
});

describe("publish on request: Your builds marks a built site that was never published", () => {
  const rows = [
    { id: "s1", title: "Bakery", request: "bakery", state: "ready", run_status: "done", created_at: "2026-09-29T07:00:00Z", last_activity_at: "2026-09-29T07:00:00Z", refine_count: 0, is_current: true, site: { hostname: "bakery.zaviagent.com", live_url: null, status: "building" } },
    { id: "s2", title: "Florist", request: "florist", state: "ready", run_status: "done", created_at: "2026-09-28T07:00:00Z", last_activity_at: "2026-09-28T07:00:00Z", refine_count: 0, is_current: false, site: { hostname: "florist.zaviagent.com", live_url: "https://florist.zaviagent.com", status: "live" } },
  ];

  it("shows Not published beside its address, with no link to open it, and Live only for the published site", async () => {
    sessionState = session({ run: null });
    sessionsState = { currentSessionId: "s1", loaded: true, sessions: rows, uiFlags: { publishOnRequest: true } };
    renderPane(null);
    const list = await screen.findByRole("region", { name: "Your builds" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0].querySelector("[data-site-badge]")?.getAttribute("data-site-badge")).toBe("Not published");
    expect(items[0].textContent).toContain("bakery.zaviagent.com");
    expect(items[0].querySelector("a[href]")).toBeNull();
    expect(items[0].textContent).not.toContain("Live");
    expect(items[1].querySelector("[data-site-badge]")?.getAttribute("data-site-badge")).toBe("Live");
    expect(items[1].querySelector("a[href]")?.getAttribute("href")).toBe("https://florist.zaviagent.com");
  });

  it("setting off or missing: the built, never-published row still says Not published", async () => {
    sessionState = session({ run: null });
    sessionsState = { currentSessionId: "s1", loaded: true, sessions: rows };
    renderPane(null);
    const list = await screen.findByRole("region", { name: "Your builds" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0].querySelector("[data-site-badge]")?.getAttribute("data-site-badge")).toBe("Not published");
    expect(items[0].querySelector("a[href]")).toBeNull();
    expect(items[1].querySelector("[data-site-badge]")?.getAttribute("data-site-badge")).toBe("Live");
  });

  it("a site still building, or one whose build stopped, keeps today's badge", async () => {
    sessionState = session({ run: null });
    sessionsState = {
      currentSessionId: "s1",
      loaded: true,
      uiFlags: { publishOnRequest: true },
      sessions: [
        { ...rows[0], state: "building", run_status: "active" },
        { ...rows[0], id: "s3", state: "failed", run_status: "failed" },
      ],
    };
    renderPane(null);
    const list = await screen.findByRole("region", { name: "Your builds" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0].querySelector("[data-site-badge]")?.getAttribute("data-site-badge")).toBe("Building");
    expect(items[1].querySelector("[data-site-badge]")).toBeNull();
  });
});

describe("publish on request: undoing a change on a site that was never published", () => {
  const NONE = { status: "none", startedAt: null, url: null, retryable: false };
  const change = {
    id: "edit-1",
    message: "Make it better",
    status: "done",
    created_at: "2026-09-29T08:09:00.000Z",
    finished_at: "2026-09-29T08:10:00.000Z",
    summary: "Changed: Make it better",
    kind: "change",
    undoable: true,
  };
  const transcript = (publishOnRequest: boolean, overrides: Record<string, unknown> = {}) =>
    render(
      <BuildTranscriptContent
        sessionId="run-1"
        session={
          session({
            run: run({
              status: "done",
              stages: [
                { stage: "provision", status: "done" },
                { stage: "build", status: "done" },
              ],
            }),
            appReady: true,
            liveUrl: null,
            publish: NONE,
            refines: [change],
            ...overrides,
          }) as never
        }
        publishOnRequest={publishOnRequest}
      />,
    );
  const undo = () => screen.getByRole("button", { name: /Undo this change/ });

  beforeEach(() => {
    vi.mocked(confirmAction).mockReset();
    vi.mocked(undoBuildRefine).mockReset();
  });

  it("Undo is an icon beside Copy and More, named for assistive tech, with no label text", () => {
    transcript(true);
    const button = undo();
    expect(button.textContent?.trim()).toBe("");
    expect(button.getAttribute("aria-label")).toBe("Undo this change");
    expect(button.getAttribute("title")).toBe("Undo this change");
    expect(button.querySelector("svg")).toBeTruthy();
    expect(within(button.parentElement as HTMLElement).getByRole("button", { name: "Copy message" })).toBeTruthy();
  });

  it("the confirmation talks about the preview and never promises a live site update", async () => {
    vi.mocked(confirmAction).mockResolvedValue(false);
    transcript(true);
    fireEvent.click(undo());
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    const asked = vi.mocked(confirmAction).mock.calls[0]![0] as { description: string };
    expect(asked.description).toBe(UNDO_PREVIEW_ONLY_CONFIRM);
    expect(asked.description).not.toMatch(/live site/);
    expect(undoBuildRefine).not.toHaveBeenCalled();
  });

  it("under publish on request a live site's undo also waits for Publish; with the setting off it keeps today's words", async () => {
    vi.mocked(confirmAction).mockResolvedValue(false);
    const live = {
      appReady: false,
      liveUrl: "https://bakery.zaviagent.com",
      publish: { status: "live", startedAt: null, url: "https://bakery.zaviagent.com", retryable: false },
    };
    const on = transcript(true, live);
    fireEvent.click(undo());
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    expect((vi.mocked(confirmAction).mock.calls[0]![0] as { description: string }).description).toBe(UNDO_PREVIEW_ONLY_CONFIRM);
    on.unmount();

    transcript(false, {
      ...live,
      run: run({ status: "done", stages: [{ stage: "provision", status: "done" }, { stage: "build", status: "done" }, { stage: "deploy", status: "done" }] }),
    });
    fireEvent.click(undo());
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(2));
    expect((vi.mocked(confirmAction).mock.calls[1]![0] as { description: string }).description).toMatch(/the live site updates/);
  });

  it("a preview-only undo shows a plain line, not a red warning", async () => {
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(undoBuildRefine).mockResolvedValue({ error: null, notice: "The change was undone in your preview. Click Publish to put it live." });
    transcript(true);
    fireEvent.click(undo());
    const notice = await screen.findByTestId("refine-undo-notice");
    expect(notice.textContent).toBe("The change was undone in your preview. Click Publish to put it live.");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.className).not.toMatch(/text-danger/);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(undoBuildRefine).toHaveBeenCalledTimes(1);
  });

  it("an undo that did not reach the live site still shows as a warning", async () => {
    vi.mocked(confirmAction).mockResolvedValue(true);
    vi.mocked(undoBuildRefine).mockResolvedValue({
      error: null,
      notice: "The change was undone, but the live site didn't update. Publish your site again to put the undo live.",
    });
    transcript(false);
    fireEvent.click(undo());
    const notice = await screen.findByTestId("refine-undo-notice");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.className).toMatch(/text-danger/);
  });
});

describe("publish on request: the card and the Publish popover tell the same story", () => {
  const HOST = "bakery.zaviagent.com";
  const NOT_SERVING = BUILD_CHECKS_FAILED;
  const STAGES = [
    { stage: "provision", status: "done", finished_at: "2026-09-29T07:01:00Z" },
    { stage: "build", status: "done", finished_at: "2026-09-29T07:06:00Z" },
  ];

  async function both(publishRaw: Record<string, unknown>, site: { liveUrl: string | null; status: string }) {
    const { readBuildPublish } = await import("@/lib/workspace/buildPublish");
    const { PublishPopover } = await import("../website/PublishPopover");
    const publish = readBuildPublish(publishRaw);
    sessionsState = { currentSessionId: "run-1", sessions: [], loaded: true, uiFlags: { publishOnRequest: true } };
    sessionState = session({
      run: run({ status: "done", stages: STAGES }),
      appReady: publish.status !== "live",
      appReadyAt: "2026-09-29T07:06:30Z",
      liveUrl: site.liveUrl,
      previewKind: "instant",
      publish,
    });
    const card = render(<div data-testid="card">{paneElement()}</div>);
    const pop = render(
      <div data-testid="popover">
        <PublishPopover
          appUrl="https://3000-sbx.e2b.app"
          appHost="3000-sbx.e2b.app"
          publishable={false}
          ownBuildApp
          site={site}
          sitePublish={{ siteId: "site-1", hostname: HOST, built: true, status: publish.status, reason: publish.reason ?? null }}
          onGetDomain={() => {}}
          onClose={() => {}}
        />
      </div>,
    );
    await waitFor(() => expect(screen.queryByLabelText("Loading publish options")).toBeNull());
    return {
      card: card.getByTestId("card").textContent ?? "",
      popover: within(pop.getByTestId("popover")),
      popoverText: pop.getByTestId("popover").textContent ?? "",
    };
  }

  it("a first publish that activated and then failed its check: the card says the final check stopped it, the popover says it did not finish, both with the reason, and neither says Live", async () => {
    const { card, popover, popoverText } = await both(
      { status: "failed", started_at: "2026-10-02T05:00:00.000Z", url: null, retryable: false, reason: NOT_SERVING },
      { liveUrl: null, status: "building" },
    );
    expect(card).toContain("Publishing stopped: the final check failed.");
    expect(card).toContain(NOT_SERVING);
    expect(card).toContain("Press Publish to try again.");
    expect(popover.getByRole("heading", { name: "Publishing didn't finish" })).toBeTruthy();
    expect(popoverText).toContain(NOT_SERVING);
    expect((popover.getByRole("button", { name: "Try again" }) as HTMLButtonElement).disabled).toBe(false);
    for (const text of [card, popoverText]) {
      expect(text).not.toMatch(/Live at|is live|Not published/);
    }
    expect(screen.queryByRole("button", { name: "Retry publish" })).toBeNull();
  });

  it("a published site: the card says Live at its address and the popover says Live, never Not published", async () => {
    const url = `https://${HOST}`;
    const { card, popover, popoverText } = await both(
      { status: "live", started_at: null, url, retryable: false },
      { liveUrl: url, status: "live" },
    );
    expect(card).toMatch(/Live at|is live/);
    expect(popover.getByRole("heading", { name: "Live" })).toBeTruthy();
    expect(popoverText).not.toContain("Not published");
    expect(popover.queryByRole("button", { name: "Publish" })).toBeNull();
  });
});

describe("a built app whose publish is still waiting opens the build layout", () => {
  const NO_PREVIEW = { previewUrl: null, previewKind: "none", previewState: null };
  function mountWith(open: boolean) {
    const onOpenPreview = vi.fn();
    const onPreviewUnavailable = vi.fn();
    const onPreviewWanted = vi.fn();
    const element = (previewOpen: boolean) => (
      <BuildModePane
        sessionId="run-1"
        previewOpen={previewOpen}
        focusNonce={0}
        resetNonce={0}
        onOpenPreview={onOpenPreview}
        onPreviewUnavailable={onPreviewUnavailable}
        onPreviewWanted={onPreviewWanted}
        onPreviewProgress={vi.fn()}
        onOpenSession={vi.fn()}
        onNewBuild={vi.fn()}
      />
    );
    const view = render(element(open));
    return { onOpenPreview, onPreviewUnavailable, onPreviewWanted, rerender: (o: boolean) => view.rerender(element(o)) };
  }

  it("asks for the preview column while it publishes with its preview box asleep, and never promises a preview it lacks", () => {
    sessionState = session({ ...NO_PREVIEW, publish: { status: "publishing", startedAt: null, url: null, retryable: false } });
    const m = mountWith(true);
    expect(m.onPreviewWanted).toHaveBeenCalled();
    expect(m.onPreviewUnavailable).not.toHaveBeenCalled();
    expect(m.onOpenPreview).not.toHaveBeenCalled();
    const row = screen.getByTestId("build-publish-row");
    expect(row.textContent).toContain("Publishing to your address…");
    expect(row.textContent).not.toContain("You can use the preview now");
  });

  it("a waiting-for-database publish with no preview drops the preview promise too", () => {
    sessionState = session({
      ...NO_PREVIEW,
      publish: { status: "publishing", startedAt: null, url: null, retryable: false, waiting: true, reason: SITE_DATABASE_WAITING },
    });
    mountWith(false);
    const row = screen.getByTestId("build-publish-row");
    expect(row.textContent).toContain(SITE_DATABASE_WAITING);
    expect(row.textContent).not.toContain("You can use the preview now");
  });

  it("keeps the column when the preview box goes away mid-publish instead of folding back to the plain chat", () => {
    sessionState = session({ publish: { status: "publishing", startedAt: null, url: null, retryable: false } });
    const m = mountWith(false);
    expect(m.onOpenPreview).toHaveBeenCalledTimes(1);
    sessionState = session({ ...NO_PREVIEW, publish: { status: "publishing", startedAt: null, url: null, retryable: false } });
    m.rerender(true);
    expect(m.onPreviewWanted).toHaveBeenCalled();
    expect(m.onPreviewUnavailable).not.toHaveBeenCalled();
  });

  it("a publish that stopped still opens the layout, where the retry lives", () => {
    sessionState = session({
      ...NO_PREVIEW,
      run: run({ stages: [...DONE_STAGES, { stage: "deploy", status: "pending" }] }),
      publish: { status: "failed", startedAt: null, url: null, retryable: true },
    });
    const m = mountWith(true);
    expect(m.onPreviewWanted).toHaveBeenCalled();
    expect(m.onPreviewUnavailable).not.toHaveBeenCalled();
  });

  it("an older build superseded by a newer one never grabs the column", () => {
    sessionState = session({ ...NO_PREVIEW, isCurrent: false, publish: { status: "publishing", startedAt: null, url: null, retryable: false } });
    const m = mountWith(true);
    expect(m.onPreviewWanted).not.toHaveBeenCalled();
    expect(m.onOpenPreview).not.toHaveBeenCalled();
  });

  it("an app that is not built yet does not open an empty column", () => {
    sessionState = session({ ...NO_PREVIEW, appReady: false, appReadyAt: null, run: run({ status: "done" }), publish: { status: "none", startedAt: null, url: null, retryable: false } });
    const m = mountWith(true);
    expect(m.onPreviewWanted).not.toHaveBeenCalled();
  });
});
