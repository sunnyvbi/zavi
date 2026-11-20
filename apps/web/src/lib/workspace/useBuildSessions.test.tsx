// @vitest-environment jsdom

import { act } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  __resetBuildSessionsForTest,
  DEFAULT_SITE_FLAGS,
  DEFAULT_UI_FLAGS,
  NO_SITE_FLAGS,
  NO_UI_FLAGS,
  notifyBuildSessionsChanged,
  readBuildSessions,
  readUiFlags,
  refreshBuildSessions,
  useBuildSessions,
} from "./useBuildSessions";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
const sessionClearers = vi.hoisted(() => new Set<() => void>());
vi.mock("@/lib/workspace/sessionScopedCache", () => ({
  registerSessionScopedCache: (clear: () => void) => {
    sessionClearers.add(clear);
  },
}));

type State = "building" | "ready" | "failed" | "publishing" | "publish_failed";

const session = (state: State) => ({
  id: "build-1",
  title: "Recipe app",
  request: "Build a recipe app",
  state,
  run_status:
    state === "building" ? "active" : state === "ready" ? "done" : "failed",
  created_at: "2026-09-28T10:00:00Z",
  last_activity_at: "2026-09-28T10:00:00Z",
  refine_count: 0,
  is_current: true,
});

function ok(state: State) {
  return Promise.resolve({
    ok: true,
    json: async () => ({
      sessions: [session(state)],
      current_session_id: "build-1",
    }),
  });
}

function Probe() {
  const { sessions } = useBuildSessions();
  return <p>{sessions[0]?.state ?? "missing"}</p>;
}

beforeEach(() => {
  apiFetch.mockReset();
  __resetBuildSessionsForTest();
});
afterEach(cleanup);

it("polls a building Recent row through completion", async () => {
  vi.useFakeTimers();
  try {
    apiFetch
      .mockReturnValueOnce(ok("building"))
      .mockReturnValueOnce(ok("ready"));
    const view = render(<Probe />);
    await act(async () => {});
    expect(view.getByText("building")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(view.getByText("ready")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

it("forgets the previous account's builds on sign-out and refetches for the next one", async () => {
  apiFetch.mockReturnValueOnce(ok("ready"));
  const first = render(<Probe />);
  await act(async () => {});
  expect(first.getByText("ready")).toBeTruthy();
  expect(sessionClearers.size).toBe(1);
  first.unmount();

  await act(async () => {
    for (const clear of sessionClearers) clear();
  });

  apiFetch.mockReturnValueOnce(
    Promise.resolve({ ok: true, json: async () => ({ sessions: [], current_session_id: null }) }),
  );
  const second = render(<Probe />);
  expect(second.getByText("missing")).toBeTruthy();
  await act(async () => {});
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(second.getByText("missing")).toBeTruthy();
});

it("keeps polling a publishing row until it lands or fails, then stops", async () => {
  vi.useFakeTimers();
  try {
    apiFetch
      .mockReturnValueOnce(ok("publishing"))
      .mockReturnValueOnce(ok("publishing"))
      .mockReturnValueOnce(ok("publish_failed"));
    const view = render(<Probe />);
    await act(async () => {});
    expect(view.getByText("publishing")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(view.getByText("publish_failed")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(apiFetch).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

function sessionsResponse(sessions: ReturnType<typeof session>[]) {
  return Promise.resolve({
    ok: true,
    json: async () => ({ sessions, current_session_id: sessions[0]?.id ?? null }),
  });
}

const elsewhere = { ...session("building"), id: "build-2", title: "Bike rental" };

function CurrentProbe() {
  const { sessions } = useBuildSessions();
  return <p>{sessions.map((s) => `${s.id}:${s.state}`).join(",") || "missing"}</p>;
}

it("picks up a build started in another tab when this tab is shown again", async () => {
  vi.useFakeTimers();
  try {
    apiFetch
      .mockReturnValueOnce(sessionsResponse([session("failed")]))
      .mockReturnValueOnce(sessionsResponse([elsewhere, session("failed")]));
    const view = render(<CurrentProbe />);
    await act(async () => {});
    expect(view.getByText("build-1:failed")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(view.getByText("build-2:building,build-1:failed")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(apiFetch).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("shows the running build when a new build is refused because one is already running", async () => {
  const { startBuildSession } = await import("./useBuildSession");
  apiFetch.mockReturnValueOnce(sessionsResponse([session("failed")]));
  const view = render(<CurrentProbe />);
  await act(async () => {});
  expect(view.getByText("build-1:failed")).toBeTruthy();

  apiFetch
    .mockReturnValueOnce(
      Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({
          error: { code: "build_already_in_progress", message: "A build is already running." },
          run_id: "build-2",
          can_cancel: true,
        }),
      }),
    )
    .mockReturnValueOnce(sessionsResponse([elsewhere, session("failed")]));

  let result: Awaited<ReturnType<typeof startBuildSession>> | undefined;
  await act(async () => {
    result = await startBuildSession({ idea: "Laptop rental landing page", companyName: "Laptop Rentals" });
  });
  expect(result).toEqual({ error: "A build is already running. Stop it before starting another." });
  expect(apiFetch).toHaveBeenNthCalledWith(2, "/api/workspace/autopilot/build-product", expect.anything());
  expect(apiFetch).toHaveBeenNthCalledWith(3, "/api/workspace/autopilot/build-sessions");
  expect(view.getByText("build-2:building,build-1:failed")).toBeTruthy();
});

it("queues a trailing refresh when a change arrives during an in-flight request", async () => {
  let release!: (value: Awaited<ReturnType<typeof ok>>) => void;
  const first = new Promise<Awaited<ReturnType<typeof ok>>>((resolve) => { release = resolve; });
  apiFetch.mockReturnValueOnce(first).mockReturnValueOnce(ok("ready"));

  const pending = refreshBuildSessions();
  notifyBuildSessionsChanged();
  expect(apiFetch).toHaveBeenCalledTimes(1);
  release(await ok("building"));
  await pending;
  await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
});

it("many mounted consumers share one live poll: one request per 10s, kept until the last one unmounts", async () => {
  vi.useFakeTimers();
  try {
    apiFetch.mockImplementation(() => ok("building"));
    const views = [render(<Probe />)];
    await act(async () => {});
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      views.push(render(<Probe />));
      await act(async () => {});
    }
    const before = apiFetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(apiFetch.mock.calls.length - before).toBe(1);

    for (const v of views.slice(1)) v.unmount();
    const afterFour = apiFetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(apiFetch.mock.calls.length - afterFour).toBe(1);

    views[0].unmount();
    const afterAll = apiFetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(apiFetch.mock.calls.length).toBe(afterAll);
  } finally {
    vi.useRealTimers();
  }
});

it("reads publish on request from the sessions response: an explicit false turns it off, and a missing or odd value takes the setting's default (on)", async () => {
  expect(readUiFlags({ publish_on_request: true }).publishOnRequest).toBe(true);
  expect(readUiFlags({ publish_on_request: false }).publishOnRequest).toBe(false);
  expect(readUiFlags({ publish_on_request: "false" }).publishOnRequest).toBe(true);
  expect(readUiFlags({ publish_on_request: null }).publishOnRequest).toBe(true);
  expect(readUiFlags({ publish_waits_for_app: true }).publishOnRequest).toBe(true);
  expect(readUiFlags(undefined).publishOnRequest).toBe(true);

  expect(readBuildSessions().uiFlags.publishOnRequest).toBe(true);

  apiFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ sessions: [session("ready")], current_session_id: "build-1", ui_flags: { publish_on_request: false } }),
  });
  await refreshBuildSessions();
  expect(readBuildSessions().uiFlags.publishOnRequest).toBe(false);

  apiFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ sessions: [session("ready")], current_session_id: "build-1", ui_flags: { publish_on_request: true } }),
  });
  await refreshBuildSessions();
  expect(readBuildSessions().uiFlags.publishOnRequest).toBe(true);

  apiFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ sessions: [session("ready")], current_session_id: "build-1" }),
  });
  await refreshBuildSessions();
  expect(readBuildSessions().uiFlags.publishOnRequest).toBe(true);
});

it("a first read that fails assumes every build switch is at its default (on), and the server's real answer replaces that on the next read", async () => {
  expect(readBuildSessions().uiFlags).toEqual(NO_UI_FLAGS);
  expect(readBuildSessions().flags).toEqual(NO_SITE_FLAGS);

  apiFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await refreshBuildSessions();
  expect(readBuildSessions()).toMatchObject({ loaded: false, failed: true, uiFlags: DEFAULT_UI_FLAGS, flags: DEFAULT_SITE_FLAGS });
  expect(readBuildSessions().uiFlags.publishOnRequest).toBe(true);

  apiFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
  await refreshBuildSessions();
  expect(readBuildSessions()).toMatchObject({ loaded: false, failed: true, uiFlags: DEFAULT_UI_FLAGS, flags: DEFAULT_SITE_FLAGS });

  apiFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      sessions: [session("ready")],
      current_session_id: "build-1",
      flags: { site_names: false },
      ui_flags: { publish_on_request: false, publish_waits_for_app: false },
    }),
  });
  await refreshBuildSessions();
  expect(readBuildSessions()).toMatchObject({ loaded: true, failed: false });
  expect(readBuildSessions().uiFlags).toEqual({ ...DEFAULT_UI_FLAGS, publishOnRequest: false, publishWaitsForApp: false });
  expect(readBuildSessions().flags).toEqual({ ...DEFAULT_SITE_FLAGS, siteNames: false });

  apiFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  await refreshBuildSessions();
  expect(readBuildSessions().failed).toBe(true);
  expect(readBuildSessions().uiFlags).toEqual({ ...DEFAULT_UI_FLAGS, publishOnRequest: false, publishWaitsForApp: false });
  expect(readBuildSessions().flags).toEqual({ ...DEFAULT_SITE_FLAGS, siteNames: false });
});

it("before the first answer arrives Publish waits for the app, so a cold render mid-build never offers it", () => {
  expect(readBuildSessions().loaded).toBe(false);
  expect(readBuildSessions().uiFlags.publishWaitsForApp).toBe(true);
});

it("before the first answer arrives a build is framed as publish on request, the server default, so a new build never flashes the old auto-publish steps", () => {
  expect(readBuildSessions().loaded).toBe(false);
  expect(readBuildSessions().uiFlags.publishOnRequest).toBe(true);
  expect(NO_UI_FLAGS.publishOnRequest).toBe(DEFAULT_UI_FLAGS.publishOnRequest);
});
