import { describe, it, expect, vi, beforeEach } from "vitest";

const limit = vi.fn();
const alert = vi.fn();
const halted = vi.fn();
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => ({ select: () => ({ gte: () => ({ limit }) }) }) }),
}));
vi.mock("@/services/logging/alert", () => ({ alert: (...a: unknown[]) => alert(...a) }));
vi.mock("@/services/agents/fleet-halt", () => ({ isFleetHalted: () => halted() }));

import { assessCapacity, runInngestCapacityWatch } from "../inngest-capacity-watch";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();
const slow = { enqueued_at: ago(30), started_at: ago(27), status: "success" };
const fast = { enqueued_at: ago(30), started_at: ago(29.9), status: "success" };
const stuck = { enqueued_at: ago(10), started_at: null, status: "queued" };

beforeEach(() => {
  vi.clearAllMocks();
  halted.mockResolvedValue(false);
});

describe("assessCapacity", () => {
  it("counts slow starts and runs stuck in the queue", () => {
    const a = assessCapacity([slow, fast, stuck, { ...stuck, enqueued_at: ago(1) }], NOW);
    expect(a).toMatchObject({ slowStarts: 1, stuckQueued: 1, total: 4, alert: false });
  });
  it("alerts at 5 slow starts or 5 stuck runs", () => {
    expect(assessCapacity(Array(5).fill(slow), NOW).alert).toBe(true);
    expect(assessCapacity(Array(5).fill(stuck), NOW).alert).toBe(true);
    expect(assessCapacity(Array(4).fill(slow), NOW).alert).toBe(false);
  });
});

describe("runInngestCapacityWatch", () => {
  it("emails once a day with a plain explanation when runs are waiting", async () => {
    limit.mockResolvedValue({ data: Array(6).fill(slow), error: null });
    await runInngestCapacityWatch(NOW);
    expect(alert).toHaveBeenCalledTimes(1);
    const arg = alert.mock.calls[0]![0] as { email: { dedupeKey: string; detail: string } };
    expect(arg.email.dedupeKey).toBe("inngest_capacity:2026-10-13");
    expect(arg.email.detail).toMatch(/Billing/);
  });
  it("stays quiet when runs start promptly, when halted, and when the read fails", async () => {
    limit.mockResolvedValue({ data: Array(20).fill(fast), error: null });
    await runInngestCapacityWatch(NOW);
    halted.mockResolvedValue(true);
    await runInngestCapacityWatch(NOW);
    halted.mockResolvedValue(false);
    limit.mockResolvedValue({ data: null, error: { message: "down" } });
    await runInngestCapacityWatch(NOW);
    expect(alert).not.toHaveBeenCalled();
  });
});
