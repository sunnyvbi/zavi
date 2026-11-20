import { describe, it, expect, vi } from "vitest";

vi.mock("../../client", () => ({ inngest: { createFunction: (...a: unknown[]) => ({ args: a }) } }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/comms/bulk-outbound/fanout", () => ({ defaultFanoutDeps: vi.fn(), runBulkChunk: vi.fn() }));
vi.mock("@/services/comms/bulk-outbound/thread-notice", () => ({ postBulkSendNotice: vi.fn() }));

import { bulkEmailFanoutFn, runBulkEmailFanout, type FanoutStep } from "../bulk-email-fanout";
import type { ChunkResult } from "@/services/comms/bulk-outbound/fanout";
import type { SendCounts } from "@/services/comms/bulk-outbound/store";

const SEND = "00000000-0000-4000-8000-000000000001";
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const counts = (over: Partial<SendCounts>): SendCounts => ({
  status: "sending", hold_reason: null, next_run_at: null, total: 250, sent: 0, skipped: 0, failed: 0, unknown: 0,
  pending: 0, sending: 0, complaints: 0, hard_bounces: 0, ...over,
});

function fakeStep() {
  const log: string[] = [];
  const step: FanoutStep = {
    run: async (id, fn) => {
      log.push(`run:${id}`);
      return fn();
    },
    sleep: async (id, d) => {
      log.push(`sleep:${id}:${d}`);
    },
    waitForEvent: async (id, opts) => {
      log.push(`waitForEvent:${id}:${opts.event}:${opts.timeout.toISOString()}:${opts.if}`);
      return null;
    },
    sendEvent: async (id, payload) => {
      log.push(`sendEvent:${id}:${JSON.stringify(payload)}`);
      return null;
    },
  };
  return { step, log };
}

describe("bulk-email-fanout", () => {
  it("a send still going when this run's rounds run out is handed to a fresh run of the same send, and nobody is told it ended", async () => {
    const { step, log } = fakeStep();
    let n = 0;
    const runChunk = vi.fn(async (): Promise<ChunkResult> => {
      n += 1;
      return { state: "waiting_for_tomorrow", counts: counts({ status: "waiting_for_tomorrow", sent: 10 * n, pending: 1000 - 10 * n, total: 1000, next_run_at: `2026-12-${String((n % 28) + 1).padStart(2, "0")}T00:05:00.000Z` }) };
    });
    const notify = vi.fn(async () => true);
    const tell = vi.fn(async () => true);
    const out = await runBulkEmailFanout(SEND, step, {
      resolveSend: async () => ({ tenant_id: TENANT, status: "sending", next_run_at: null }),
      runChunk,
      notify,
      tell,
    });
    expect(out).toEqual({ ok: true, state: "continued" });
    expect(runChunk).toHaveBeenCalledTimes(60);
    expect(notify).not.toHaveBeenCalled();
    expect(tell).not.toHaveBeenCalled();
    const sent = log.filter((l) => l.startsWith("sendEvent:"));
    expect(sent).toEqual([
      `sendEvent:continue:${JSON.stringify({ id: `bulk-email-fanout:${SEND}:continue:600-0-0-0-400`, name: "bulk-email/fanout.requested", data: { send_id: SEND } })}`,
    ]);
    expect(log[log.length - 1]).toBe(sent[0]);
  });

  it("re-derives the tenant from the send row and pauses 5 minutes before every chunk", async () => {
    const { step, log } = fakeStep();
    const chunks: ChunkResult[] = [
      { state: "more", counts: counts({ sent: 200, pending: 50 }) },
      { state: "done", counts: counts({ status: "done", sent: 250 }) },
    ];
    const runChunk = vi.fn(async () => chunks.shift()!);
    const notify = vi.fn(async () => true);
    const out = await runBulkEmailFanout(SEND, step, {
      resolveSend: async () => ({ tenant_id: TENANT, status: "sending", next_run_at: null }),
      runChunk,
      notify,
    });
    expect(out).toEqual({ ok: true, state: "done" });
    expect(runChunk).toHaveBeenCalledWith(TENANT, SEND);
    expect(log).toEqual(["run:resolve-send", "sleep:pause-0:5m", "run:chunk-0", "sleep:pause-1:5m", "run:chunk-1", "run:notify"]);
    expect(notify).toHaveBeenCalledWith(TENANT, SEND, "Sent to 250.");
  });

  it("waits until the next day when today's allowance is used up", async () => {
    const { step, log } = fakeStep();
    const chunks: ChunkResult[] = [
      { state: "waiting_for_tomorrow", counts: counts({ status: "waiting_for_tomorrow", sent: 150, pending: 100, next_run_at: "2026-10-09T00:05:00.000Z" }) },
      { state: "done", counts: counts({ status: "done", sent: 250 }) },
    ];
    await runBulkEmailFanout(SEND, step, {
      resolveSend: async () => ({ tenant_id: TENANT, status: "waiting_for_tomorrow", next_run_at: "2026-10-08T00:05:00.000Z" }),
      runChunk: async () => chunks.shift()!,
      notify: async () => true,
    });
    expect(log).toEqual([
      "run:resolve-send",
      `waitForEvent:wait-for-allowance-0:bulk-email/fanout.stopped:2026-10-08T00:05:00.000Z:async.data.send_id == "${SEND}"`,
      "run:chunk-0",
      `waitForEvent:wait-for-allowance-1:bulk-email/fanout.stopped:2026-10-09T00:05:00.000Z:async.data.send_id == "${SEND}"`,
      "run:chunk-1",
      "run:notify",
    ]);
  });

  it("a stop during the wait for tomorrow's allowance ends the wait at once and the founder and approver are told then", async () => {
    const waits: Array<{ id: string; event: string; timeout: string; if: string }> = [];
    const step: FanoutStep = {
      run: async (_id, fn) => fn(),
      sleep: async () => {},
      waitForEvent: async (id, opts) => {
        waits.push({ id, event: opts.event, timeout: opts.timeout.toISOString(), if: opts.if });
        return { name: "bulk-email/fanout.stopped", data: { send_id: SEND } };
      },
      sendEvent: async () => null,
    };
    const stopped = counts({ status: "held", hold_reason: "stopped", sent: 50, skipped: 200, pending: 0 });
    const runChunk = vi.fn(async (): Promise<ChunkResult> => ({ state: "held", counts: stopped }));
    const notify = vi.fn(async () => true);
    const tell = vi.fn(async () => true);
    const out = await runBulkEmailFanout(SEND, step, {
      resolveSend: async () => ({ tenant_id: TENANT, status: "waiting_for_tomorrow", next_run_at: "2026-10-29T00:05:00.000Z" }),
      runChunk,
      notify,
      tell,
    });
    expect(out).toEqual({ ok: true, state: "held" });
    expect(waits).toEqual([{ id: "wait-for-allowance-0", event: "bulk-email/fanout.stopped", timeout: "2026-10-29T00:05:00.000Z", if: `async.data.send_id == "${SEND}"` }]);
    expect(notify).toHaveBeenCalledWith(TENANT, SEND, "Sent 50 of 250, then stopped: you stopped it. 200 people were not emailed.");
    expect(tell).toHaveBeenCalledWith(TENANT, SEND, "held", stopped, "Sent 50 of 250, then stopped: you stopped it. 200 people were not emailed.");
  });

  it("stops at a hold and tells the founder why", async () => {
    const { step } = fakeStep();
    const runChunk = vi.fn(async (): Promise<ChunkResult> => ({ state: "held", counts: counts({ status: "held", hold_reason: "list_archived", sent: 100, pending: 150 }) }));
    const notify = vi.fn(async () => true);
    const out = await runBulkEmailFanout(SEND, step, { resolveSend: async () => ({ tenant_id: TENANT, status: "sending", next_run_at: null }), runChunk, notify });
    expect(out).toEqual({ ok: true, state: "held" });
    expect(runChunk).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(TENANT, SEND, "Sent 100 of 250, then stopped: the contact list was archived. 150 people were not emailed.");
  });

  it("a send that ends with no email confirmed is not announced as sent, and the approver is told it may have gone out, never not sent", async () => {
    const { step } = fakeStep();
    const end = counts({ status: "done", sent: 0, unknown: 150, failed: 100 });
    const runChunk = vi.fn(async (): Promise<ChunkResult> => ({ state: "done", counts: end }));
    const notify = vi.fn(async () => true);
    const told: unknown[] = [];
    const { bulkSendOutcome } = await import("@/services/email-cards/outcome");
    const tell = vi.fn(async (t: string, _s: string, state: string, c: { sent: number; total: number; unknown?: number }, line: string) => {
      told.push(bulkSendOutcome(t, "dec-1", state, c, line));
    });
    await runBulkEmailFanout(SEND, step, { resolveSend: async () => ({ tenant_id: TENANT, status: "sending", next_run_at: null }), runChunk, notify, tell });
    const line = (notify.mock.calls[0] as unknown[])[2] as string;
    expect(line).not.toMatch(/^Sent|Sent to/);
    expect(line).not.toMatch(/Not sent|nobody was emailed/i);
    expect(line).toBe("Not confirmed: these emails may have gone out. The email provider did not confirm any of them, so Zavi will not send this email again and nobody gets it twice. 100 could not be sent. 150 could not be confirmed.");
    expect(told).toEqual([expect.objectContaining({ outcome: "unknown", sent: 0, total: 250 })]);
  });

  it("does nothing for a send that already ended in its first chunk, an unknown send or a malformed id", async () => {
    for (const status of ["done", "failed", "held"]) {
      const { step, log } = fakeStep();
      const runChunk = vi.fn();
      const notify = vi.fn();
      await runBulkEmailFanout(SEND, step, { resolveSend: async () => ({ tenant_id: TENANT, status, next_run_at: null }), runChunk, notify });
      expect(log).toEqual(["run:resolve-send"]);
      expect(runChunk).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    }
    const a = fakeStep();
    expect(await runBulkEmailFanout(SEND, a.step, { resolveSend: async () => null, runChunk: vi.fn(), notify: vi.fn() })).toEqual({ ok: false, error: "send_not_found" });
    const b = fakeStep();
    const resolveSend = vi.fn();
    expect(await runBulkEmailFanout("not-a-uuid", b.step, { resolveSend, runChunk: vi.fn(), notify: vi.fn() })).toEqual({ ok: false, error: "bad_send_id" });
    expect(resolveSend).not.toHaveBeenCalled();
  });

  it("is event-triggered (no cron) and runs one at a time per send", () => {
    const [opts, trigger] = (bulkEmailFanoutFn as unknown as { args: [Record<string, unknown>, Record<string, unknown>] }).args;
    expect(trigger).toEqual({ event: "bulk-email/fanout.requested" });
    expect(opts).toMatchObject({ id: "bulk-email-fanout", concurrency: { key: "event.data.send_id", limit: 1 } });
  });
});

describe("bulk-email-fanout after a rate limit", () => {
  it("backs off 15 minutes after a throttled chunk, then goes back to the 5-minute pace", async () => {
    const { step, log } = fakeStep();
    const chunks: ChunkResult[] = [
      { state: "more", counts: counts({ sent: 10, pending: 240 }), throttled: true },
      { state: "more", counts: counts({ sent: 110, pending: 140 }) },
      { state: "done", counts: counts({ status: "done", sent: 250 }) },
    ];
    const out = await runBulkEmailFanout(SEND, step, {
      resolveSend: async () => ({ tenant_id: TENANT, status: "sending", next_run_at: null }),
      runChunk: vi.fn(async () => chunks.shift()!),
      notify: vi.fn(async () => true),
    });
    expect(out).toEqual({ ok: true, state: "done" });
    expect(log.filter((l) => l.startsWith("sleep:"))).toEqual(["sleep:pause-0:5m", "sleep:pause-1:15m", "sleep:pause-2:5m"]);
  });
});
