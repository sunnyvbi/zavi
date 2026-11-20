// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { SetupMascot, mascotLine, setupMascotShown } from "./SetupMascot";
import type { SetupState } from "./setupState";
afterEach(cleanup);

const s = (over: Partial<SetupState> = {}): SetupState => ({
  enabled: true, done: false, home_seen: false,
  docs: { status: "pending", files: 0, facts: 0 }, connectors: { status: "pending" },
  draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: false }, ...over,
});

describe("SetupMascot", () => {
  it("says one line per step (from the design)", () => {
    expect(mascotLine(s()).line).toBe("Hi, I'm Zavi! Let's cook your growth strategy. First, feed me your past work.");
    expect(mascotLine(s({ docs: { status: "done", files: 2, facts: 9 } })).line).toBe("Yum, 9 facts! 50% cooked. Now let's plug in your numbers.");
    expect(mascotLine(s({ docs: { status: "skipped", files: 0, facts: 0 } })).line).toBe("No files? No problem. 50% cooked. Now let's plug in your numbers.");
    expect(mascotLine(s({ docs: { status: "skipped", files: 0, facts: 0 }, connectors: { status: "done" } })).line).toBe("Connected! 100% cooked. One last polish and it's served.");
    expect(mascotLine(s({ docs: { status: "skipped", files: 0, facts: 0 }, connectors: { status: "skipped" } })).line).toBe("We'll measure later. 100% cooked, one last polish.");
  });
  it("says ready only once the draft has landed", () => {
    const draft = (status: SetupState["draft"]["status"]) => ({ status, run_id: "r1", attempts: 1, can_retry: false, free_retry: false });
    expect(mascotLine(s({ done: true })).line).toBe("Reading your business information before writing your strategy.");
    expect(mascotLine(s({ done: true, draft: draft("running") })).line).toBe("Writing your growth strategy from your business information.");
    expect(mascotLine(s({ done: true, draft: draft("done") })).line).toBe("Your growth strategy is ready. You did it. Let's grow!");
    expect(mascotLine(s({ done: true, draft: draft("failed") })).line).toMatch(/went wrong/);
  });
  it("shows only to setup managers, and never Building for a draft nobody is starting", () => {
    const running = { status: "running" as const, run_id: "r1", attempts: 1, can_retry: false, free_retry: false };
    expect(setupMascotShown(s(), false, false)).toBe(false);
    expect(setupMascotShown(s(), true, false)).toBe(true);
    expect(setupMascotShown(s({ done: true }), true, true)).toBe(true);
    expect(setupMascotShown(s({ done: true }), true, false)).toBe(false);
    expect(setupMascotShown(s({ done: true, draft: running }), true, false)).toBe(true);
  });
  it("celebrates when a step finishes, then settles", () => {
    vi.useFakeTimers();
    const { rerender } = render(<SetupMascot state={s()} />);
    expect(screen.queryByTestId("mascot-confetti")).toBeNull();
    rerender(<SetupMascot state={s({ docs: { status: "skipped", files: 0, facts: 0 } })} />);
    expect(screen.getByTestId("mascot-confetti")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2700); });
    expect(screen.queryByTestId("mascot-confetti")).toBeNull();
    vi.useRealTimers();
  });
  it("celebrates again when the strategy lands", () => {
    vi.useFakeTimers();
    const building = s({ docs: { status: "done", files: 1, facts: 2 }, connectors: { status: "done" }, done: true, draft: { status: "running", run_id: "r1", attempts: 1, can_retry: false, free_retry: false } });
    const { rerender } = render(<SetupMascot state={building} />);
    expect(screen.queryByTestId("mascot-confetti")).toBeNull();
    rerender(<SetupMascot state={{ ...building, draft: { ...building.draft, status: "done" } }} />);
    expect(screen.getByTestId("mascot-confetti")).toBeTruthy();
    vi.useRealTimers();
  });
});
