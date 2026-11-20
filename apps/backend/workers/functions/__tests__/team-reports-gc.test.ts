import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../client", () => ({ inngest: { createFunction: (c: unknown, t: unknown, f: unknown) => ({ config: c, trigger: t, handler: f }) } }));
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({ rpc }) }));
vi.mock("@/services/settings", () => ({ getNumberSetting: vi.fn(async () => 400) }));
const { logs } = vi.hoisted(() => ({ logs: [] as Array<Record<string, unknown>> }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async (e: Record<string, unknown>) => { logs.push(e); }) }));

const { pings } = vi.hoisted(() => ({ pings: vi.fn(async () => ({ claimed: 1, sent: 1, skipped: 0, retried: 0, gave_up: 0, fenced: 0, batches: 1 })) }));
vi.mock("@/services/team-notes/report-pings", () => ({ drainTeamReportPings: pings }));

import { teamReportsGcFn, GC_BATCH, GC_MAX_BATCHES, PING_SWEEP_BATCH, PING_SWEEP_DEADLINE_MS } from "../team-reports-gc";

const f = teamReportsGcFn as unknown as { trigger: { cron: string }; handler: (c: unknown) => Promise<{ removed: number; batches: number }> };
const ctx = { logger: { info: () => {}, warn: vi.fn() } };
const batch = (deleted: number, backlog = 0, oldest = 0) => ({ data: { deleted, backlog, oldest_expired_seconds: oldest }, error: null });

beforeEach(() => { rpc.mockReset(); logs.length = 0; pings.mockClear(); delete process.env.PRAXIS_CONTAINER_ROLE; });

describe("team-reports-gc", () => {
  it("runs hourly", () => {
    expect(f.trigger.cron).toBe("15 * * * *");
  });

  it("loops batches until a batch deletes nothing, with the ledger retention from the registry", async () => {
    rpc.mockResolvedValueOnce(batch(GC_BATCH)).mockResolvedValueOnce(batch(GC_BATCH)).mockResolvedValueOnce(batch(0, 0, 0));
    const out = await f.handler(ctx);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenCalledWith("purge_expired_team_notes_v2", { p_limit: GC_BATCH, p_offer_days: 400 });
    expect(out).toEqual({ removed: 2 * GC_BATCH, batches: 3, pings: null });
  });

  it("stops at the batch cap and logs the backlog it left behind", async () => {
    rpc.mockResolvedValue(batch(GC_BATCH, 12345, 7200));
    const out = await f.handler(ctx);
    expect(out.batches).toBe(GC_MAX_BATCHES);
    const log = logs.find((l) => l.code === "team_notes.gc")!;
    expect(log.meta).toEqual({ purge_backlog: 12345, purge_oldest_age_s: 7200 });
  });

  it("an RPC error stops the loop and throws (Inngest retries the run)", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "lock timeout" } });
    await expect(f.handler(ctx)).rejects.toThrow("lock timeout");
  });

  it("safety net: on the prod container it delivers overdue pings a lost event missed", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    rpc.mockResolvedValueOnce(batch(0));
    const out = await f.handler(ctx) as unknown as { pings: { sent: number } };
    expect(pings).toHaveBeenCalledTimes(1);
    expect(pings).toHaveBeenCalledWith({}, { batchSize: PING_SWEEP_BATCH, maxBatches: 1, deadlineMs: PING_SWEEP_DEADLINE_MS });
    expect(PING_SWEEP_BATCH).toBeLessThanOrEqual(10);
    expect(PING_SWEEP_DEADLINE_MS).toBeLessThanOrEqual(10_000);
    expect(out.pings).toMatchObject({ sent: 1 });
  });

  it("off the prod container it never touches pings", async () => {
    rpc.mockResolvedValueOnce(batch(0));
    await f.handler(ctx);
    expect(pings).not.toHaveBeenCalled();
  });

  it("a failed ping sweep never fails the purge", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    pings.mockRejectedValueOnce(new Error("claim failed"));
    rpc.mockResolvedValueOnce(batch(3)).mockResolvedValueOnce(batch(0));
    const out = await f.handler(ctx) as unknown as { removed: number; pings: unknown };
    expect(out).toMatchObject({ removed: 3, pings: { error: "claim_failed" } });
  });

  it("the purge runs first: a purge error throws before any ping is touched", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    rpc.mockResolvedValueOnce({ data: null, error: { message: "lock timeout" } });
    await expect(f.handler(ctx)).rejects.toThrow("lock timeout");
    expect(pings).not.toHaveBeenCalled();
  });

  it("the sweep starts only after the purge loop finished", async () => {
    process.env.PRAXIS_CONTAINER_ROLE = "canonical";
    const order: string[] = [];
    rpc.mockImplementation(async () => { order.push("purge"); return batch(0); });
    pings.mockImplementationOnce(async () => { order.push("pings"); return { claimed: 0, sent: 0, skipped: 0, retried: 0, gave_up: 0, fenced: 0, batches: 1 }; });
    await f.handler(ctx);
    expect(order).toEqual(["purge", "pings"]);
  });
});
