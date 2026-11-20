import { describe, it, expect } from "vitest";
import { continueRefusal, CONTINUE_WINDOW_MS } from "../continue-build";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const fresh = [{ status: "done", payload: { stage: "build" } }];

describe("continueRefusal", () => {
  it("accepts a paused fresh build inside the window", () => {
    expect(continueRefusal({ kind: "build_app", status: "paused", paused_at: at(1000), goal_graph: fresh }, NOW)).toBeNull();
  });

  it("accepts exactly at the window edge and refuses one ms past it", () => {
    expect(continueRefusal({ kind: "build_app", status: "paused", paused_at: at(CONTINUE_WINDOW_MS), goal_graph: fresh }, NOW)).toBeNull();
    expect(continueRefusal({ kind: "build_app", status: "paused", paused_at: at(CONTINUE_WINDOW_MS + 1), goal_graph: fresh }, NOW)).toBe("expired");
  });

  it("refuses a missing paused_at as expired", () => {
    expect(continueRefusal({ kind: "build_app", status: "paused", paused_at: null, goal_graph: fresh }, NOW)).toBe("expired");
  });

  it("refuses an active run, and a sweep-expired failed run (it was paused) as expired", () => {
    expect(continueRefusal({ kind: "build_app", status: "failed", paused_at: at(1000), goal_graph: fresh }, NOW)).toBe("expired");
    expect(continueRefusal({ kind: "build_app", status: "active", paused_at: null, goal_graph: fresh }, NOW)).toBe("not_paused");
  });

  it("retries a recent failed run with a failed stage and budget left, and refuses the rest", () => {
    const failedGraph = [{ status: "failed", payload: { stage: "deploy" } }];
    const base = { kind: "build_app", status: "failed", paused_at: null, updated_at: at(1000), goal_graph: failedGraph };
    expect(continueRefusal({ ...base, failure_class: "deploy_failed", spend_usd: 3, max_usd: 20 }, NOW)).toBeNull();
    expect(continueRefusal({ ...base, updated_at: at(CONTINUE_WINDOW_MS + 1) }, NOW)).toBe("expired");
    expect(continueRefusal({ ...base, failure_class: "user_cancelled" }, NOW)).toBe("not_resumable");
    expect(continueRefusal({ ...base, goal_graph: fresh }, NOW)).toBe("not_resumable");
    expect(continueRefusal({ ...base, spend_usd: 20, max_usd: 20 }, NOW)).toBe("budget_spent");
  });

  it("refuses refines, other kinds and a missing row", () => {
    const refine = [{ status: "failed", payload: { stage: "build", refine_mode: true } }];
    expect(continueRefusal({ kind: "build_app", status: "paused", paused_at: at(1000), goal_graph: refine }, NOW)).toBe("not_found");
    expect(continueRefusal({ kind: "company_goal", status: "paused", paused_at: at(1000), goal_graph: fresh }, NOW)).toBe("not_found");
    expect(continueRefusal(null, NOW)).toBe("not_found");
  });
});
