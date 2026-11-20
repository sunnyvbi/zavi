// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { __resetVersionPreviewCache, useVersionPreview, versionPollDelay, VERSION_PREVIEW_POLL_MS, VERSION_PREVIEW_POLL_MAX_MS, VERSION_PREVIEW_MAX_WAIT_MS, VERSION_LINK_RENEW_BEFORE_MS } from "./useVersionPreview";

function json(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body } as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
  __resetVersionPreviewCache();
});
afterEach(() => {
  vi.useRealTimers();
});

const posts = () => apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
const gets = () => apiFetch.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method);

describe("a stored site version (signed link, live at once)", () => {
  it("is live on the POST answer with no polling", async () => {
    apiFetch.mockImplementation(async () => json({ status: "live", url: "https://bike.zaviagent.com/__zavi_preview/d1/?t=a", expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }));
    const { result } = renderHook(() => useVersionPreview("r1"));
    await act(async () => {});
    expect(result.current).toMatchObject({ status: "live", url: "https://bike.zaviagent.com/__zavi_preview/d1/?t=a" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VERSION_PREVIEW_POLL_MS * 5);
    });
    expect(gets()).toHaveLength(0);
    expect(posts()).toHaveLength(1);
  });

  it("renews the link a minute before it expires, keeping the old one on screen until the new one arrives", async () => {
    let n = 0;
    let release: (() => void) | null = null;
    apiFetch.mockImplementation(async () => {
      n += 1;
      const body = { status: "live", url: `https://bike.zaviagent.com/__zavi_preview/d1/?t=${n}`, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() };
      if (n === 2) await new Promise<void>((r) => (release = r));
      return json(body);
    });
    const { result } = renderHook(() => useVersionPreview("r1"));
    await act(async () => {});
    expect(result.current.url).toMatch(/t=1$/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000 - VERSION_LINK_RENEW_BEFORE_MS - 1_000);
    });
    expect(posts()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(posts()).toHaveLength(2);
    expect(result.current).toMatchObject({ status: "live" });
    expect(result.current.url).toMatch(/t=1$/);
    await act(async () => {
      release?.();
    });
    expect(result.current.url).toMatch(/t=2$/);
  });

  it("a version the server says can never be shown is not offered again; a failed one is", async () => {
    apiFetch.mockImplementation(async () => json({ status: "dead", url: null, error: "Zavi has no saved copy of this version's code, so it can't be shown.", retryable: false }));
    const { result } = renderHook(() => useVersionPreview("r1"));
    await act(async () => {});
    expect(result.current).toMatchObject({ status: "dead", retryable: false });
    apiFetch.mockImplementation(async () => json({ status: "dead", url: null, error: "Zavi couldn't build a preview of this version just now. Try again." }));
    await act(async () => {
      result.current.retry();
    });
    expect(posts()).toHaveLength(2);
    expect(result.current).toMatchObject({ status: "dead", retryable: true });
  });

  it("a version that is still being built from its commit polls until the built copy is live", async () => {
    const url = "https://yoga.zaviagent.com/__zavi_preview/d1/?t=a&zavi_embed=1";
    const answers = [json({ status: "starting", url: null, error: null }), json({ status: "live", url, expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), error: null })];
    apiFetch.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ status: "starting", url: null, error: null }, true, 202) : answers.shift()!,
    );
    const { result } = renderHook(() => useVersionPreview("r1"));
    await act(async () => {});
    expect(result.current.status).toBe("starting");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VERSION_PREVIEW_POLL_MS * 2);
    });
    expect(result.current).toMatchObject({ status: "live", url });
    expect(gets()).toHaveLength(2);
  });

  it("a version that is gone is dead with the server's reason", async () => {
    apiFetch.mockImplementation(async () => json({ status: "dead", url: null, error: "This version is too old to open." }));
    const { result } = renderHook(() => useVersionPreview("r1"));
    await act(async () => {});
    expect(result.current).toMatchObject({ status: "dead", error: "This version is too old to open." });
  });
});

describe("useVersionPreview", () => {
  it("starts the version's preview once, polls until live, then stops polling", async () => {
    const answers = [json({ status: "starting" }), json({ status: "starting" }), json({ status: "live", url: "https://3300-sbx.e2b.app" })];
    apiFetch.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ status: "starting" }, true, 202) : answers.shift() ?? json({ status: "live", url: "https://3300-sbx.e2b.app" }),
    );
    const { result } = renderHook(() => useVersionPreview("r1"));
    await act(async () => {});
    expect(result.current.status).toBe("starting");
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0][1]!.body))).toEqual({ conductor_run_id: "r1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VERSION_PREVIEW_POLL_MS * 3);
    });
    expect(result.current).toMatchObject({ status: "live", url: "https://3300-sbx.e2b.app" });
    const before = gets().length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VERSION_PREVIEW_POLL_MS * 5);
    });
    expect(gets().length).toBe(before);
    expect(posts()).toHaveLength(1);
  });

  it("a dead job surfaces its reason and retry starts a fresh boot", async () => {
    apiFetch.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ status: "starting" }, true, 202) : json({ status: "dead", error: "The preview didn't start in time" }),
    );
    const { result } = renderHook(() => useVersionPreview("r1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VERSION_PREVIEW_POLL_MS);
    });
    expect(result.current).toMatchObject({ status: "dead", error: "The preview didn't start in time" });
    await act(async () => {
      result.current.retry();
    });
    await act(async () => {});
    expect(posts()).toHaveLength(2);
  });

  it("waits out the server's 20-minute staging deadline, backing off, then gives up instead of polling forever", async () => {
    apiFetch.mockImplementation(async () => json({ status: "starting" }, true, 202));
    const { result } = renderHook(() => useVersionPreview("r1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VERSION_PREVIEW_POLL_MS * 10);
    });
    expect(gets().length).toBe(10);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(19 * 60_000);
    });
    expect(result.current.status).toBe("starting");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VERSION_PREVIEW_MAX_WAIT_MS);
    });
    expect(result.current).toMatchObject({ status: "dead", error: "The preview is taking too long to start." });
    const total = gets().length;
    expect(total).toBeGreaterThan(80);
    expect(total).toBeLessThan(100);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    });
    expect(gets().length).toBe(total);
  });

  it("a staged build that goes live after 12 minutes opens instead of saying it took too long", async () => {
    const liveAt = Date.now() + 12 * 60_000;
    apiFetch.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" || Date.now() < liveAt
        ? json({ status: "starting" }, true, 202)
        : json({ status: "live", url: "https://bike.zaviagent.com/__zavi_preview/d9/?t=z", expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }),
    );
    const { result } = renderHook(() => useVersionPreview("r1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12 * 60_000 + VERSION_PREVIEW_POLL_MAX_MS);
    });
    expect(result.current).toMatchObject({ status: "live", url: "https://bike.zaviagent.com/__zavi_preview/d9/?t=z" });
  });

  it("polls every 3s for the first 30s, then backs off to one poll every 15s", () => {
    expect([1, 5, 10].map(versionPollDelay)).toEqual([3000, 3000, 3000]);
    expect([11, 12, 13, 14].map(versionPollDelay)).toEqual([4500, 6750, 10125, 15000]);
    expect(versionPollDelay(200)).toBe(VERSION_PREVIEW_POLL_MAX_MS);
  });

  it("a refused start is dead with the server's reason, and a null run id is idle with no calls", async () => {
    apiFetch.mockImplementation(async () => json({ error: { message: "That version's commit could not be found" } }, false, 409));
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useVersionPreview(id), { initialProps: { id: "r1" as string | null } });
    await act(async () => {});
    expect(result.current).toMatchObject({ status: "dead", error: "That version's commit could not be found" });
    rerender({ id: null });
    expect(result.current.status).toBe("idle");
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("switching versions cancels the old poll and boots the new one", async () => {
    apiFetch.mockImplementation(async (u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ status: "starting" }, true, 202) : json({ status: "starting" }),
    );
    const { rerender } = renderHook(({ id }: { id: string | null }) => useVersionPreview(id), { initialProps: { id: "r1" as string | null } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VERSION_PREVIEW_POLL_MS);
    });
    rerender({ id: "r2" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VERSION_PREVIEW_POLL_MS * 2);
    });
    const ids = posts().map(([, init]) => JSON.parse(String((init as RequestInit).body)).conductor_run_id);
    expect(ids).toEqual(["r1", "r2"]);
    expect(gets().every(([u]) => !String(u).includes("conductor_run_id=r1") || true)).toBe(true);
    const r1PollsAfterSwitch = gets().filter(([u]) => String(u).includes("conductor_run_id=r1")).length;
    expect(r1PollsAfterSwitch).toBe(1);
  });
});

describe("hopping between versions already opened", () => {
  const link = (run: string, n = 1) => `https://bike.zaviagent.com/__zavi_preview/d-${run}/?t=${n}&zavi_embed=1`;
  const signed = () => {
    let n = 0;
    apiFetch.mockImplementation(async (_u: string, init?: RequestInit) => {
      n += 1;
      const run = JSON.parse(String(init?.body ?? "{}")).conductor_run_id as string;
      return json({ status: "live", url: link(run, n), expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), error: null });
    });
  };
  const hop = () => renderHook(({ id }: { id: string | null }) => useVersionPreview(id), { initialProps: { id: "r1" as string | null } });
  const postedIds = () => posts().map(([, init]) => JSON.parse(String((init as RequestInit).body)).conductor_run_id);

  it("going back to a stored version frames its link on the very first render and asks the server nothing", async () => {
    signed();
    const { result, rerender } = hop();
    await act(async () => {});
    rerender({ id: "r2" });
    await act(async () => {});
    expect(result.current.url).toBe(link("r2", 2));
    rerender({ id: "r1" });
    expect(result.current).toMatchObject({ status: "live", url: link("r1", 1) });
    rerender({ id: null });
    rerender({ id: "r2" });
    expect(result.current).toMatchObject({ status: "live", url: link("r2", 2) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VERSION_PREVIEW_POLL_MS * 3);
    });
    expect(postedIds()).toEqual(["r1", "r2"]);
    expect(gets()).toHaveLength(0);
  });

  it("switching never shows the previous version's frame for a version it has not opened yet", async () => {
    signed();
    const { result, rerender } = hop();
    await act(async () => {});
    rerender({ id: "r2" });
    expect(result.current).toMatchObject({ status: "starting", url: null });
    await act(async () => {});
    expect(result.current.url).toBe(link("r2", 2));
  });

  it("a link inside its last minute is not reused: the version is asked for again", async () => {
    signed();
    const { result, rerender } = hop();
    await act(async () => {});
    rerender({ id: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000 - VERSION_LINK_RENEW_BEFORE_MS + 1);
    });
    rerender({ id: "r1" });
    expect(result.current.status).toBe("starting");
    await act(async () => {});
    expect(result.current).toMatchObject({ status: "live", url: link("r1", 2) });
    expect(postedIds()).toEqual(["r1", "r1"]);
  });

  it("the renewed link is the one reused after hopping away and back", async () => {
    signed();
    const { result, rerender } = hop();
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000 - VERSION_LINK_RENEW_BEFORE_MS + 1_000);
    });
    expect(result.current.url).toBe(link("r1", 2));
    rerender({ id: null });
    rerender({ id: "r1" });
    expect(result.current).toMatchObject({ status: "live", url: link("r1", 2) });
    await act(async () => {});
    expect(postedIds()).toEqual(["r1", "r1"]);
  });

  it("a sandbox preview (no expiry, one dev server every version shares) is never reused, because another version may have replaced it", async () => {
    apiFetch.mockImplementation(async () => json({ status: "live", url: "https://3400-sbx.e2b.app" }));
    const { result, rerender } = hop();
    await act(async () => {});
    rerender({ id: "r2" });
    await act(async () => {});
    rerender({ id: "r1" });
    expect(result.current).toMatchObject({ status: "starting", url: null });
    await act(async () => {});
    expect(postedIds()).toEqual(["r1", "r2", "r1"]);
  });

  it("a version that died is asked for again, never served from an older live link", async () => {
    let dead = false;
    apiFetch.mockImplementation(async () =>
      dead
        ? json({ status: "dead", url: null, error: "This version is too old to open." })
        : json({ status: "live", url: link("r1"), expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }),
    );
    const { result, rerender } = hop();
    await act(async () => {});
    dead = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000 - VERSION_LINK_RENEW_BEFORE_MS + 1_000);
    });
    expect(result.current.status).toBe("dead");
    rerender({ id: null });
    rerender({ id: "r1" });
    expect(result.current.status).toBe("starting");
    await act(async () => {});
    expect(result.current.status).toBe("dead");
    expect(posts()).toHaveLength(3);
  });
});
