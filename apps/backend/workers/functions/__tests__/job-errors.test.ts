import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import { logJobError, persistingLogger } from "../_job-errors";

describe("logJobError", () => {
  it("saves the error as a staff-only praxis_logs row with the workspace in the message", async () => {
    const log = vi.fn(async () => {});
    await logJobError("cgo-budget-review", "tenant t-1: goal-owner: daily count failed: timeout", log);
    expect(log).toHaveBeenCalledWith({
      level: "error",
      source: "cgo-budget-review",
      code: "cgo_budget_review_error",
      message: "tenant t-1: goal-owner: daily count failed: timeout",
    });
    expect((log.mock.lastCall as unknown as [Record<string, unknown>])[0].tenant_id).toBeUndefined();
  });

  it("never throws when the log write fails", async () => {
    const broken = vi.fn(async () => {
      throw new Error("db down");
    });
    await expect(logJobError("ad-spend-controller", "tenant t: x", broken)).resolves.toBeUndefined();
  });
});

describe("persistingLogger", () => {
  it("keeps the job's own logger and also saves warn and error lines", async () => {
    const inner = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const log = vi.fn(async () => {});
    const l = persistingLogger("goal-reconcile", inner, log);
    l.warn("[goal-reconcile] tenant t threw: boom");
    l.error("goal-reconcile: tenant scan failed: boom");
    l.info("fine");
    expect(inner.warn).toHaveBeenCalledWith("[goal-reconcile] tenant t threw: boom");
    expect(inner.error).toHaveBeenCalledWith("goal-reconcile: tenant scan failed: boom");
    expect(inner.info).toHaveBeenCalledWith("fine");
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: "error", source: "goal-reconcile", code: "goal_reconcile_error" }));
  });
});
