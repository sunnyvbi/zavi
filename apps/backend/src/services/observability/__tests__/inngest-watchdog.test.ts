import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ fleetSweepClient: vi.fn() }));
vi.mock("@/services/logging/alert", () => ({ alert: vi.fn() }));

import {
  evaluateWatchdog,
  runWatchdogTick,
  DOCTOR_OK_MAX_AGE_MIN,
} from "../inngest-watchdog";

const NOW = Date.parse("2026-11-12T03:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("evaluateWatchdog", () => {
  it("is quiet when the doctor is fresh and nothing is stuck", () => {
    expect(evaluateWatchdog({ now: NOW, lastDoctorOkAt: minsAgo(40), stuckQueued: [] })).toEqual([]);
  });

  it("pages when no ok doctor row exists (the 2026-11-11 shape: the cron died with Inngest)", () => {
    const f = evaluateWatchdog({ now: NOW, lastDoctorOkAt: null, stuckQueued: [] });
    expect(f.map((x) => x.kind)).toEqual(["doctor_silent"]);
  });

  it("pages when the last ok doctor row is older than the limit", () => {
    const f = evaluateWatchdog({ now: NOW, lastDoctorOkAt: minsAgo(DOCTOR_OK_MAX_AGE_MIN + 1), stuckQueued: [] });
    expect(f[0].kind).toBe("doctor_silent");
    expect(f[0].msg).toContain("76 min");
  });

  it("pages on stuck interactive runs with ids and counts only", () => {
    const f = evaluateWatchdog({
      now: NOW,
      lastDoctorOkAt: minsAgo(10),
      stuckQueued: [
        { id: "run-a", tenant_id: "t1", enqueued_at: minsAgo(20) },
        { id: "run-b", tenant_id: "t2", enqueued_at: minsAgo(45) },
      ],
    });
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe("runs_stuck_queued");
    expect(f[0].msg).toBe("2 interactive run(s) queued over 15 min across 2 tenant(s), oldest 45 min");
    expect(f[0].detail).toContain("run-a, run-b");
  });
});

function fakeDb(doctor: unknown[], queued: unknown[], error: { message: string } | null = null) {
  const chain = (data: unknown[]) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "lt", "gte", "like", "order"]) q[m] = () => q;
    q.limit = async () => ({ data, error });
    return q;
  };
  return { from: (t: string) => chain(t === "praxis_logs" ? doctor : queued) } as never;
}

describe("runWatchdogTick", () => {
  it("pages once per kind per hour, then again after an hour", async () => {
    const page = vi.fn();
    const lastPaged = new Map();
    const db = fakeDb([], []);
    await runWatchdogTick(lastPaged, { db, page, nowFn: () => NOW });
    await runWatchdogTick(lastPaged, { db, page, nowFn: () => NOW + 5 * 60_000 });
    expect(page).toHaveBeenCalledTimes(1);
    expect(page.mock.calls[0][0]).toMatchObject({
      source: "inngest-watchdog",
      code: "inngest.watchdog.doctor_silent",
      email: expect.objectContaining({ dedupeKey: expect.stringContaining("doctor_silent") }),
    });
    await runWatchdogTick(lastPaged, { db, page, nowFn: () => NOW + 61 * 60_000 });
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("re-arms after recovery so the next outage pages at once", async () => {
    const page = vi.fn();
    const lastPaged = new Map();
    await runWatchdogTick(lastPaged, { db: fakeDb([], []), page, nowFn: () => NOW });
    await runWatchdogTick(lastPaged, { db: fakeDb([{ created_at: minsAgo(0) }], []), page, nowFn: () => NOW + 5 * 60_000 });
    await runWatchdogTick(lastPaged, { db: fakeDb([], []), page, nowFn: () => NOW + 10 * 60_000 });
    expect(page).toHaveBeenCalledTimes(2);
  });

  it("skips the tick and pages nothing when the read fails", async () => {
    const page = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await runWatchdogTick(new Map(), { db: fakeDb([], [], { message: "timeout" }), page, nowFn: () => NOW });
    expect(r).toEqual([]);
    expect(page).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
