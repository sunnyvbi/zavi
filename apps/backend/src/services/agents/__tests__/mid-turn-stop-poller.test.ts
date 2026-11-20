
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function runSdkSpanLikeDispatcher(opts: {
  runId: string;
  isRunStopRequested: (runId: string) => Promise<boolean>;
  sdkAbortController: AbortController;
  killedRef: { value: boolean };
  setMidStreamAborted: () => void;
  consume: (signal: AbortSignal) => Promise<void>;
  pollerEnabled?: boolean;
}): Promise<void> {
  const {
    runId,
    isRunStopRequested,
    sdkAbortController,
    killedRef,
    setMidStreamAborted,
    consume,
    pollerEnabled = true,
  } = opts;

  let stopPollTimer: ReturnType<typeof setInterval> | undefined;

  if (pollerEnabled) {
    const STOP_POLL_MS = 1000;
    stopPollTimer = setInterval(() => {
      if (sdkAbortController.signal.aborted) return;
      void isRunStopRequested(runId)
        .then((stopped) => {
          if (!stopped || sdkAbortController.signal.aborted) return;
          killedRef.value = true;
          setMidStreamAborted();
          sdkAbortController.abort();
        })
        .catch(() => {
        });
    }, STOP_POLL_MS);
    stopPollTimer.unref?.();
  }

  try {
    await consume(sdkAbortController.signal);
  } finally {
    if (stopPollTimer) clearInterval(stopPollTimer);
  }
}

describe("mid-turn stop poller + interval cleanup", () => {
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    clearIntervalSpy = vi.spyOn(globalThis, "clearInterval") as ReturnType<
      typeof vi.spyOn
    >;
  });

  afterEach(() => {
    clearIntervalSpy.mockRestore();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("trips abort + sets killedRef/midStreamAborted when stop_requested flips true", async () => {
    const sdkAbortController = new AbortController();
    const killedRef = { value: false };
    let midStreamAborted = false;
    const isRunStopRequested = vi.fn().mockResolvedValue(true);

    const consume = (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve());
      });

    const run = runSdkSpanLikeDispatcher({
      runId: "run-1",
      isRunStopRequested,
      sdkAbortController,
      killedRef,
      setMidStreamAborted: () => {
        midStreamAborted = true;
      },
      consume,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await run;

    expect(isRunStopRequested).toHaveBeenCalledWith("run-1");
    expect(sdkAbortController.signal.aborted).toBe(true);
    expect(killedRef.value).toBe(true);
    expect(midStreamAborted).toBe(true);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT abort or mutate flags when stop_requested stays false", async () => {
    const sdkAbortController = new AbortController();
    const killedRef = { value: false };
    let midStreamAborted = false;
    const isRunStopRequested = vi.fn().mockResolvedValue(false);

    const consume = async () => {
      await Promise.resolve();
    };

    const run = runSdkSpanLikeDispatcher({
      runId: "run-2",
      isRunStopRequested,
      sdkAbortController,
      killedRef,
      setMidStreamAborted: () => {
        midStreamAborted = true;
      },
      consume,
    });

    await vi.advanceTimersByTimeAsync(2500);
    await run;

    expect(sdkAbortController.signal.aborted).toBe(false);
    expect(killedRef.value).toBe(false);
    expect(midStreamAborted).toBe(false);
  });

  it("clears the interval on NORMAL completion (exit path a)", async () => {
    const sdkAbortController = new AbortController();
    const isRunStopRequested = vi.fn().mockResolvedValue(false);

    const consume = async () => {
      await Promise.resolve();
    };

    await runSdkSpanLikeDispatcher({
      runId: "run-a",
      isRunStopRequested,
      sdkAbortController,
      killedRef: { value: false },
      setMidStreamAborted: () => {},
      consume,
    });

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    const callsAfter = isRunStopRequested.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(isRunStopRequested.mock.calls.length).toBe(callsAfter);
  });

  it("clears the interval on USER-STOP abort throw (exit path b)", async () => {
    const sdkAbortController = new AbortController();
    const isRunStopRequested = vi.fn().mockResolvedValue(false);

    const consume = async () => {
      throw new Error("run_cancelled");
    };

    await expect(
      runSdkSpanLikeDispatcher({
        runId: "run-b",
        isRunStopRequested,
        sdkAbortController,
        killedRef: { value: false },
        setMidStreamAborted: () => {},
        consume,
      }),
    ).rejects.toThrow("run_cancelled");

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the interval on a THROWN SDK error (exit path c)", async () => {
    const sdkAbortController = new AbortController();
    const isRunStopRequested = vi.fn().mockResolvedValue(false);

    const consume = async () => {
      throw new Error("Claude Code process aborted by user");
    };

    await expect(
      runSdkSpanLikeDispatcher({
        runId: "run-c",
        isRunStopRequested,
        sdkAbortController,
        killedRef: { value: false },
        setMidStreamAborted: () => {},
        consume,
      }),
    ).rejects.toThrow(/aborted by user/);

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT arm a poller when PRAXIS_STOP_POLLER_ENABLED disables it", async () => {
    const sdkAbortController = new AbortController();
    const isRunStopRequested = vi.fn().mockResolvedValue(true);

    const consume = async () => {
      await Promise.resolve();
    };

    await runSdkSpanLikeDispatcher({
      runId: "run-off",
      isRunStopRequested,
      sdkAbortController,
      killedRef: { value: false },
      setMidStreamAborted: () => {},
      consume,
      pollerEnabled: false,
    });

    expect(isRunStopRequested).not.toHaveBeenCalled();
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(sdkAbortController.signal.aborted).toBe(false);
  });
});
