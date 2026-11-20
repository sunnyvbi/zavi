import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  setting: vi.fn(),
  hold: vi.fn(),
  global: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.requireAuth }));
vi.mock("@/services/agents/email-send-tier", async (orig) => ({ ...(await orig<typeof import("@/services/agents/email-send-tier")>()), emailSendHttpRefusal: async () => null }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: m.setting, setTenantSetting: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("@/services/comms/bulk-outbound/thread-notice", () => ({ postBulkSendNotice: vi.fn(async () => true) }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  globalClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => m.global() }) }) }) }),
  tenantRpc: vi.fn(async () => ({ data: true, error: null })),
  tenantClient: () => ({
    from: (table: string) => {
      if (table !== "email_bulk_abuse_holds") throw new Error(`unexpected table ${table}`);
      return { select: () => ({ maybeSingle: () => m.hold() }) };
    },
  }),
}));

import { emailCardHandlers } from "@/routes/email-cards";
import { emailSendOutcomeLine } from "@/email/templates/email-send-outcome";
import { executeBulkOutboundDispatch } from "@/services/comms/bulk-outbound/dispatch";
import { BULK_REFUSAL_SENTENCES } from "@/services/comms/bulk-outbound/readiness";
import { DECISION, TENANT, harness } from "@/services/comms/bulk-outbound/__tests__/harness";
import { BULK_APPROVE_REFUSALS, type CardDeps } from "../cards";
import { bulkSendOutcome } from "../outcome";
import { rebuildSendOutcome } from "../outcome-rebuild";

const REQUEST = "req-12345678";

type Card = { class: string; status: string; open: boolean; retryable: boolean };

function world(o: Partial<Card> = {}) {
  const h = harness();
  const card: Card = { class: "bulk_outbound.send", status: "proposed", open: true, retryable: false, ...o };
  const approved: string[] = [];
  const enqueued: Array<{ id: string; name: string }> = [];
  const live = vi.fn(async () => 3);
  const deps: Partial<CardDeps> = {
    rpc: (async (_t: string, name: string, args: Record<string, unknown>) => {
      if (name === "email_card_view_state") return { ok: true, class: card.class, body: h.body({ variants: [] }), open: card.open, status: card.status, role: "owner", versions: 1, retryable: card.retryable, tests: [{ variant: 1, tested_by_me: true, tested_by_approver: true }] };
      if (name === "approve_email_card") {
        if (!card.open && !card.retryable) return card.status === "approved" ? { ok: true, changed: false, status: "approved" } : { ok: false, code: "not_open" };
        approved.push(String(args.p_event_key));
        card.status = "approved";
        card.open = false;
        card.retryable = false;
        return { ok: true, changed: true, status: "approved" };
      }
      throw new Error(`unexpected rpc ${name}`);
    }) as CardDeps["rpc"],
    liveCount: live,
    suppression: async () => null,
    paused: async () => false,
    enqueue: async (e) => {
      enqueued.push({ id: e.id, name: e.name });
    },
  };
  const handlers = emailCardHandlers(deps, async () => new Set<string>(), (async () => null) as never);
  const press = async (request_id = REQUEST) => {
    const r = {
      statusCode: 200,
      body: undefined as { error?: { code: string; message: string }; ok?: boolean; changed?: boolean } | undefined,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      json(b: never) {
        this.body = b;
        return this;
      },
    };
    await handlers.approve({ params: { rail: "decisions", id: DECISION }, body: { variant: 1, request_id } } as never, r as never);
    return r;
  };
  return { h, card, approved, enqueued, live, press };
}

const dispatch = (h: ReturnType<typeof harness>) => executeBulkOutboundDispatch({ tenant_id: TENANT, decision_id: DECISION, approved_by: "user-a", body: h.body(), deps: h.deps });

beforeEach(() => {
  vi.clearAllMocks();
  m.requireAuth.mockResolvedValue({ tenant_id: TENANT, user_id: "user-a" });
  m.setting.mockResolvedValue(true);
  m.hold.mockResolvedValue({ data: null, error: null });
  m.global.mockResolvedValue({ data: { blob: {} }, error: null });
});

function expectUntouched(w: ReturnType<typeof world>) {
  expect(w.approved).toEqual([]);
  expect(w.enqueued).toEqual([]);
  expect(w.card).toMatchObject({ status: "proposed", open: true });
  expect(w.h.ledger.sends.size).toBe(0);
  expect(w.h.wire).not.toHaveBeenCalled();
}

describe("Approve and send with bulk email off for the workspace", () => {
  it("is refused before the card is consumed, and no list read or send row follows", async () => {
    m.setting.mockResolvedValue(false);
    const w = world();
    const r = await w.press();
    expect(r.statusCode).toBe(409);
    expect(r.body?.error?.code).toBe("bulk_outbound_disabled");
    expect(r.body?.error?.message).toBe(BULK_APPROVE_REFUSALS.bulk_outbound_disabled);
    expect(r.body?.error?.message).toMatch(/^Bulk email is paused for this workspace/);
    expect(w.live).not.toHaveBeenCalled();
    expectUntouched(w);
  });

  it("an open abuse hold is refused in the abuse words, whichever way the setting reads", async () => {
    m.hold.mockResolvedValue({ data: { cleared_at: null }, error: null });
    for (const on of [false, true]) {
      m.setting.mockResolvedValue(on);
      const w = world();
      const r = await w.press();
      expect(r.body?.error?.code).toBe("bulk_abuse_hold");
      expect(r.body?.error?.message).toContain(BULK_REFUSAL_SENTENCES.bulk_abuse_hold);
      expect(r.body?.error?.message).not.toContain("switched off");
      expectUntouched(w);
    }
  });

  it("a cleared hold with the setting off still refuses as switched off, not as abuse", async () => {
    m.hold.mockResolvedValue({ data: { cleared_at: "2026-10-30T00:00:00Z" }, error: null });
    m.setting.mockResolvedValue(false);
    const w = world();
    expect((await w.press()).body?.error?.code).toBe("bulk_outbound_disabled");
    expectUntouched(w);
  });

  it("the setting read failing fails closed", async () => {
    m.setting.mockRejectedValue(new Error("setting read down"));
    const w = world();
    const r = await w.press();
    expect(r.statusCode).toBe(409);
    expect(r.body?.error?.code).toBe("bulk_check_failed");
    expect(r.body?.error?.message).toBe(BULK_APPROVE_REFUSALS.bulk_check_failed);
    expectUntouched(w);
  });

  it("the hold read failing fails closed even with the setting on, and a throwing read too", async () => {
    m.hold.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    const w = world();
    expect((await w.press()).body?.error?.code).toBe("bulk_check_failed");
    m.hold.mockRejectedValueOnce(new Error("socket"));
    expect((await w.press()).body?.error?.code).toBe("bulk_check_failed");
    expectUntouched(w);
  });

  it("a double click while off refuses both and consumes nothing", async () => {
    m.setting.mockResolvedValue(false);
    const w = world();
    const [a, b] = await Promise.all([w.press(), w.press()]);
    expect([a.statusCode, b.statusCode]).toEqual([409, 409]);
    expectUntouched(w);
  });

  it("sending back on lets the same card approve with the same request, once, and it sends", async () => {
    m.setting.mockResolvedValue(false);
    const w = world();
    await w.press();
    expectUntouched(w);
    m.setting.mockResolvedValue(true);
    const [a, b] = await Promise.all([w.press(), w.press()]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(w.approved).toEqual([REQUEST]);
    expect(new Set(w.enqueued.map((e) => e.id))).toEqual(new Set([`approve:${DECISION}`]));
    expect(await dispatch(w.h)).toMatchObject({ ok: true });
    expect(w.h.wire).toHaveBeenCalledTimes(3);
  });

  it("a Try again on a failed card is refused the same way and stays retryable", async () => {
    m.setting.mockResolvedValue(false);
    const w = world({ status: "failed", open: false, retryable: true });
    expect((await w.press()).body?.error?.code).toBe("bulk_outbound_disabled");
    expect(w.approved).toEqual([]);
    expect(w.card).toMatchObject({ status: "failed", retryable: true });
  });

  it("a replayed click on an already approved card is not re-judged by the switch", async () => {
    const w = world();
    await w.press();
    m.setting.mockResolvedValue(false);
    const r = await w.press();
    expect(r.statusCode).toBe(200);
    expect(w.approved).toEqual([REQUEST]);
  });

  it("non-regression guard: a card on the founder's own email tool is not held by the Zavi-list switch", async () => {
    m.setting.mockResolvedValue(false);
    const w = world({ class: "email_campaign.create_and_send" });
    const r = await w.press();
    expect(r.body?.error?.code).not.toBe("bulk_outbound_disabled");
    expect(m.setting).not.toHaveBeenCalled();
  });

  it("non-regression guard: the global sender stop stays the held-and-retried path, not an approve refusal", async () => {
    m.global.mockResolvedValue({ data: { blob: { bulk_email_send_enabled: false } }, error: null });
    const w = world();
    expect((await w.press()).statusCode).toBe(200);
    expect(m.global).not.toHaveBeenCalled();
  });
});

describe("the switch flipped after approve", () => {
  const refuseWhenOff = (h: ReturnType<typeof harness>, passes: number) => {
    const real = h.deps.checkReady;
    let left = passes;
    h.deps.checkReady = async (t, l, v) => {
      if (left-- > 0) return real(t, l, v);
      return { ok: false, code: "bulk_outbound_disabled", sentence: BULK_REFUSAL_SENTENCES.bulk_outbound_disabled };
    };
  };

  it("non-regression guard: off between approve and dispatch, the dispatch check emails nobody and writes no send row", async () => {
    const w = world();
    expect((await w.press()).statusCode).toBe(200);
    refuseWhenOff(w.h, 0);
    expect(await dispatch(w.h)).toMatchObject({ ok: false, status: "refused", code: "bulk_outbound_disabled" });
    expect(w.h.wire).not.toHaveBeenCalled();
    expect(w.h.ledger.sends.size).toBe(0);
  });

  it("off between the dispatch check and the first chunk: nobody is emailed, and the rebuilt approver line names the switch, not the provider", async () => {
    const w = world();
    await w.press();
    refuseWhenOff(w.h, 1);
    const r = await dispatch(w.h);
    expect(r).toMatchObject({ ok: false, status: "refused", code: "bulk_outbound_disabled" });
    expect(w.h.wire).not.toHaveBeenCalled();
    const send = [...w.h.ledger.sends.values()][0];
    expect(send.status).toBe("failed");
    const counts = await w.h.ledger.settleSend(TENANT, send.id, null);
    const rebuilt = await rebuildSendOutcome(TENANT, { rail: "decisions", card_id: DECISION, outcome: "failed" }, {
      readDecision: async () => ({ tenant_id: TENANT, decision_class: "bulk_outbound.send", status: "dispatch_failed", dispatch_error: "x" }),
      readBulkSend: async () => ({ id: send.id, tenant_id: TENANT, status: "failed" }),
      counts: async () => counts,
    });
    if (!rebuilt || "pending" in rebuilt) throw new Error("no outcome");
    expect(rebuilt.o.reason).toBe("Not sent: bulk email was switched off for this workspace, so nobody was emailed.");
    const line = emailSendOutcomeLine({ outcome: "failed", subject: "S", listName: "L", sent: rebuilt.o.sent, total: rebuilt.o.total ?? null, reason: rebuilt.o.reason ?? null });
    expect(line).not.toContain("provider");
    expect(line).toContain("switched off");
  });

  it("a second dispatch of that closed send does not blame the provider either", async () => {
    const w = world();
    await w.press();
    const ready = w.h.deps.checkReady;
    refuseWhenOff(w.h, 1);
    await dispatch(w.h);
    w.h.deps.checkReady = ready;
    const again = await dispatch(w.h);
    expect(again).toMatchObject({ ok: false, sentence: "Not sent: bulk email was switched off for this workspace, so nobody was emailed." });
    expect(w.h.wire).not.toHaveBeenCalled();
  });

  it("non-regression guard: a true provider refusal keeps its words on the told line", async () => {
    const w = world();
    await w.press();
    w.h.wire.mockResolvedValue({ kind: "stop_all", status: 401 } as never);
    await dispatch(w.h);
    const send = [...w.h.ledger.sends.values()][0];
    const counts = await w.h.ledger.settleSend(TENANT, send.id, null);
    const { bulkSendLine } = await import("@/services/comms/bulk-outbound/notices");
    expect(bulkSendOutcome(TENANT, DECISION, "failed", counts, bulkSendLine("failed", counts))?.reason).toBe("Not sent: the email provider refused every email, so nobody was emailed.");
  });
});
