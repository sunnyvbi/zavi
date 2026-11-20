// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({
  clearOptimisticBuildStart: vi.fn(),
}));

import { BUILD_RUN_RESUMED_EVENT, FAST_POLL_MS, resetSharedBuildReads, useBuildPreview } from "./useBuildPreview";
import { settledChimeStatus, useBuildDoneChime, type ChimeKind } from "./buildChime";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

type Tick = { status: string; appReady: boolean; publish: string; url?: string };

function body(t: Tick) {
  return {
    run: { id: "run-1", status: t.status, stages: [{ stage: "build", status: "done" }] },
    preview:
      t.status === "done"
        ? { url: "https://bakery.com", kind: "final" }
        : { url: "https://3000-sbx.e2b.app", kind: "instant" },
    is_current: true,
    app_ready: t.appReady,
    publish: {
      status: t.publish,
      started_at: t.publish === "none" ? null : "2026-09-29T10:00:00Z",
      url: t.publish === "none" ? null : (t.url ?? "https://bakery.onrender.com"),
    },
  };
}

function script(ticks: Tick[]) {
  let i = 0;
  apiFetch.mockImplementation(async () => json(body(ticks[Math.min(i++, ticks.length - 1)])));
}

const statusCalls = () =>
  apiFetch.mock.calls.filter((c) => String(c[0]).includes("build-status")).length;

function Harness({ play }: { play: (kind: ChimeKind) => void }) {
  const build = useBuildPreview(true, 0, "run-1");
  useBuildDoneChime({
    active: true,
    settledNonce: build.settledNonce,
    runStatus: settledChimeStatus(build),
    refines: null,
    play,
  });
  return (
    <div>
      <span data-testid="publish">{build.publish.status}</span>
      <span data-testid="nonce">{build.settledNonce}</span>
    </div>
  );
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
  resetSharedBuildReads();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const building: Tick = { status: "active", appReady: false, publish: "none" };
const publishing: Tick = { status: "active", appReady: true, publish: "publishing" };
const live: Tick = { status: "done", appReady: false, publish: "live", url: "https://bakery.com" };

describe("useBuildPreview + chime across app-ready and publish", () => {
  it("chimes exactly once when the app turns ready and stays quiet when publishing goes live", async () => {
    script([building, building, publishing, publishing, publishing, publishing, publishing, live, live]);
    const play = vi.fn();
    render(<Harness play={play} />);
    await advance(0);
    expect(play).not.toHaveBeenCalled();

    await advance(FAST_POLL_MS);
    await advance(FAST_POLL_MS);
    expect(screen.getByTestId("publish").textContent).toBe("publishing");
    expect(play).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledWith("done");
    expect(screen.getByTestId("nonce").textContent).toBe("1");

    for (let i = 0; i < 6; i += 1) await advance(FAST_POLL_MS);
    expect(screen.getByTestId("publish").textContent).toBe("live");
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("nonce").textContent).toBe("1");
  });

  it("does not chime on a cold open during publishing, keeps polling through it, and stops once live", async () => {
    script([publishing, publishing, publishing, publishing, live, live, live]);
    const play = vi.fn();
    render(<Harness play={play} />);
    await advance(0);
    expect(screen.getByTestId("publish").textContent).toBe("publishing");

    for (let i = 0; i < 4; i += 1) await advance(FAST_POLL_MS);
    expect(statusCalls()).toBe(5);
    expect(screen.getByTestId("publish").textContent).toBe("live");

    await advance(FAST_POLL_MS * 10);
    expect(statusCalls()).toBe(5);
    expect(play).not.toHaveBeenCalled();
    expect(screen.getByTestId("nonce").textContent).toBe("0");
  });

  it("keeps polling a publish that the run already reports as terminal", async () => {
    const stalePublishing: Tick = { status: "paused", appReady: true, publish: "publishing" };
    script([stalePublishing, stalePublishing, stalePublishing, { ...stalePublishing, publish: "failed" }]);
    render(<Harness play={vi.fn()} />);
    await advance(0);
    for (let i = 0; i < 3; i += 1) await advance(3000);
    expect(statusCalls()).toBe(4);
    expect(screen.getByTestId("publish").textContent).toBe("failed");
    await advance(30_000);
    expect(statusCalls()).toBe(4);
  });

  it("restarts the stopped watch when a retry resumes the run elsewhere", async () => {
    const failed: Tick = { status: "paused", appReady: true, publish: "failed" };
    script([failed, publishing, publishing]);
    render(<Harness play={vi.fn()} />);
    await advance(0);
    await advance(30_000);
    expect(statusCalls()).toBe(1);
    expect(screen.getByTestId("publish").textContent).toBe("failed");

    await act(async () => {
      window.dispatchEvent(new CustomEvent(BUILD_RUN_RESUMED_EVENT, { detail: { runId: "other" } }));
    });
    await advance(0);
    expect(statusCalls()).toBe(1);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(BUILD_RUN_RESUMED_EVENT, { detail: { runId: "run-1" } }));
    });
    await advance(0);
    expect(screen.getByTestId("publish").textContent).toBe("publishing");
    await advance(FAST_POLL_MS);
    expect(statusCalls()).toBe(3);
  });

  it("a resume whose read fails retries until it gets an answer, instead of keeping the stale state (QA R6-3)", async () => {
    const failed: Tick = { status: "paused", appReady: true, publish: "failed" };
    let i = 0;
    apiFetch.mockImplementation(async () => {
      i += 1;
      if (i === 1) return json(body(failed));
      if (i === 2) return new Response("{}", { status: 503 });
      return json(body(live));
    });
    render(<Harness play={vi.fn()} />);
    await advance(0);
    await advance(30_000);
    expect(statusCalls()).toBe(1);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(BUILD_RUN_RESUMED_EVENT, { detail: { runId: "run-1" } }));
    });
    await advance(0);
    expect(statusCalls()).toBe(2);
    expect(screen.getByTestId("publish").textContent).toBe("failed");
    await advance(FAST_POLL_MS);
    expect(statusCalls()).toBe(3);
    expect(screen.getByTestId("publish").textContent).toBe("live");
    await advance(60_000);
    expect(statusCalls()).toBe(3);
  });
});
