// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GoalWork as GoalWorkData } from "@/lib/workspace/useGrowthPlan";

const calls: Array<{ path: string; method?: string }> = [];
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts?: { method?: string }) => {
    calls.push({ path, method: opts?.method });
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  },
}));
const approveSpy = vi.fn(async (_id: string) => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
vi.mock("@/lib/approvals/approveDecision", () => ({ approveDecision: (id: string) => approveSpy(id) }));

import { GoalWork, SuggestedGoal, foldFailedRetries, weekMomentum } from "./GoalWork";

const onChanged = vi.fn(async () => {});
const move = (over: Partial<GoalWorkData["moves"][number]> = {}): GoalWorkData["moves"][number] => ({
  decision_id: "d1",
  agent: "reddit_organic",
  intent: "Post the launch story in r/smallbusiness",
  why: "Buyers ask for this there",
  aims_to_move: null,
  hypothesis_id: null,
  state: "waiting",
  run_id: null,
  emitted_at: "2026-09-26T10:00:00Z",
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  approveSpy.mockClear();
  onChanged.mockClear();
});
afterEach(cleanup);

describe("GoalWork", () => {
  it("renders nothing when cgo has nothing for this goal (the head-of-growth card above speaks for it)", () => {
    const { container } = render(<GoalWork work={undefined} unavailable={false} onChanged={onChanged} />);
    expect(container.textContent).toBe("");
    const empty = render(<GoalWork work={{ status_line: null, status_at: null, moves: [] }} unavailable={false} onChanged={onChanged} />);
    expect(empty.container.textContent).toBe("");
  });

  it("says so when the work could not be read, instead of showing nothing", () => {
    render(<GoalWork work={undefined} unavailable onChanged={onChanged} />);
    expect(screen.getByText(/Couldn't load what I'm doing/)).toBeTruthy();
  });

  it("shows the status line and each move with its state", () => {
    render(
      <GoalWork
        work={{ status_line: "6 of 20 signups, 12 days left", status_at: null, moves: [move({ state: "running", decision_id: "d2" })] }}
        unavailable={false}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText("6 of 20 signups, 12 days left")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows what a waiting move aims to move; a running one keeps it for the expanded view", () => {
    render(
      <GoalWork
        work={{
          status_line: null,
          status_at: null,
          moves: [move({ aims_to_move: "weekly_signups" }), move({ decision_id: "d2", state: "running", aims_to_move: "bookings" })],
        }}
        unavailable={false}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText(/Aims to move: Weekly signups/i)).toBeTruthy();
    expect(screen.queryByText(/Aims to move: Bookings/i)).toBeNull();
  });

  it("lists what holds the goal back with where each idea stands; the evidence opens on click; a move says what it acts on", () => {
    render(
      <GoalWork
        work={{
          status_line: null,
          status_at: null,
          moves: [move({ hypothesis_id: "h-c" })],
          hypotheses: [
            { id: "h-c", claim: "The booking form asks for an insurance ID", status: "confirmed", evidence: [{ at: "2026-09-28", verdict: "confirmed", quote: "33 of 47 left at the insurance step", why: "direct" }] },
            { id: "h-r", claim: "Weak X posts", status: "ruled_out", evidence: [] },
          ],
        }}
        unavailable={false}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByText("What I think is holding this back")).toBeTruthy();
    expect(screen.getByText("Backed by evidence")).toBeTruthy();
    expect(screen.getByText("Ruled out")).toBeTruthy();
    expect(screen.queryByText(/33 of 47 left/)).toBeNull();
    fireEvent.click(screen.getByText("The booking form asks for an insurance ID"));
    expect(screen.getByText(/33 of 47 left/)).toBeTruthy();
    expect(screen.getByText("Acts on: The booking form asks for an insurance ID")).toBeTruthy();
  });

  it("with no guesses yet, the section says so instead of disappearing; a failed read never reads as empty", () => {
    render(<GoalWork work={{ status_line: "6 of 20", status_at: null, moves: [], hypotheses: [] }} unavailable={false} onChanged={onChanged} />);
    expect(screen.getByText(/Not worked out yet/)).toBeTruthy();
    cleanup();
    render(<GoalWork work={{ status_line: "6 of 20", status_at: null, moves: [], hypotheses: [], hypotheses_unavailable: true }} unavailable={false} onChanged={onChanged} />);
    expect(screen.getByText(/Couldn't load my guesses/)).toBeTruthy();
    expect(screen.queryByText(/Not worked out yet/)).toBeNull();
  });

  it("approves a waiting move through the shared helper, then refreshes", async () => {
    render(<GoalWork work={{ status_line: null, status_at: null, moves: [move()] }} unavailable={false} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(approveSpy).toHaveBeenCalledWith("d1");
  });

  it("'Not now' rejects the move", async () => {
    render(<GoalWork work={{ status_line: null, status_at: null, moves: [move()] }} unavailable={false} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls).toContainEqual({ path: "/api/approvals/d1/reject", method: "POST" });
  });
});

describe("the slip's amber edge", () => {
  it("is on a waiting move only, never on a running or done one", () => {
    const { container } = render(
      <GoalWork
        work={{ status_line: null, status_at: null, moves: [move(), move({ decision_id: "d2", state: "running" }), move({ decision_id: "d3", state: "done" })] }}
        unavailable={false}
        onChanged={onChanged}
      />,
    );
    expect(container.querySelectorAll('li[data-waiting="true"]').length).toBe(1);
  });
});

describe("SuggestedGoal", () => {
  it("accepts the suggestion through the accept route", async () => {
    render(<SuggestedGoal goalId="g9" objective="Get 50 signups" onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Make it a goal" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls).toContainEqual({ path: "/api/workspace/growth/goals/g9/accept", method: "POST" });
  });
});

describe("short by default", () => {
  it("folds an agent's repeated failures into one row with a count", () => {
    const moves = [
      move({ decision_id: "a", agent: "research", state: "failed" }),
      move({ decision_id: "b", agent: "meta_ads", state: "done" }),
      move({ decision_id: "c", agent: "research", state: "failed" }),
    ];
    expect(foldFailedRetries(moves).map((r) => [r.move.decision_id, r.tries])).toEqual([["a", 2], ["b", 1]]);
    render(<GoalWork work={{ status_line: null, status_at: null, moves }} unavailable={false} onChanged={onChanged} />);
    expect(screen.getByText("Didn't finish ×2")).toBeTruthy();
  });

  it("hides the why until the move is opened", () => {
    render(<GoalWork work={{ status_line: null, status_at: null, moves: [move({ state: "done" })] }} unavailable={false} onChanged={onChanged} />);
    expect(screen.queryByText("Buyers ask for this there")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Post the launch story/ }));
    expect(screen.getByText("Buyers ask for this there")).toBeTruthy();
  });

  it("counts the last 7 days of moves once each, across goals", () => {
    const now = new Date("2026-09-28T00:00:00Z");
    const recent = "2026-09-26T00:00:00Z";
    const work = {
      g1: { status_line: null, status_at: null, moves: [move({ decision_id: "1", state: "done", emitted_at: recent }), move({ decision_id: "2", state: "waiting", emitted_at: recent })] },
      g2: { status_line: null, status_at: null, moves: [move({ decision_id: "1", state: "done", emitted_at: recent }), move({ decision_id: "3", state: "failed", emitted_at: "2026-09-01T00:00:00Z" })] },
    };
    expect(weekMomentum(work, now).map((m) => m.label)).toEqual(["1 done", "1 waiting for you"]);
    expect(weekMomentum(undefined, now)).toEqual([]);
  });
});
