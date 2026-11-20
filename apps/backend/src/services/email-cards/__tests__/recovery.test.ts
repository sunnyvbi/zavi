import { describe, expect, it, vi } from "vitest";
import { FANOUT_STALLED_REASON, RELEASED_EXPIRED_REASON, RELEASED_PAUSED_REASON, RELEASED_SENDER_STOPPED_REASON, runEmailSendRecovery } from "../recovery";

const T = "11111111-1111-4111-8111-111111111111";
const stalled = (over: Record<string, unknown> = {}) =>
  vi.fn(async () => ({ status: "held", hold_reason: "fanout_stalled", next_run_at: null, total: 400, sent: 120, skipped: 0, failed: 0, unknown: 0, pending: 280, sending: 0, complaints: 0, hard_bounces: 0, ...over }) as never);

describe("email send recovery (the */10 dispatch cron)", () => {
  it("re-fires released sends and stalled fan-outs with fresh event ids, and tells the approver when it gives up", async () => {
    const send = vi.fn(async () => {});
    const tell = vi.fn(async () => true);
    const rpc = vi.fn(async (name: string) =>
      name === "email_redispatch_released_sweep"
        ? [
            { action: "redispatch", tenant_id: T, decision_id: "d1", decision_class: "bulk_outbound.send", redispatch_key: "r1760000000000" },
            { action: "expired", tenant_id: T, decision_id: "d2", decision_class: "email_campaign.create_and_send" },
          ]
        : [
            { action: "refire", tenant_id: T, send_id: "s1", decision_id: "d3", attempt: 2 },
            { action: "give_up", tenant_id: T, send_id: "s2", decision_id: "d4", sent: 120, total: 400 },
          ],
    );
    const counts = stalled();
    const out = await runEmailSendRecovery({ rpc, send, tell, counts });
    expect(counts).toHaveBeenCalledWith(T, "s2");
    expect(out).toEqual({ redispatched: 1, expired: 1, refired: 1, gave_up: 1 });
    expect(send.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { id: "approve:d1:r1760000000000", name: "decision.approved", data: { decision_id: "d1", tenant_id: T, decision_class: "bulk_outbound.send" } },
      { id: "bulk-email-fanout:s1:recover:2", name: "bulk-email/fanout.requested", data: { send_id: "s1" } },
    ]);
    expect(tell.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { tenant_id: T, rail: "decisions", card_id: "d2", outcome: "failed", sent: 0, reason: RELEASED_EXPIRED_REASON },
      { tenant_id: T, rail: "decisions", card_id: "d4", outcome: "failed", sent: 120, total: 400, reason: FANOUT_STALLED_REASON },
    ]);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["email_redispatch_released_sweep", "email_bulk_stalled_sends"]);
  });

  it("a failed tell does not stop the sweep", async () => {
    const send = vi.fn(async () => {});
    const tell = vi.fn(async () => {
      throw new Error("mail down");
    });
    const rpc = vi.fn(async (name: string) => (name === "email_bulk_stalled_sends" ? [{ action: "give_up", tenant_id: T, send_id: "s2", decision_id: "d4", sent: 0, total: 3 }, { action: "refire", tenant_id: T, send_id: "s5", decision_id: "d5", attempt: 1 }] : []));
    expect(await runEmailSendRecovery({ rpc, send, tell, counts: stalled() })).toEqual({ redispatched: 0, expired: 0, refired: 1, gave_up: 1 });
  });

  it("a given-up send that emailed nobody for sure but may have reached some is told as unknown, the way the fanout tells it", async () => {
    const tell = vi.fn(async () => true);
    const rpc = vi.fn(async (name: string) => (name === "email_bulk_stalled_sends" ? [{ action: "give_up", tenant_id: T, send_id: "s2", decision_id: "d4", sent: 0, total: 3 }] : []));
    await runEmailSendRecovery({ rpc, send: async () => {}, tell, counts: stalled({ total: 3, sent: 0, unknown: 2, pending: 1 }) });
    expect(tell.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { tenant_id: T, rail: "decisions", card_id: "d4", outcome: "unknown", sent: 0, total: 3, reason: FANOUT_STALLED_REASON },
    ]);
  });

  it("the given-up line uses the recounted numbers, and falls back to the sweep's own when the recount fails", async () => {
    const rpc = vi.fn(async (name: string) => (name === "email_bulk_stalled_sends" ? [{ action: "give_up", tenant_id: T, send_id: "s2", decision_id: "d4", sent: 1, total: 3 }] : []));
    const tell = vi.fn(async () => true);
    await runEmailSendRecovery({ rpc, send: async () => {}, tell, counts: stalled({ total: 3, sent: 2 }) });
    await runEmailSendRecovery({ rpc, send: async () => {}, tell, counts: vi.fn(async () => { throw new Error("db down"); }) });
    expect(tell.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { tenant_id: T, rail: "decisions", card_id: "d4", outcome: "failed", sent: 2, total: 3, reason: FANOUT_STALLED_REASON },
      { tenant_id: T, rail: "decisions", card_id: "d4", outcome: "failed", sent: 1, total: 3, reason: FANOUT_STALLED_REASON },
    ]);
  });

  it("puts failed recovery enqueues back so the next sweep can retry them", async () => {
    const rpc = vi.fn(async (name: string) =>
      name === "email_redispatch_released_sweep"
        ? [{ action: "redispatch", tenant_id: T, decision_id: "d1", decision_class: "bulk_outbound.send", redispatch_key: "r1" }]
        : name === "email_bulk_stalled_sends"
          ? [{ action: "refire", tenant_id: T, send_id: "s1", decision_id: "d1", attempt: 2 }]
          : true,
    );
    const send = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    expect(await runEmailSendRecovery({ rpc, send, tell: async () => true })).toEqual({ redispatched: 0, expired: 0, refired: 0, gave_up: 0 });
    expect(rpc).toHaveBeenCalledWith("email_redispatch_enqueue_failed", { p_tenant_id: T, p_decision_id: "d1", p_redispatch_key: "r1" });
    expect(rpc).toHaveBeenCalledWith("email_bulk_refire_enqueue_failed", { p_tenant_id: T, p_send_id: "s1", p_attempt: 2 });
  });

  it("an approval held by the email pause past a day tells the approver it was the pause, not a failure to start", async () => {
    const tell = vi.fn(async () => true);
    const rpc = vi.fn(async (name: string) =>
      name === "email_redispatch_released_sweep"
        ? [
            { action: "expired", tenant_id: T, decision_id: "p1", decision_class: "bulk_outbound.send", paused: true },
            { action: "expired", tenant_id: T, decision_id: "p2", decision_class: "bulk_outbound.send", paused: false },
          ]
        : [],
    );
    expect(await runEmailSendRecovery({ rpc, send: async () => {}, tell })).toMatchObject({ expired: 2 });
    const reasons = tell.mock.calls.map((c) => ((c as unknown[])[0] as { card_id: string; reason: string }));
    expect(reasons).toEqual([
      expect.objectContaining({ card_id: "p1", reason: RELEASED_PAUSED_REASON }),
      expect.objectContaining({ card_id: "p2", reason: RELEASED_EXPIRED_REASON }),
    ]);
    expect(RELEASED_PAUSED_REASON).toMatch(/paused/);
  });

  it("an approval held by Zavi's stopped sender past a day tells the approver the sender was stopped, not a failure to start", async () => {
    const tell = vi.fn(async () => true);
    const rpc = vi.fn(async (name: string) =>
      name === "email_redispatch_released_sweep"
        ? [{ action: "expired", tenant_id: T, decision_id: "g1", decision_class: "bulk_outbound.send", paused: false, sender_stopped: true }]
        : [],
    );
    expect(await runEmailSendRecovery({ rpc, send: async () => {}, tell })).toMatchObject({ expired: 1 });
    expect(tell).toHaveBeenCalledTimes(1);
    expect(tell).toHaveBeenCalledWith(expect.objectContaining({ card_id: "g1", outcome: "failed", sent: 0, reason: RELEASED_SENDER_STOPPED_REASON }));
    expect(RELEASED_SENDER_STOPPED_REASON).not.toBe(RELEASED_EXPIRED_REASON);
  });
});
