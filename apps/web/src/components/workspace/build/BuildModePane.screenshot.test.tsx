// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body: unknown }>,
  uploads: [] as Array<{ resolve: (path: string) => void }>,
  uploadStatus: 200,
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: async (path: string, opts: { body?: unknown } = {}) => {
    if (path.startsWith("/api/chat/upload-image")) {
      const file = opts.body instanceof FormData ? opts.body.get("file") : null;
      net.calls.push({ path, body: file instanceof File ? file.name : null });
      const imagePath = await new Promise<string>((resolve) => net.uploads.push({ resolve }));
      const ok = net.uploadStatus === 200;
      return {
        ok,
        status: net.uploadStatus,
        json: async () => ({ image_path: imagePath }),
        text: async () => (ok ? "" : JSON.stringify({ error: { code: "invalid_image", message: "not an image" } })),
      };
    }
    net.calls.push({ path, body: typeof opts.body === "string" ? JSON.parse(opts.body) : undefined });
    return { ok: true, status: 200, json: async () => ({ conductor_run_id: "run-2" }), text: async () => "" };
  },
}));

let sessionState: Record<string, unknown> = {};

vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  NEW_SESSION_KEY: "new",
  startBuildSession: vi.fn(),
  undoBuildRefine: vi.fn(),
  useBuildSession: () => sessionState,
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({ currentSessionId: "run-1", sessions: [], loaded: true }),
  readBuildSessions: () => ({ currentSessionId: "run-1", sessions: [], loaded: true }),
  refreshBuildSessions: vi.fn(async () => {}),
  notifyBuildSessionsChanged: () => {},
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
import { startBuildRefine } from "@/lib/workspace/useBuildSession";

const SHOT_PATH = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg";

const sendRefine = vi.fn(async (message: string, opts?: { imagePaths?: ReadonlyArray<string> }) =>
  startBuildRefine("run-1", message, opts?.imagePaths?.length ? { imagePaths: opts.imagePaths } : {}),
);

function liveSite() {
  return {
    loaded: true,
    notFound: false,
    loadError: null,
    authExpired: false,
    run: {
      id: "run-1",
      objective: "Build product: A bakery site",
      status: "done",
      createdAt: "2026-09-29T07:00:00Z",
      updatedAt: "2026-09-29T07:40:00Z",
      stages: [
        { stage: "provision", status: "done", finished_at: "2026-09-29T07:01:00Z" },
        { stage: "build", status: "done", finished_at: "2026-09-29T07:12:30Z" },
      ],
      failure: null,
    },
    isCurrent: true,
    retired: false,
    previewUrl: "https://bakery.zaviagent.com",
    previewKind: "final",
    liveUrl: "https://bakery.zaviagent.com",
    repoUrl: null,
    refines: [],
    refinesLoaded: true,
    appReady: true,
    appReadyAt: "2026-09-29T07:13:00Z",
    publish: { status: "live", startedAt: null, url: "https://bakery.zaviagent.com" },
    sendRefine,
    refineSubmitting: false,
    cancelRun: vi.fn(async () => null),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
    retry: vi.fn(),
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

function screenshot(name = "screenshot.png", type = "image/png", size = 2048) {
  return new File([new Uint8Array(size)], name, { type });
}

function uploads() {
  return net.calls.filter((c) => c.path.startsWith("/api/chat/upload-image"));
}

function refineBodies() {
  return net.calls.filter((c) => c.path === "/api/workspace/autopilot/refine-product").map((c) => c.body);
}

beforeEach(() => {
  net.calls = [];
  net.uploads = [];
  net.uploadStatus = 200;
  sendRefine.mockClear();
  sessionState = liveSite();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Build chat: a screenshot sent with a change", () => {
  it("a pasted screenshot is uploaded and rides on the change request, and send waits for the upload", async () => {
    renderPane();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.paste(box, { clipboardData: { files: [screenshot()], items: [], types: ["Files"] } });
    fireEvent.change(box, { target: { value: "fix this" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(refineBodies()).toEqual([]);
    expect(uploads().map((c) => c.body)).toEqual(["screenshot.png"]);

    await act(async () => net.uploads[0]!.resolve(SHOT_PATH));
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() =>
      expect(refineBodies()).toEqual([{ message: "fix this", conductor_run_id: "run-1", image_paths: [SHOT_PATH] }]),
    );
    await waitFor(() => expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull());
  });

  it("a short 'fix' is enough with a screenshot, never without one", async () => {
    renderPane();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "fix" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(sendRefine).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("build-image-input"), { target: { files: [screenshot("hero.jpg", "image/jpeg")] } });
    await act(async () => net.uploads[0]!.resolve(SHOT_PATH));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(refineBodies()).toEqual([{ message: "fix", conductor_run_id: "run-1", image_paths: [SHOT_PATH] }]),
    );
  });

  it("a failed upload never sends a stale path, and the change goes as text", async () => {
    net.uploadStatus = 400;
    renderPane();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.paste(box, { clipboardData: { files: [screenshot()], items: [], types: ["Files"] } });
    await act(async () => net.uploads[0]!.resolve(SHOT_PATH));
    fireEvent.change(box, { target: { value: "make the footer darker" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(refineBodies()).toEqual([{ message: "make the footer darker", conductor_run_id: "run-1" }]),
    );
  });

  it("a non-image or oversized file is never uploaded", () => {
    renderPane();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.paste(box, {
      clipboardData: { files: [screenshot("huge.png", "image/png", 5 * 1024 * 1024 + 1), screenshot("anim.gif", "image/gif")], items: [] },
    });
    fireEvent.change(screen.getByTestId("build-image-input"), {
      target: { files: [new File(["%PDF"], "spec.pdf", { type: "application/pdf" })] },
    });
    expect(uploads()).toEqual([]);
  });

  it("pasting plain text is left to the textarea", () => {
    renderPane();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    const notCancelled = fireEvent.paste(box, { clipboardData: { files: [], items: [], getData: () => "hello" } });
    expect(notCancelled).toBe(true);
    expect(uploads()).toEqual([]);
  });
});
