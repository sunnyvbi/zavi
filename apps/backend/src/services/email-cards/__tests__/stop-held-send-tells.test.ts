import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  settleSend: vi.fn(),
  markStaleUnknown: vi.fn(),
  notice: vi.fn(),
  notify: vi.fn(),
  inngestSend: vi.fn(),
}));
vi.mock("@/services/comms/bulk-outbound/store", () => ({ supabaseBulkSendStore: { settleSend: m.settleSend, markStaleUnknown: m.markStaleUnknown } }));
vi.mock("@/services/comms/bulk-outbound/thread-notice", () => ({ postBulkSendNotice: m.notice }));
vi.mock("@/../workers/client", () => ({ inngest: { send: m.inngestSend } }));
vi.mock("../outcome-tell", async (orig) => ({ ...(await orig<typeof import("../outcome-tell")>()), tellEmailSendOutcomeOrQueue: m.notify }));

import { stopEmailCardSend, type CardDeps } from "../cards";

const T = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";
const SEND = "33333333-3333-4333-8333-333333333333";

const held = { status: "held", hold_reason: "stopped", next_run_at: null, total: 400, sent: 120, skipped: 278, failed: 0, unknown: 2, pending: 0, sending: 0, complaints: 0, hard_bounces: 0 };

function rpc(stop: Record<string, unknown>): CardDeps["rpc"] {
  return (async (_t: string, name: string) => {
    if (name === "email_card_view_state") return { ok: true, class: "bulk_outbound.send", role: "owner" };
    if (name === "email_bulk_stop_send") return stop;
    throw new Error(`unexpected rpc ${name}`);
  }) as CardDeps["rpc"];
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.settleSend.mockResolvedValue(held);
  m.markStaleUnknown.mockResolvedValue(2);
  m.notice.mockResolvedValue(true);
  m.notify.mockResolvedValue(true);
  m.inngestSend.mockResolvedValue(undefined);
});

describe("Stop the rest tells the founder and the approver when no sender is running", () => {
  it("a send held while email was paused: the stale rows are settled first, then one thread notice and one approver outcome with the real count", async () => {
    const out = await stopEmailCardSend(T, "decisions", CARD, "u-owner", { rpc: rpc({ ok: true, stopped: 278, already_sent: 120, send_id: SEND, was: "held", was_reason: "email_paused" }) });
    expect(out).toEqual({ ok: true, stopped: 278, already_sent: 120 });
    expect(m.markStaleUnknown).toHaveBeenCalledWith(T, SEND, 120);
    expect(m.markStaleUnknown.mock.invocationCallOrder[0]).toBeLessThan(m.settleSend.mock.invocationCallOrder[0]);
    expect(m.settleSend).toHaveBeenCalledWith(T, SEND, null);
    const line = "Sent 120 of 400, then stopped: you stopped it. 278 people were not emailed. 2 could not be confirmed, so they were not sent again.";
    expect(m.notice).toHaveBeenCalledTimes(1);
    expect(m.notice).toHaveBeenCalledWith(T, SEND, line);
    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledWith({ tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed", sent: 120, total: 400, reason: line });
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it.each(["abuse_complaints", "abuse_bounces", "provider_refused", "bulk_check_failed"])("a send held for %s (told nobody yet) is told on stop", async (was_reason) => {
    await stopEmailCardSend(T, "decisions", CARD, "u-owner", { rpc: rpc({ ok: true, stopped: 1, already_sent: 120, send_id: SEND, was: "held", was_reason }) });
    expect(m.notice).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledTimes(1);
  });

  it("a send waiting for tomorrow's allowance wakes its sender with the stop event and tells nobody here (the sender tells once)", async () => {
    await stopEmailCardSend(T, "decisions", CARD, "u-owner", { rpc: rpc({ ok: true, stopped: 278, already_sent: 120, send_id: SEND, was: "waiting_for_tomorrow", was_reason: null }) });
    expect(m.inngestSend).toHaveBeenCalledWith({ id: `bulk-email-fanout:${SEND}:stopped`, name: "bulk-email/fanout.stopped", data: { send_id: SEND } });
    expect(m.notice).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("a send still going, or one already told for a hold nobody can resume, is told by nobody here", async () => {
    for (const [was, was_reason] of [["sending", null], ["held", "list_archived"], ["held", "stopped"]]) {
      await stopEmailCardSend(T, "decisions", CARD, "u-owner", { rpc: rpc({ ok: true, stopped: 0, already_sent: 120, send_id: SEND, was, was_reason }) });
    }
    expect(m.inngestSend).not.toHaveBeenCalled();
    expect(m.notice).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
  });

  it("a failure telling or waking never turns a done stop into an error", async () => {
    m.settleSend.mockRejectedValue(new Error("db down"));
    m.inngestSend.mockRejectedValue(new Error("inngest down"));
    const a = await stopEmailCardSend(T, "decisions", CARD, "u-owner", { rpc: rpc({ ok: true, stopped: 3, already_sent: 1, send_id: SEND, was: "held", was_reason: "email_paused" }) });
    const b = await stopEmailCardSend(T, "decisions", CARD, "u-owner", { rpc: rpc({ ok: true, stopped: 3, already_sent: 1, send_id: SEND, was: "waiting_for_tomorrow", was_reason: null }) });
    expect(a).toEqual({ ok: true, stopped: 3, already_sent: 1 });
    expect(b).toEqual({ ok: true, stopped: 3, already_sent: 1 });
  });
});
