import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  settleSend: vi.fn(),
  markStaleUnknown: vi.fn(),
  notice: vi.fn(),
  inngestSend: vi.fn(),
  claimed: new Map<string, string>(),
  held: new Set<string>(),
  sendAttempts: [] as string[],
  decision: null as null | { tenant_id: string; decision_class: string | null; status: string | null; dispatch_error: string | null },
  bulk: null as null | { id: string; tenant_id: string; status: "done" | "failed" | "held" | "sending" },
}));
vi.mock("@/services/comms/bulk-outbound/store", () => ({ supabaseBulkSendStore: { settleSend: m.settleSend, markStaleUnknown: m.markStaleUnknown } }));
vi.mock("@/services/comms/bulk-outbound/thread-notice", () => ({ postBulkSendNotice: m.notice }));
vi.mock("@/../workers/client", () => ({ inngest: { send: (e: unknown) => m.inngestSend(e) } }));
vi.mock("../outcome", async (orig) => {
  const real = await orig<typeof import("../outcome")>();
  const key = (rail: string, id: string, outcome: string, kind?: string) => `${rail}:${id}:${outcome}:${kind ?? ""}`;
  const deps: Partial<import("../outcome").OutcomeDeps> = {
    readCard: async () => ({ body: { variants: [{ content: { subject: "Spring sale" } }], chosen_variant: 1, list_name: "Members" }, approved_by: "u-admin", approved_by_source: null }),
    claim: async (_t, rail, id, outcome, line, kind) => {
      const k = key(rail, id, outcome, kind);
      if (m.held.has(k)) return false;
      m.held.add(k);
      const had = m.claimed.has(k);
      m.claimed.set(k, line);
      return had ? "reclaimed" : true;
    },
    keep: async (_t, rail, id, outcome, line, kind) => {
      const k = key(rail, id, outcome, kind);
      if (m.claimed.has(k)) return false;
      m.claimed.set(k, line);
      return true;
    },
    release: async (_t, rail, id, outcome, kind) => {
      m.held.delete(key(rail, id, outcome, kind));
    },
    emailOf: async () => "admin@northwind.test",
    ownerEmail: async () => "owner@northwind.test",
    send: async (to) => {
      m.sendAttempts.push(to);
      throw new Error("SendGrid 503");
    },
    startResults: async () => undefined,
  };
  return {
    ...real,
    tellEmailSendOutcome: (o: import("../outcome").SendOutcome) => real.tellEmailSendOutcome(o, deps),
    keepEmailSendOutcomeLine: (o: import("../outcome").SendOutcome) => real.keepEmailSendOutcomeLine(o, deps),
  };
});
vi.mock("../outcome-rebuild", async (orig) => {
  const real = await orig<typeof import("../outcome-rebuild")>();
  return {
    ...real,
    rebuildSendOutcome: (tenantId: string, ref: Parameters<typeof real.rebuildSendOutcome>[1]) =>
      real.rebuildSendOutcome(tenantId, ref, {
        readDecision: async () => m.decision,
        readBulkSend: async () => m.bulk,
        counts: async () => m.settleSend(),
      }),
  };
});

import { stopEmailCardSend, type CardDeps } from "../cards";
import { RELEASED_EXPIRED_REASON, runEmailSendRecovery } from "../recovery";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const CARD = "22222222-2222-4222-8222-222222222222";
const SEND = "33333333-3333-4333-8333-333333333333";
const KEY = `decisions:${CARD}:failed:`;
const TELL = { id: `email-send-outcome-tell:decisions:${CARD}:failed:`, name: "email-send-outcome/tell.requested", data: { tenant_id: T, rail: "decisions", card_id: CARD, outcome: "failed" } };

const held = { status: "held", hold_reason: "stopped", next_run_at: null, total: 400, sent: 120, skipped: 278, failed: 0, unknown: 2, pending: 0, sending: 0, complaints: 0, hard_bounces: 0 };

function rpc(stop: Record<string, unknown>): CardDeps["rpc"] {
  return (async (_t: string, name: string) => {
    if (name === "email_card_view_state") return { ok: true, class: "bulk_outbound.send", role: "owner" };
    if (name === "email_bulk_stop_send") return stop;
    throw new Error(`unexpected rpc ${name}`);
  }) as CardDeps["rpc"];
}

function recoveryRpc(released: unknown[], stalled: unknown[]) {
  return async (name: string) => {
    if (name === "email_redispatch_released_sweep") return released;
    if (name === "email_bulk_stalled_sends") return stalled;
    throw new Error(`unexpected rpc ${name}`);
  };
}

const tells = () => m.inngestSend.mock.calls.map((c) => c[0] as { name: string }).filter((e) => e.name === "email-send-outcome/tell.requested");

beforeEach(() => {
  for (const f of [m.settleSend, m.markStaleUnknown, m.notice, m.inngestSend]) f.mockReset();
  m.claimed.clear();
  m.held.clear();
  m.sendAttempts.length = 0;
  m.settleSend.mockResolvedValue(held);
  m.markStaleUnknown.mockResolvedValue(0);
  m.notice.mockResolvedValue(true);
  m.inngestSend.mockResolvedValue(undefined);
  m.decision = { tenant_id: T, decision_class: "bulk_outbound.send", status: "executed", dispatch_error: null };
  m.bulk = { id: SEND, tenant_id: T, status: "held" };
});

describe("Stop the rest: a notice that does not go out is queued, never lost", () => {
  const stop = () => stopEmailCardSend(T, "decisions", CARD, "u-owner", { rpc: rpc({ ok: true, stopped: 278, already_sent: 120, send_id: SEND, was: "held", was_reason: "email_paused" }) });

  it("a failed send queues one retry carrying only the card reference, and the claim is free for that retry", async () => {
    expect(await stop()).toEqual({ ok: true, stopped: 278, already_sent: 120 });
    expect(m.sendAttempts).toEqual(["admin@northwind.test"]);
    expect(tells()).toEqual([TELL]);
    expect(m.held.has(KEY)).toBe(false);
  });

  it("when the retry cannot be queued, the Growth-note line is kept", async () => {
    m.inngestSend.mockRejectedValue(new Error("inngest down"));
    await stop();
    expect(m.claimed.get(KEY)).toMatch(/Spring sale/);
  });
});

describe("the recovery sweep: a notice that does not go out is queued, never lost", () => {
  it("an expired approval queues its retry; with the queue down the line is kept", async () => {
    m.bulk = null;
    m.decision = { tenant_id: T, decision_class: "bulk_outbound.send", status: "dispatch_failed", dispatch_error: RELEASED_EXPIRED_REASON };
    const released = [{ action: "expired", tenant_id: T, decision_id: CARD, decision_class: "bulk_outbound.send" }];
    expect(await runEmailSendRecovery({ rpc: recoveryRpc(released, []), send: async () => undefined })).toMatchObject({ expired: 1 });
    expect(tells()).toEqual([TELL]);
    expect(m.held.has(KEY)).toBe(false);
    m.inngestSend.mockRejectedValue(new Error("inngest down"));
    await runEmailSendRecovery({ rpc: recoveryRpc(released, []), send: async () => undefined });
    expect(m.claimed.get(KEY)).toMatch(/Spring sale/);
  });

  it("a given-up stalled send queues its retry", async () => {
    m.settleSend.mockResolvedValue({ ...held, hold_reason: "fanout_stalled" });
    const stalled = [{ action: "give_up", send_id: SEND, tenant_id: T, decision_id: CARD, sent: 120, total: 400 }];
    expect(await runEmailSendRecovery({ rpc: recoveryRpc([], stalled), send: async () => undefined })).toMatchObject({ gave_up: 1 });
    expect(tells()).toEqual([TELL]);
  });

  it("a card row owned by another tenant is never queued: the line is kept under the caller's tenant", async () => {
    m.decision = { tenant_id: OTHER, decision_class: "bulk_outbound.send", status: "executed", dispatch_error: null };
    m.bulk = { id: SEND, tenant_id: OTHER, status: "held" };
    const stalled = [{ action: "give_up", send_id: SEND, tenant_id: T, decision_id: CARD, sent: 120, total: 400 }];
    m.settleSend.mockResolvedValue({ ...held, hold_reason: "fanout_stalled" });
    await runEmailSendRecovery({ rpc: recoveryRpc([], stalled), send: async () => undefined });
    expect(tells()).toEqual([]);
    expect(m.claimed.get(KEY)).toMatch(/Spring sale/);
  });
});
