// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import type { SetupResponse, SetupState } from "./setupState";

const h = vi.hoisted(() => ({
  state: null as SetupResponse | null,
  canManage: true,
  marks: [] as unknown[],
  opened: [] as unknown[],
  refreshes: 0,
  startFailed: false,
  drafts: 0,
}));
vi.mock("./SetupProvider", () => ({
  useSetupOptional: () => ({
    state: h.state,
    canManageSetup: h.canManage,
    refresh: async () => { h.refreshes += 1; },
    draftStartFailed: h.startFailed,
    draftStarting: false,
    startDraft: async () => { h.drafts += 1; },
    mark: async (m: unknown) => { h.marks.push(m); return null; },
  }),
}));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ openTab: (t: unknown) => h.opened.push(t) }) }));

import { StrategyProgressNotice } from "./StrategyProgressNotice";

const after = (draft: "none" | "running" | "failed" | "done", has_plan = false): SetupState => ({
  enabled: true,
  docs: { status: "skipped", files: 0, facts: 0 },
  connectors: { status: "skipped" },
  done: true,
  home_seen: false,
  has_plan,
  draft: { status: draft, run_id: null, attempts: 1, can_retry: draft === "failed", free_retry: false },
});

beforeEach(() => { h.state = null; h.canManage = true; h.marks = []; h.opened = []; h.refreshes = 0; h.startFailed = false; h.drafts = 0; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("StrategyProgressNotice", () => {
  it("says the strategy is being written, is not a link, and re-reads until it is ready", async () => {
    vi.useFakeTimers();
    h.state = after("running");
    render(<StrategyProgressNotice />);
    const card = screen.getByTestId("strategy-progress-card");
    expect(card.getAttribute("data-state")).toBe("writing");
    expect(card.textContent).toContain("Zavi is writing your growth strategy");
    expect(screen.queryByRole("button")).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(h.refreshes).toBe(1);
  });

  it("once ready, opens Growth Strategy and retires itself", async () => {
    h.state = after("done", true);
    render(<StrategyProgressNotice embedded />);
    fireEvent.click(screen.getByRole("button", { name: /Your growth strategy is ready/ }));
    expect(h.opened).toEqual([expect.objectContaining({ kind: "autopilot" })]);
    await waitFor(() => expect(h.marks).toEqual([{ step: "home" }]));
  });

  it("a failed draft points to Growth Strategy, where the retry lives, without retiring the card", async () => {
    h.state = after("failed");
    render(<StrategyProgressNotice />);
    fireEvent.click(screen.getByRole("button", { name: /didn't finish/ }));
    expect(h.opened).toHaveLength(1);
    expect(h.marks).toEqual([]);
  });

  it("a draft that never started is not 'writing' forever: it says so and tries again on click", () => {
    h.state = after("none");
    h.startFailed = true;
    render(<StrategyProgressNotice />);
    const card = screen.getByRole("button", { name: /didn't finish/ });
    fireEvent.click(card);
    expect(h.drafts).toBe(1);
    expect(h.opened).toHaveLength(1);
    expect(h.marks).toEqual([]);
  });

  it("renders nothing while the setup is still running or for a member", () => {
    h.state = { ...after("none"), done: false };
    const { container, rerender } = render(<StrategyProgressNotice />);
    expect(container.textContent).toBe("");
    h.state = after("running");
    h.canManage = false;
    rerender(<StrategyProgressNotice />);
    expect(container.textContent).toBe("");
  });
});
