// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  replies: [] as Array<unknown>,
  gate: null as null | { release: () => void; promise: Promise<void> },
}));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => {
    if (h.gate) await h.gate.promise;
    const next = h.replies.length > 1 ? h.replies.shift() : h.replies[0];
    if (next instanceof Error) throw next;
    return { ok: true, status: 200, json: async () => next };
  }),
}));

import { apiFetch } from "@/lib/api";
import { LEARNED_POLL_CAP_MS, LEARNED_POLL_MS, WhatZaviLearned } from "./WhatZaviLearned";

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const READY = {
  status: "ready",
  card: {
    lines: ["You come up next to Molly Maid and Merry Maids."],
    quotes: [{ text: "Standard clean starts at $80", source_url: "https://www.sparkle.example/pricing" }],
  },
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};
const tick = async (ms: number) => {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockClear();
  h.replies = [];
  h.gate = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WhatZaviLearned", () => {
  it("waits through a pending pass, shows the card when research lands, then stops asking", async () => {
    h.replies = [{ status: "none", card: null }, { status: "pending", card: null }, READY];
    render(<WhatZaviLearned active />);
    await flush();
    expect(screen.queryByTestId("what-zavi-learned")).toBeNull();
    await tick(LEARNED_POLL_MS);
    expect(screen.queryByTestId("what-zavi-learned")).toBeNull();
    await tick(LEARNED_POLL_MS);
    const card = screen.getByTestId("what-zavi-learned");
    expect(card.textContent).toContain("You come up next to Molly Maid and Merry Maids.");
    expect(card.textContent).toContain("“Standard clean starts at $80”");
    expect(card.textContent).toContain("from sparkle.example");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await tick(LEARNED_POLL_MS * 6);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every((c) => c[0] === "/api/workspace/growth-intake/learned" && !c[1])).toBe(true);
  });

  it("a failed pass, or a pass with nothing to say, shows nothing and stops asking", async () => {
    h.replies = [{ status: "failed", card: null }];
    render(<WhatZaviLearned active />);
    await flush();
    await tick(LEARNED_POLL_MS * 3);
    expect(screen.queryByTestId("what-zavi-learned")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never asks while the plan is not cooking, and hides the card once the plan is ready", async () => {
    const { rerender } = render(<WhatZaviLearned active={false} />);
    await tick(LEARNED_POLL_MS * 3);
    expect(fetchMock).not.toHaveBeenCalled();
    h.replies = [READY];
    rerender(<WhatZaviLearned active />);
    await flush();
    expect(screen.getByTestId("what-zavi-learned")).toBeTruthy();
    rerender(<WhatZaviLearned active={false} />);
    expect(screen.queryByTestId("what-zavi-learned")).toBeNull();
  });

  it("a network error keeps waiting instead of giving up, and polling ends at the cap", async () => {
    h.replies = [new Error("offline")];
    render(<WhatZaviLearned active />);
    await flush();
    await tick(LEARNED_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(LEARNED_POLL_CAP_MS * 2);
    const capped = fetchMock.mock.calls.length;
    expect(capped).toBeLessThanOrEqual(LEARNED_POLL_CAP_MS / LEARNED_POLL_MS + 2);
    await tick(LEARNED_POLL_MS * 10);
    expect(fetchMock.mock.calls.length).toBe(capped);
  });

  it("leaving the page mid-read schedules nothing more and shows nothing", async () => {
    let release!: () => void;
    h.gate = { release: () => release(), promise: new Promise<void>((r) => { release = r; }) };
    h.replies = [{ status: "pending", card: null }];
    const { unmount } = render(<WhatZaviLearned active />);
    await flush();
    unmount();
    h.gate.release();
    await flush();
    await tick(LEARNED_POLL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a malformed reply renders no card and no broken quote", async () => {
    h.replies = [{ status: "ready", card: { lines: [42, ""], quotes: [{ text: 7 }, null, { text: "  ", source_url: "x" }] } }];
    render(<WhatZaviLearned active />);
    await flush();
    expect(screen.queryByTestId("what-zavi-learned")).toBeNull();
  });
});
