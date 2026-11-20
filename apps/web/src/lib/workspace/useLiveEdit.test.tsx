// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import {
  LIVE_EDIT_FAST_POLL_MS,
  LIVE_EDIT_MAX_BACKOFF_MS,
  LIVE_EDIT_OFF,
  LIVE_EDIT_RESOLVE_WAIT_MS,
  LIVE_EDIT_SLOW_POLL_MS,
  LIVE_EDIT_START_TIMEOUT_MS,
  liveEditFrameUrl,
  useLiveEdit,
  type LiveEditState,
} from "./useLiveEdit";

const URL_ = "https://3000-sb1.e2b.app";

function state(over: Partial<LiveEditState> = {}, draft: Partial<LiveEditState["draft"]> = {}): LiveEditState {
  return {
    enabled: true,
    draft: { exists: true, ahead_by: 1, behind_by: 0, head_sha: "a".repeat(40), changes: [], ...draft },
    preview: { status: "live", url: URL_ },
    refine_active: false,
    ...over,
  };
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function fail(status: number) {
  return { ok: false, status, json: async () => ({ error: { code: "x" } }) } as Response;
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

function gets() {
  return statePolls().length;
}

function statePolls(): string[] {
  return apiFetch.mock.calls
    .filter(([u, init]) => /^\/api\/workspace\/autopilot\/live-edit(\?|$)/.test(String(u)) && !init)
    .map(([u]) => String(u));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
});
afterEach(() => {
  setHidden(false);
  cleanup();
  vi.useRealTimers();
});

describe("liveEditFrameUrl", () => {
  it("frames the sandbox only while there is something unpublished or a change is running", () => {
    expect(liveEditFrameUrl(state())).toBe(URL_);
    expect(liveEditFrameUrl(state({ refine_active: true }, { ahead_by: 0 }))).toBe(URL_);
    expect(liveEditFrameUrl(state({}, { ahead_by: 0 }))).toBeNull();
  });

  it("never frames a draft that fell behind main, because the sandbox tree may have been reset to main", () => {
    expect(liveEditFrameUrl(state({}, { behind_by: 1 }))).toBeNull();
    expect(liveEditFrameUrl(state({ refine_active: true }, { behind_by: 2 }))).toBeNull();
  });

  it("never frames a preview that is not live, or when the flag is off", () => {
    expect(liveEditFrameUrl(state({ preview: { status: "starting", url: null } }))).toBeNull();
    expect(liveEditFrameUrl(state({ preview: { status: "none", url: URL_ } }))).toBeNull();
    expect(liveEditFrameUrl({ ...state(), enabled: false })).toBeNull();
    expect(liveEditFrameUrl(LIVE_EDIT_OFF)).toBeNull();
  });
});

describe("useLiveEdit polling", () => {
  it("stops polling for good once the server says the flag is off", async () => {
    apiFetch.mockResolvedValue(ok(LIVE_EDIT_OFF));
    renderHook(() => useLiveEdit(true));
    await flush();
    expect(gets()).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_SLOW_POLL_MS * 3);
    });
    expect(gets()).toBe(1);
  });

  it("polls fast while a change runs and slows down once it settles", async () => {
    apiFetch.mockResolvedValueOnce(ok(state({ refine_active: true }))).mockResolvedValue(ok(state()));
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    expect(result.current.frameUrl).toBe(URL_);
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_FAST_POLL_MS);
    });
    await flush();
    expect(gets()).toBe(2);
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_FAST_POLL_MS);
    });
    await flush();
    expect(gets()).toBe(2);
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_SLOW_POLL_MS);
    });
    await flush();
    expect(gets()).toBe(3);
  });

  it("does not fetch at all when inactive", async () => {
    renderHook(() => useLiveEdit(false));
    await flush();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("stops the timer on unmount so a closed Build tab does not keep a sandbox awake", async () => {
    apiFetch.mockResolvedValue(ok(state({ refine_active: true })));
    const { unmount } = renderHook(() => useLiveEdit(true));
    await flush();
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_SLOW_POLL_MS * 4);
    });
    expect(gets()).toBe(1);
  });

  it("publish posts once and re-reads state; a refusal carries the server's message", async () => {
    apiFetch.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/workspace/autopilot/live-edit/publish" && init?.method === "POST") {
        return { ok: false, status: 409, json: async () => ({ error: { code: "draft_behind", message: "Your live app changed." } }) } as Response;
      }
      return ok(state());
    });
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    let out: Awaited<ReturnType<typeof result.current.publish>> | null = null;
    await act(async () => {
      out = await result.current.publish();
    });
    await flush();
    expect(out).toEqual({ ok: false, message: "Your live app changed." });
    expect(apiFetch.mock.calls.filter(([u]) => u === "/api/workspace/autopilot/live-edit/publish")).toHaveLength(1);
    expect(apiFetch.mock.calls.find(([u]) => u === "/api/workspace/autopilot/live-edit/publish")?.[1]).toMatchObject({ idempotent: true });
    expect(gets()).toBe(2);
  });

  it("does not poll while the tab is hidden and catches up once when it is shown again", async () => {
    apiFetch.mockResolvedValue(ok(state()));
    renderHook(() => useLiveEdit(true));
    await flush();
    expect(gets()).toBe(1);
    setHidden(true);
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_SLOW_POLL_MS * 6);
    });
    await flush();
    expect(gets()).toBe(1);
    await act(async () => {
      setHidden(false);
    });
    await flush();
    expect(gets()).toBe(2);
  });

  it.each([403, 404])("stops polling and reads as off when the server answers %s", async (code) => {
    apiFetch.mockResolvedValueOnce(ok(state())).mockResolvedValue(fail(code));
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    expect(result.current.frameUrl).toBe(URL_);
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_SLOW_POLL_MS);
    });
    await flush();
    expect(gets()).toBe(2);
    expect(result.current.state).toEqual(LIVE_EDIT_OFF);
    expect(result.current.frameUrl).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_MAX_BACKOFF_MS * 5);
    });
    await flush();
    expect(gets()).toBe(2);
  });

  it("backs off on server errors instead of asking every 15 seconds, and recovers on a good answer", async () => {
    apiFetch.mockResolvedValue(fail(500));
    renderHook(() => useLiveEdit(true));
    await flush();
    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(LIVE_EDIT_SLOW_POLL_MS);
      });
      await flush();
    }
    expect(gets()).toBe(3);
    apiFetch.mockResolvedValue(ok(state()));
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_MAX_BACKOFF_MS);
    });
    await flush();
    const afterRecovery = gets();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_SLOW_POLL_MS);
    });
    await flush();
    expect(gets()).toBe(afterRecovery + 1);
  });
});

describe("useLiveEdit keeps the sandbox awake only while it is framed", () => {
  it("asks with framed=1 only while the draft preview is on screen", async () => {
    apiFetch
      .mockResolvedValueOnce(ok(state()))
      .mockResolvedValueOnce(ok(state({}, { ahead_by: 0 })))
      .mockResolvedValue(ok(state({}, { ahead_by: 0 })));
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    expect(result.current.frameUrl).toBe(URL_);
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_SLOW_POLL_MS);
    });
    await flush();
    expect(result.current.frameUrl).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_SLOW_POLL_MS);
    });
    await flush();
    expect(statePolls()).toEqual([
      "/api/workspace/autopilot/live-edit",
      "/api/workspace/autopilot/live-edit?framed=1",
      "/api/workspace/autopilot/live-edit",
    ]);
  });
});

describe("useLiveEdit tells unknown apart from off", () => {
  function deferred() {
    let resolve: (r: Response) => void = () => {};
    const promise = new Promise<Response>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("an edit sent before the first answer waits for that same read and sees live edit on", async () => {
    const first = deferred();
    apiFetch.mockReturnValueOnce(first.promise).mockResolvedValue(ok(state()));
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    expect(result.current.known).toBe("unknown");
    let answer: boolean | null = null;
    const pending = result.current.resolveEnabled().then((v) => (answer = v));
    await flush();
    expect(answer).toBeNull();
    await act(async () => {
      first.resolve(ok(state()));
      await pending;
    });
    expect(answer).toBe(true);
    expect(result.current.known).toBe("on");
    expect(gets()).toBe(1);
  });

  it("after a failed first read it asks again before routing", async () => {
    apiFetch.mockResolvedValueOnce(fail(500)).mockResolvedValue(ok(state()));
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    expect(result.current.known).toBe("unknown");
    let answer: boolean | null = null;
    await act(async () => {
      answer = await result.current.resolveEnabled();
    });
    expect(answer).toBe(true);
    expect(gets()).toBe(2);
  });

  it.each([
    ["the flag is off", () => ok(LIVE_EDIT_OFF)],
    ["the server answers 403", () => fail(403)],
    ["the server answers 404", () => fail(404)],
  ])("reads as a known off when %s, and never reports on", async (_label, reply) => {
    apiFetch.mockResolvedValue(reply());
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    expect(result.current.known).toBe("off");
    let answer: boolean | null = null;
    await act(async () => {
      answer = await result.current.resolveEnabled();
    });
    expect(answer).toBe(false);
    expect(gets()).toBe(1);
  });

  it("gives up after a short wait when the server never answers, and reports off", async () => {
    apiFetch.mockReturnValue(new Promise<Response>(() => {}));
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    let answer: boolean | null = null;
    const pending = result.current.resolveEnabled().then((v) => (answer = v));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_EDIT_RESOLVE_WAIT_MS);
      await pending;
    });
    expect(answer).toBe(false);
    expect(result.current.known).toBe("unknown");
  });
});

describe("useLiveEdit opens the newest draft on its own after every change", () => {
  const WAKE = "/api/workspace/autopilot/live-edit/wake";
  const wakes = () => apiFetch.mock.calls.filter(([u, init]) => u === WAKE && (init as RequestInit | undefined)?.method === "POST").length;
  const asleep = (sha: string, ahead = 3) =>
    state({ preview: { status: "none", url: null } }, { ahead_by: ahead, head_sha: sha.repeat(40) });

  it("wakes the draft preview without a click when a change finishes and the sandbox went to sleep", async () => {
    let current: LiveEditState = state({ refine_active: true }, { ahead_by: 2, head_sha: "a".repeat(40) });
    let releaseWake: (r: Response) => void = () => undefined;
    apiFetch.mockImplementation((u: string, init?: RequestInit) => {
      if (u === WAKE && init?.method === "POST") return new Promise<Response>((r) => (releaseWake = r));
      return Promise.resolve(ok(current));
    });
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    expect(wakes()).toBe(0);
    expect(result.current.frameUrl).toBe(URL_);

    current = asleep("b");
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_FAST_POLL_MS);
    });
    await flush();
    expect(result.current.frameUrl).toBeNull();
    expect(wakes()).toBe(1);
    expect(result.current.loadingLatest).toBe(true);

    current = state({ preview: { status: "starting", url: null } }, { ahead_by: 3, head_sha: "b".repeat(40) });
    await act(async () => {
      releaseWake(ok({ ok: true }));
    });
    await flush();
    expect(result.current.loadingLatest).toBe(true);

    current = state({}, { ahead_by: 3, head_sha: "b".repeat(40) });
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_FAST_POLL_MS);
    });
    await flush();
    expect(result.current.loadingLatest).toBe(false);
    expect(result.current.frameUrl).toBe(URL_);
    expect(wakes()).toBe(1);
  });

  it("tries once per draft version, then again for the next change", async () => {
    let current = asleep("c");
    apiFetch.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === WAKE && init?.method === "POST") return fail(503);
      return ok(current);
    });
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    await flush();
    expect(wakes()).toBe(1);
    expect(result.current.loadingLatest).toBe(false);

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(LIVE_EDIT_SLOW_POLL_MS);
      });
      await flush();
    }
    expect(wakes()).toBe(1);

    current = asleep("d", 4);
    await act(async () => {
      vi.advanceTimersByTime(LIVE_EDIT_SLOW_POLL_MS);
    });
    await flush();
    await flush();
    expect(wakes()).toBe(2);
  });

  it("does not wake a draft that fell behind, one still being changed, nothing unpublished, or a closed Build tab", async () => {
    for (const s of [
      state({ preview: { status: "none", url: null } }, { behind_by: 1 }),
      state({ preview: { status: "none", url: null }, refine_active: true }),
      state({ preview: { status: "none", url: null } }, { ahead_by: 0 }),
      state({ preview: { status: "starting", url: null } }),
    ]) {
      apiFetch.mockReset();
      apiFetch.mockResolvedValue(ok(s));
      const { unmount } = renderHook(() => useLiveEdit(true));
      await flush();
      await flush();
      expect(wakes()).toBe(0);
      unmount();
    }
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(ok(asleep("e")));
    renderHook(() => useLiveEdit(false));
    await flush();
    expect(wakes()).toBe(0);
  });
});

describe("useLiveEdit never leaves the founder on an endless loading screen", () => {
  const WAKE = "/api/workspace/autopilot/live-edit/wake";
  const wakes = () => apiFetch.mock.calls.filter(([u, init]) => u === WAKE && (init as RequestInit | undefined)?.method === "POST").length;
  const stuck = () => state({ preview: { status: "starting", url: null } }, { ahead_by: 2, head_sha: "f".repeat(40) });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("gives up on a preview the server keeps reporting as starting, and a manual wake restarts the clock", async () => {
    let current = stuck();
    apiFetch.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === WAKE && init?.method === "POST") return ok({ ok: true });
      return ok(current);
    });
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    expect(result.current.loadingLatest).toBe(true);

    await advance(LIVE_EDIT_START_TIMEOUT_MS - 1000);
    expect(gets()).toBeGreaterThan(20);
    expect(result.current.loadingLatest).toBe(true);

    await advance(1000);
    expect(result.current.loadingLatest).toBe(false);
    await advance(LIVE_EDIT_FAST_POLL_MS * 3);
    expect(result.current.loadingLatest).toBe(false);
    expect(wakes()).toBe(0);

    let r: unknown;
    await act(async () => {
      r = await result.current.wake();
    });
    expect(r).toEqual({ ok: true, commit_sha: undefined });
    expect(wakes()).toBe(1);
    await flush();
    expect(result.current.loadingLatest).toBe(true);

    await advance(LIVE_EDIT_START_TIMEOUT_MS - 1000);
    expect(result.current.loadingLatest).toBe(true);
    await advance(1000);
    expect(result.current.loadingLatest).toBe(false);

    await act(async () => {
      await result.current.wake();
    });
    current = state({}, { ahead_by: 2, head_sha: "f".repeat(40) });
    await advance(LIVE_EDIT_FAST_POLL_MS);
    expect(result.current.loadingLatest).toBe(false);
    expect(result.current.frameUrl).toBe(URL_);
  });

  it("gives up on an automatic wake request that never answers", async () => {
    apiFetch.mockImplementation((u: string, init?: RequestInit) => {
      if (u === WAKE && init?.method === "POST") return new Promise<Response>(() => undefined);
      return Promise.resolve(ok(state({ preview: { status: "none", url: null } }, { ahead_by: 2, head_sha: "9".repeat(40) })));
    });
    const { result } = renderHook(() => useLiveEdit(true));
    await flush();
    await flush();
    expect(wakes()).toBe(1);
    expect(result.current.loadingLatest).toBe(true);
    await advance(LIVE_EDIT_START_TIMEOUT_MS - 1000);
    expect(result.current.loadingLatest).toBe(true);
    await advance(1000);
    expect(result.current.loadingLatest).toBe(false);
    expect(wakes()).toBe(1);
  });
});

describe("useLiveEdit does not boot a sandbox while an older version is on screen", () => {
  const WAKE = "/api/workspace/autopilot/live-edit/wake";
  const wakes = () => apiFetch.mock.calls.filter(([u, init]) => u === WAKE && (init as RequestInit | undefined)?.method === "POST").length;
  const asleep = () => state({ preview: { status: "none", url: null } }, { ahead_by: 3, head_sha: "7".repeat(40) });

  it("holds the automatic wake across polls and remounts while a checkpoint is viewed, then wakes once on return", async () => {
    apiFetch.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === WAKE && init?.method === "POST") return ok({ ok: true });
      return ok(asleep());
    });
    for (let i = 0; i < 3; i += 1) {
      const { result, unmount } = renderHook(() => useLiveEdit(true, { autoWake: false }));
      await flush();
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVE_EDIT_SLOW_POLL_MS * 2);
      });
      expect(result.current.state.draft.ahead_by).toBe(3);
      expect(result.current.loadingLatest).toBe(false);
      unmount();
    }
    expect(gets()).toBeGreaterThanOrEqual(6);
    expect(wakes()).toBe(0);

    const { result, rerender } = renderHook(({ autoWake }) => useLiveEdit(true, { autoWake }), {
      initialProps: { autoWake: false },
    });
    await flush();
    await flush();
    expect(wakes()).toBe(0);
    rerender({ autoWake: true });
    await flush();
    expect(wakes()).toBe(1);
    await flush();
    expect(result.current.state.draft.ahead_by).toBe(3);
    expect(wakes()).toBe(1);
  });
});
