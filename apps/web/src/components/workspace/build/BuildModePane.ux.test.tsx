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
vi.mock("@/lib/workspace/buildFraming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/buildFraming")>()),
  useSiteListFirst: () => false,
}));

import { BuildModePane, buildActivityNote, BuildTranscriptContent } from "./BuildModePane";
import { buildEstimateText } from "@/lib/workspace/buildEstimate";
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

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    objective: "Build product: A bakery site",
    status: "active",
    createdAt: "2026-09-25T07:00:00Z",
    updatedAt: "2026-09-25T07:10:00Z",
    stages: [
      { stage: "provision", status: "done" },
      { stage: "spec", status: "running" },
    ],
    failure: null,
    ...overrides,
  };
}

function renderPane(sessionId: string | null, props: Partial<Record<string, unknown>> = {}) {
  const onOpenSession = vi.fn();
  const onNewBuild = vi.fn();
  render(
    <BuildModePane
      sessionId={sessionId}
      previewOpen={false}
      focusNonce={0}
      resetNonce={0}
      onOpenPreview={vi.fn()}
      onPreviewUnavailable={vi.fn()}
      onPreviewProgress={vi.fn()}
      onOpenSession={onOpenSession}
      onNewBuild={onNewBuild}
      {...props}
    />,
  );
  return { onOpenSession, onNewBuild };
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  vi.mocked(startBuildSession).mockReset();
  confirmAction.mockReset();
  cancelRun.mockClear();
  sessionState = baseSession();
  sessionsState = { currentSessionId: null, sessions: [], loaded: true };
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
  vi.stubGlobal("confirm", () => {
    throw new Error("window.confirm must not be used");
  });
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  vi.unstubAllGlobals();
});

describe("Stop build confirmation", () => {
  it("goes through the in-app dialog and only cancels on a yes", async () => {
    sessionState = baseSession({ run: run() });
    confirmAction.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderPane("run-1");

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    expect(cancelRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(cancelRun).toHaveBeenCalledTimes(1));
    expect(confirmAction.mock.calls[1][0]).toMatchObject({ tone: "danger", confirmLabel: "Stop build" });
  });
});

describe("Build activity copy", () => {
  it("B18: the chat's build card shows the same budget-based time left as the preview loader and the Home panel, and counts it down", () => {
    const T0 = Date.parse("2026-10-01T08:00:00Z");
    const MIN = 60_000;
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(T0 + 3 * MIN);
    try {
      const stages = [
        { stage: "provision", status: "done", started_at: new Date(T0 - 6 * MIN).toISOString(), expected_ms: 2 * MIN },
        { stage: "spec", status: "done", started_at: new Date(T0 - 4 * MIN).toISOString(), expected_ms: 4 * MIN },
        { stage: "scaffold", status: "running", started_at: new Date(T0).toISOString(), expected_ms: 25 * MIN },
        { stage: "build", status: "pending", expected_ms: 20 * MIN },
      ];
      sessionState = baseSession({ run: run({ stages }) });
      renderPane("run-1");
      expect(buildEstimateText(stages, Date.now())).toBe("About 42 minutes left");
      expect(screen.getByText(buildActivityNote("About 42 minutes left"))).toBeTruthy();
      act(() => void vi.advanceTimersByTime(10 * MIN));
      expect(screen.getByText(buildActivityNote("About 32 minutes left"))).toBeTruthy();
      expect(screen.queryByText(/few minutes/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets a duration expectation only while the build runs", () => {
    sessionState = baseSession({ run: run() });
    renderPane("run-1");
    expect(screen.getByText(/Publishing to your address continues in the background\. You can leave this page and come back\./)).toBeTruthy();
    expect(screen.queryByText(/few minutes/)).toBeNull();
    expect(screen.queryByText(/25 to 45 minutes/)).toBeNull();
    expect(screen.queryByText("Adding components")).toBeNull();
    expect(screen.queryByText("Applying styles")).toBeNull();
    expect(screen.getByText(/^Working for/)).toBeTruthy();
  });

  it.each([
    ["an instant sandbox preview", { previewKind: "instant", previewUrl: "https://sandbox.example" }, run()],
    ["an early preview", { previewKind: "early", previewUrl: "https://x.onrender.com" }, run()],
    ["no preview yet", { previewKind: "none" }, run()],
    ["a stopped build", { previewKind: "instant", previewUrl: "https://sandbox.example" }, run({ status: "failed" })],
  ])("shows no live preview badge in the build card for %s", (_name, overrides, activeRun) => {
    sessionState = baseSession({ run: activeRun, ...overrides });
    renderPane("run-1");
    expect(screen.queryByTestId("build-live-preview-badge")).toBeNull();
    expect(screen.queryByText(/Live preview/)).toBeNull();
    expect(screen.getByText("Publishing to your address")).toBeTruthy();
  });

  it("reads a stopped build as a run that ended, not one that has been stopped for an hour", () => {
    sessionState = baseSession({
      run: run({ status: "failed", createdAt: "2026-09-25T07:00:00Z", updatedAt: "2026-09-25T07:53:31Z" }),
    });
    renderPane("run-1");
    expect(screen.getByText("Ran 53m 31s before failing")).toBeTruthy();
    expect(screen.queryByText(/Stopped for/)).toBeNull();
    expect(screen.queryByText(/Publishing usually takes 25 to 45 minutes/)).toBeNull();
  });

  it("marks a replaced build in the activity header and hides the failed actions", () => {
    sessionState = baseSession({
      isCurrent: false,
      run: run({ status: "failed" }),
    });
    sessionsState = { currentSessionId: "run-9", sessions: [], loaded: true };
    renderPane("run-1");
    expect(screen.getByText("Replaced")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Try again with the same idea/ })).toBeNull();
  });
});

describe("Failed build actions", () => {
  it("puts a Retry circle in the Send slot beside the mic that resumes the same run once", async () => {
    let resolve!: (v: null) => void;
    const continueRun = vi.fn(() => new Promise<null>((r) => { resolve = r; }));
    sessionState = baseSession({ run: run({ status: "failed" }), continueRun });
    const { onNewBuild } = renderPane("run-1");

    const retry = screen.getByRole("button", { name: "Retry build" });
    expect(retry.querySelector(".lucide-rotate-cw")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Build app$|^Send update$/ })).toBeNull();

    fireEvent.click(retry);
    await waitFor(() => expect(continueRun).toHaveBeenCalledTimes(1));
    expect(startBuildSession).not.toHaveBeenCalled();
    expect(onNewBuild).not.toHaveBeenCalled();
    resolve(null);
  });

  it("hands the slot back to Send once the founder types", () => {
    sessionState = baseSession({ run: run({ status: "failed" }) });
    renderPane("run-1");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A cake site with an order form" } });
    expect(screen.queryByRole("button", { name: "Retry build" })).toBeNull();
  });

  const setupFailed = () =>
    run({ status: "failed", failure: { class: "stage_failed", stage: "provision", message: "Couldn't set up your site's hosting" } });
  const notResumable = () =>
    vi.fn(async () => ({ code: "not_resumable", message: "This build can't be retried from where it stopped. Start a new build." }));

  it("starts a fresh build straight away when setup failed and nothing was built, the Cake Studio case", async () => {
    vi.mocked(startBuildSession).mockResolvedValue({ id: "run-2" } as never);
    sessionState = baseSession({ run: setupFailed(), continueRun: notResumable() });
    renderPane("run-1");
    fireEvent.click(screen.getByRole("button", { name: "Retry build" }));
    await waitFor(() => expect(startBuildSession).toHaveBeenCalledTimes(1));
    expect(vi.mocked(startBuildSession).mock.calls[0][0]).toMatchObject({ idea: "A bakery site" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText(/can't be retried/)).toBeNull();
  });

  it("starts one build however fast the circle and the card button are pressed", async () => {
    let finish!: (v: { id: string }) => void;
    vi.mocked(startBuildSession).mockReturnValue(new Promise((r) => { finish = r; }) as never);
    sessionState = baseSession({ run: setupFailed(), continueRun: notResumable() });
    renderPane("run-1");
    fireEvent.click(screen.getByRole("button", { name: "Retry build" }));
    await waitFor(() => expect(startBuildSession).toHaveBeenCalledTimes(1));
    const circle = screen.getByRole("button", { name: "Retry build" }) as HTMLButtonElement;
    expect(circle.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(circle);
    fireEvent.click(screen.getByRole("button", { name: /Trying again/ }));
    await Promise.resolve();
    expect(startBuildSession).toHaveBeenCalledTimes(1);
    finish({ id: "run-2" });
  });

  it("after a fresh start is refused, shows why and a second press only prefills: no pile of failed builds", async () => {
    vi.mocked(startBuildSession).mockResolvedValue({ error: "Couldn't set up your site's hosting, so this build couldn't start." } as never);
    sessionState = baseSession({ run: setupFailed(), continueRun: notResumable() });
    renderPane("run-1");
    fireEvent.click(screen.getByRole("button", { name: "Retry build" }));
    expect(await screen.findByText(/Couldn't set up your site's hosting/)).toBeTruthy();
    expect(startBuildSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry build" }));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("A bakery site"));
    expect(startBuildSession).toHaveBeenCalledTimes(1);
  });

  it("never auto-starts over an app an earlier build finished: a new build would replace it", async () => {
    sessionState = baseSession({ run: setupFailed(), continueRun: notResumable() });
    sessionsState = {
      currentSessionId: "run-1",
      sessions: [{ id: "run-0", state: "ready", run_status: "done", created_at: "2026-09-20T07:00:00Z" }],
      loaded: true,
    };
    renderPane("run-1");
    fireEvent.click(screen.getByRole("button", { name: "Retry build" }));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("A bakery site"));
    expect(startBuildSession).not.toHaveBeenCalled();
  });

  it("never auto-starts while the build list is still loading: an earlier finished app may be in it", async () => {
    vi.mocked(startBuildSession).mockResolvedValue({ id: "run-2" } as never);
    const continueRun = notResumable();
    sessionState = baseSession({ run: setupFailed(), continueRun });
    sessionsState = { currentSessionId: null, sessions: [], loaded: false };
    renderPane("run-1");
    fireEvent.click(screen.getByRole("button", { name: "Retry build" }));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("A bakery site"));
    await waitFor(() => expect(continueRun).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(startBuildSession).not.toHaveBeenCalled();
  });

  it("never auto-starts from an idea the server stored cut off at its length cap", async () => {
    const long = `Build product: ${"x".repeat(485)}`;
    sessionState = baseSession({ run: { ...setupFailed(), objective: long }, continueRun: notResumable() });
    renderPane("run-1");
    fireEvent.click(screen.getByRole("button", { name: "Retry build" }));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(box.value.length).toBeGreaterThan(400));
    expect(startBuildSession).not.toHaveBeenCalled();
  });

  it.each([
    ["a running build", baseSession({ run: run() })],
    ["a replaced build", baseSession({ isCurrent: false, run: run({ status: "failed" }) })],
    ["a paused build", baseSession({ run: run({ status: "paused" }) })],
  ])("shows no Retry circle for %s", (_label, state) => {
    sessionState = state;
    renderPane("run-1");
    expect(screen.queryByRole("button", { name: "Retry build" })).toBeNull();
  });

  it.each([
    ["ready", baseSession({ appReady: true, run: run({ status: "done" }) })],
    ["stopped", baseSession({ run: run({ status: "failed", failure: { class: "user_cancelled", message: null, stage: null } }) })],
    ["failed", baseSession({ run: run({ status: "failed" }) })],
    ["paused", baseSession({ run: run({ status: "paused" }) })],
  ])("a %s build carries the same thumbs up and down", (_label, state) => {
    sessionState = state;
    renderPane("run-1");
    expect(screen.getByRole("button", { name: "Good build" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bad build" })).toBeTruthy();
  });

  it("a finished site with no photos says so and Retry runs the photo retry (free, then paid)", async () => {
    const sendRefine = vi.fn(async () => null);
    sessionState = baseSession({ appReady: true, run: run({ status: "done" }), sendRefine, photos: { reason: "Photos couldn't be added to your site.", retry: "free" } });
    renderPane("run-1");
    expect(screen.getByTestId("build-photos-missing").textContent).toContain("Photos couldn't be added to your site.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sendRefine).toHaveBeenCalledWith("Add photos to the site", { photoRetry: true }));
    cleanup();
    sessionState = baseSession({ appReady: true, run: run({ status: "done" }), sendRefine, photos: { reason: "Photos couldn't be added to your site.", retry: "paid" } });
    renderPane("run-1");
    expect(screen.getByRole("button", { name: "Retry (uses credits)" })).toBeTruthy();
  });

  it("the build chat transcript (what founders see) carries the photos line and Retry too", async () => {
    const sendRefine = vi.fn(async () => null);
    const session = baseSession({ appReady: true, run: run({ status: "done" }), sendRefine, photos: { reason: "Photos couldn't be added to your site.", retry: "free" } });
    render(<BuildTranscriptContent sessionId="run-1" session={session as never} />);
    expect(screen.getByTestId("build-photos-missing").textContent).toContain("Photos couldn't be added to your site.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(sendRefine).toHaveBeenCalledWith("Add photos to the site", { photoRetry: true }));
  });

  it("a paid photo Retry the wallet cannot cover says why, in the transcript", async () => {
    const sendRefine = vi.fn(async () => ({ headline: "Not enough credits.", detail: "Top up to make this change.", subline: null }));
    const session = baseSession({ appReady: true, run: run({ status: "done" }), sendRefine, photos: { reason: "Photos couldn't be added to your site.", retry: "paid" } });
    render(<BuildTranscriptContent sessionId="run-1" session={session as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry (uses credits)" }));
    await waitFor(() => expect(screen.getByTestId("build-photos-retry-error").textContent).toBe("Not enough credits. Top up to make this change."));
  });

  it("Retry is off, and says why, while another change is being sent or is running", async () => {
    const { BUILD_REFINE_SUBMITTING_EVENT } = await import("@/lib/workspace/useBuildSession");
    const photos = { reason: "Photos couldn't be added to your site.", retry: "free" as const };
    render(<BuildTranscriptContent sessionId="run-1" session={baseSession({ appReady: true, run: run({ status: "done" }), photos }) as never} />);
    const retry = () => screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
    expect(retry().disabled).toBe(false);
    expect(screen.queryByTestId("build-photos-retry-wait")).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent(BUILD_REFINE_SUBMITTING_EVENT, { detail: { sessionId: "run-1", submitting: true } }));
    });
    expect(retry().disabled).toBe(true);
    expect(screen.getByTestId("build-photos-retry-wait").textContent).toBe("Wait for your current change to finish.");
    act(() => {
      window.dispatchEvent(new CustomEvent(BUILD_REFINE_SUBMITTING_EVENT, { detail: { sessionId: "other", submitting: false } }));
    });
    expect(retry().disabled).toBe(true);
    act(() => {
      window.dispatchEvent(new CustomEvent(BUILD_REFINE_SUBMITTING_EVENT, { detail: { sessionId: "run-1", submitting: false } }));
    });
    expect(retry().disabled).toBe(false);
    const { BUILD_REFINE_STARTED_EVENT } = await import("@/lib/workspace/useBuildSession");
    act(() => {
      window.dispatchEvent(new CustomEvent(BUILD_REFINE_STARTED_EVENT, { detail: { sessionId: "run-1" } }));
    });
    expect(retry().disabled).toBe(true);
    cleanup();
    render(
      <BuildTranscriptContent
        sessionId="run-1"
        session={baseSession({ appReady: true, run: run({ status: "done" }), photos, refines: [{ id: "r1", message: "x", status: "active", created_at: "2026-10-09T00:00:00Z" }] }) as never}
      />,
    );
    expect(retry().disabled).toBe(true);
    expect(screen.getByTestId("build-photos-retry-wait")).toBeTruthy();
  });

  it("Try again resumes the same run in this session instead of starting a new build", async () => {
    const continueRun = vi.fn(async () => null);
    sessionState = baseSession({ run: run({ status: "failed" }), continueRun });
    const { onNewBuild, onOpenSession } = renderPane("run-1");

    fireEvent.click(screen.getByRole("button", { name: /Try again with the same idea/ }));

    await waitFor(() => expect(continueRun).toHaveBeenCalledTimes(1));
    expect(startBuildSession).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onNewBuild).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /Start a new build/ }));
    expect(onNewBuild).toHaveBeenCalledTimes(1);
  });

  it("when a newer build replaced this one, says why and starts nothing", async () => {
    const continueRun = vi.fn(async () => ({ code: "superseded", message: "A newer build replaced this one. Open your latest build instead." }));
    sessionState = baseSession({ run: run({ status: "failed" }), continueRun });
    const { onOpenSession } = renderPane("run-1");

    fireEvent.click(screen.getByRole("button", { name: /Try again with the same idea/ }));

    expect(await screen.findByText(/A newer build replaced this one/)).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(startBuildSession).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it.each([
    ["not_paused", "This build is not paused."],
    ["not_resumable", "This build can't be retried from where it stopped."],
    ["expired", "This build is too old to continue."],
    ["budget_spent", "This build already used its retries."],
    ["not_found", "Build not found."],
  ])("a %s refusal on a build that got past setup falls back to the idea in the composer and starts nothing", async (code, message) => {
    const continueRun = vi.fn(async () => ({ code, message }));
    sessionState = baseSession({ run: run({ status: "failed" }), continueRun });
    const { onOpenSession } = renderPane("run-1");

    fireEvent.click(screen.getByRole("button", { name: /Try again with the same idea/ }));

    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("A bakery site"));
    expect(continueRun).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(message)).toBeNull();
    expect(startBuildSession).not.toHaveBeenCalled();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it.each([
    ["superseded", "A newer build replaced this one. Open your latest build instead."],
    ["another_build_running", "Another build is running. Wait for it to finish."],
    ["changed_concurrently", "This build changed while you were retrying. Try again."],
    ["continue_failed", "database timeout"],
    ["network", "Failed to fetch"],
  ])("a %s error stays visible", async (code, message) => {
    const continueRun = vi.fn(async () => ({ code, message }));
    sessionState = baseSession({ run: run({ status: "failed" }), continueRun });
    renderPane("run-1");

    fireEvent.click(screen.getByRole("button", { name: /Try again with the same idea/ }));

    expect(await screen.findByText(message)).toBeTruthy();
  });

  it.each(["halted", "cancelled", "canceled"])(
    "a %s run prefills the idea for a new build without calling Continue, starting anything or showing an error",
    async (status) => {
      const continueRun = vi.fn(async () => ({ code: "not_paused", message: "This build is not paused." }));
      sessionState = baseSession({ run: run({ status }), continueRun });
      renderPane("run-1");

      fireEvent.click(screen.getByRole("button", { name: /Try again with the same idea/ }));

      const box = screen.getByRole("textbox") as HTMLTextAreaElement;
      await waitFor(() => expect(box.value).toBe("A bakery site"));
      expect(continueRun).not.toHaveBeenCalled();
      expect(screen.queryByText("This build is not paused.")).toBeNull();
      expect(startBuildSession).not.toHaveBeenCalled();
    },
  );

  it("locks Try again while the resume is in flight so a double click can't fire twice", () => {
    const continueRun = vi.fn(async () => null);
    sessionState = baseSession({ run: run({ status: "failed" }), continueRun, continuing: true });
    renderPane("run-1");

    const button = screen.getByRole("button", { name: /Trying again/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("does not offer a retry when the build ran out of credits", () => {
    sessionState = baseSession({
      run: run({ status: "failed", failure: { message: "insufficient_credits" } }),
    });
    renderPane("run-1");
    expect(screen.queryByRole("button", { name: /Try again with the same idea/ })).toBeNull();
  });
});

describe("Long prompts", () => {
  it("folds a long objective and expands it on demand", () => {
    const objective = "Build product: " + "HandyHub is a two-sided marketplace. ".repeat(12);
    sessionState = baseSession({ run: run({ objective }) });
    renderPane("run-1");
    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle.parentElement?.textContent).toContain("…");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    expect(screen.queryByText(/…/)).toBeNull();
  });
});

describe("Refine strip", () => {
  it("names the live app above the composer and offers a way out to a new build", () => {
    sessionState = baseSession({ run: run({ status: "done" }), liveUrl: "https://bakery.example.com" });
    const { onNewBuild } = renderPane("run-1");
    expect(screen.getByText(/Each change goes to your live app/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Build something else" }));
    expect(onNewBuild).toHaveBeenCalledTimes(1);
  });

  it("under publish on request it says each change waits in the preview for Publish, never that it goes live", () => {
    sessionsState = { currentSessionId: null, sessions: [], loaded: true, uiFlags: { publishOnRequest: true } };
    sessionState = baseSession({ run: run({ status: "done" }), liveUrl: "https://bakery.example.com" });
    renderPane("run-1");
    expect(screen.getByText(/Each change waits in your preview until you click Publish/)).toBeTruthy();
    expect(screen.queryByText(/Each change goes to your live app/)).toBeNull();
  });
});

describe("Recent builds on the empty state", () => {
  const rows = [
    { id: "b1", title: "Try again", request: "try again", state: "failed", run_status: "halted", created_at: "2026-09-22T13:42:36Z", last_activity_at: "2026-09-22T14:36:07Z", refine_count: 0, is_current: true },
    { id: "b2", title: "Launch-ready landing page", request: "", state: "ready", run_status: "done", created_at: "2026-09-22T10:06:11Z", last_activity_at: "2026-09-22T10:28:05Z", refine_count: 2, is_current: false },
    { id: "b3", title: "", request: "A customer portal", state: "building", run_status: "active", created_at: "2026-09-21T08:29:36Z", last_activity_at: "2026-09-21T08:29:56Z", refine_count: 0, is_current: false },
    { id: "b4", title: "Four", request: "", state: "failed", run_status: "failed", created_at: "2026-09-20T00:00:00Z", last_activity_at: "2026-09-20T00:00:00Z", refine_count: 0, is_current: false },
    { id: "b5", title: "Five", request: "", state: "failed", run_status: "failed", created_at: "2026-09-19T00:00:00Z", last_activity_at: "2026-09-19T00:00:00Z", refine_count: 0, is_current: false },
    { id: "b6", title: "Six", request: "", state: "failed", run_status: "failed", created_at: "2026-09-18T00:00:00Z", last_activity_at: "2026-09-18T00:00:00Z", refine_count: 0, is_current: false },
  ];

  it("lists past builds with state, opens one on click, and caps the list", async () => {
    sessionsState = { currentSessionId: "b1", sessions: rows, loaded: true };
    const { onOpenSession } = renderPane(null);
    const section = await screen.findByLabelText("Your builds");
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(within(section).getByText("6")).toBeTruthy();
    expect(within(items[0]).getByRole("button").textContent).toBe("Try again, Stopped, current");
    expect(items[0].getAttribute("aria-current")).toBe("true");
    expect(items[1].getAttribute("aria-current")).toBeNull();
    expect(within(items[1]).getByRole("button").textContent).toBe("Launch-ready landing page, Ready");
    for (const item of items) expect(item.textContent).not.toMatch(/·|\bchanges?\b/);
    expect(within(items[2]).getByText("A customer portal")).toBeTruthy();
    expect(within(items[2]).getByRole("button").textContent).toMatch(/Building/);

    fireEvent.click(within(items[1]).getByRole("button"));
    expect(onOpenSession).toHaveBeenCalledWith("b2");
  });

  it("renders nothing when the tenant has never built", () => {
    sessionsState = { currentSessionId: null, sessions: [], loaded: true };
    renderPane(null);
    expect(screen.queryByLabelText("Your builds")).toBeNull();
  });
});

describe("Build step icons", () => {
  const labels = [
    "Setting up your workspace",
    "Understanding your request",
    "Creating the app structure",
    "Building the interface",
  ];

  function iconSlotWidths() {
    return labels.map((label) => {
      const icon = screen.getByText(label).previousElementSibling as HTMLElement | null;
      return icon?.getAttribute("class")?.match(/\bw-\[?[\w.]+\]?/)?.[0] ?? null;
    });
  }

  it("gives done, failed and pending steps the same icon slot so the labels line up", () => {
    sessionState = baseSession({
      run: run({
        status: "failed",
        stages: [
          { stage: "provision", status: "done" },
          { stage: "spec", status: "done" },
          { stage: "scaffold", status: "failed" },
          { stage: "build", status: "pending" },
          { stage: "deploy", status: "pending" },
        ],
      }),
    });
    renderPane("run-1");
    expect(iconSlotWidths()).toEqual(Array(labels.length).fill("w-5"));
  });

  it("keeps the running step's spinner in the same slot", () => {
    sessionState = baseSession({
      run: run({
        stages: [
          { stage: "provision", status: "done" },
          { stage: "spec", status: "done" },
          { stage: "scaffold", status: "running" },
          { stage: "build", status: "pending" },
          { stage: "deploy", status: "pending" },
        ],
      }),
    });
    renderPane("run-1");
    expect(iconSlotWidths()).toEqual(Array(labels.length).fill("w-5"));
  });
});
