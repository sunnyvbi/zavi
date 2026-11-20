import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({
  inngest: { createFunction: (config: unknown, triggers: unknown, handler: unknown) => ({ config, triggers, handler }) },
}));
const h = vi.hoisted(() => ({
  drain: vi.fn(async () => ({ claimed: 1, sent: 1, skipped: 0, retried: 0, gave_up: 0, fenced: 0, batches: 1 })),
  dueAt: vi.fn(async (_id: number): Promise<string | null> => null),
}));
vi.mock("@/services/team-notes/report-pings", () => ({
  TEAM_REPORT_PING_DUE_EVENT: "team_report_ping.due",
  drainTeamReportPings: h.drain,
  pingDueAt: h.dueAt,
}));

import { MAX_ROUNDS, teamReportPingsDrainFn } from "../team-report-pings-drain";

const fn = teamReportPingsDrainFn as unknown as {
  config: Record<string, unknown>;
  triggers: unknown;
  handler: (ctx: unknown) => Promise<unknown>;
};
const calls: string[] = [];
const ctx = (data: Record<string, unknown>) => ({
  event: { name: "team_report_ping.due", data },
  step: {
    run: async (n: string, f: () => unknown) => { calls.push(`run:${n}`); return f(); },
    sleepUntil: vi.fn(async (n: string, at: string) => { calls.push(`sleep:${n}:${at}`); }),
  },
  logger: { info: vi.fn(), warn: vi.fn() },
});

afterEach(() => {
  delete process.env.PRAXIS_CONTAINER_ROLE;
  h.drain.mockClear();
  h.dueAt.mockReset();
  calls.length = 0;
});

describe("team-report-pings-drain", () => {
  it("is event-driven (no cron), one run per ping row, its own concurrency key, retries 1", () => {
    expect(fn.triggers).toEqual({ event: "team_report_ping.due" });
    expect(JSON.stringify(fn.triggers)).not.toContain("cron");
    expect(fn.config).toMatchObject({
      id: "team-report-pings-drain", retries: 1, idempotency: "event.data.ping_id",
      concurrency: { limit: 1, key: '"team-report-pings"' },
    });
  });

  it("re-reads the due time from the DB, sleeps until the window ends, then drains", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    h.dueAt.mockResolvedValueOnce("2026-10-18T10:10:00Z").mockResolvedValueOnce(null);
    const out = await fn.handler(ctx({ ping_id: 42, due_at: "1999-01-01T00:00:00Z" }));
    expect(h.dueAt).toHaveBeenCalledWith(42);
    expect(calls).toEqual(["run:due-at", "sleep:wait-0:2026-10-18T10:10:00Z", "run:drain-0", "run:due-at-1"]);
    expect(out).toEqual({ ping_id: 42, rounds: 1, sent: 1, settled: true });
  });

  it("a ping that is still pending after the drain (backing off) is followed to its retry", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    h.dueAt.mockResolvedValueOnce("2026-10-18T10:10:00Z").mockResolvedValueOnce("2026-10-18T10:11:00Z").mockResolvedValueOnce(null);
    const out = await fn.handler(ctx({ ping_id: 7 }));
    expect(h.drain).toHaveBeenCalledTimes(2);
    expect(calls).toContain("sleep:wait-1:2026-10-18T10:11:00Z");
    expect(out).toMatchObject({ rounds: 2, settled: true });
  });

  it("stops after MAX_ROUNDS even if the row never settles", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    h.dueAt.mockResolvedValue("2026-10-18T10:10:00Z");
    const out = await fn.handler(ctx({ ping_id: 7 }));
    expect(h.drain).toHaveBeenCalledTimes(MAX_ROUNDS);
    expect(out).toMatchObject({ rounds: MAX_ROUNDS, settled: false });
  });

  it("an already settled ping (or a missing row) drains nothing", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    h.dueAt.mockResolvedValueOnce(null);
    expect(await fn.handler(ctx({ ping_id: 7 }))).toMatchObject({ rounds: 0, settled: true });
    expect(h.drain).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ ping_id: "x" }], [{ ping_id: -1 }], [{ ping_id: 1.5 }]])("a bad event %j is ignored", async (data) => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    expect(await fn.handler(ctx(data))).toEqual({ skipped: "bad_event" });
    expect(h.dueAt).not.toHaveBeenCalled();
  });

  it("does nothing off the prod container", async () => {
    await expect(fn.handler(ctx({ ping_id: 1 }))).resolves.toEqual({ skipped: "not_canonical" });
    expect(h.drain).not.toHaveBeenCalled();
  });
});
