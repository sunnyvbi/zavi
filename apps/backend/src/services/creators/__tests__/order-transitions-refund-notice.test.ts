import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id?: string };
let rows: Row[] = [];

function fakeFrom(_table: string) {
  return {
    insert(row: Row) {
      return {
        select: () => ({
          single: async () => {
            const key = row.dedupe_key;
            if (key && rows.some((r) => r.dedupe_key === key)) {
              return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
            }
            const stored: Row = { id: `n${rows.length + 1}`, ...row };
            rows.push(stored);
            return { data: { id: stored.id }, error: null };
          },
        }),
      };
    },
    update(values: Row) {
      return {
        eq: async (_col: string, val: unknown) => {
          const r = rows.find((x) => x.id === val);
          if (r) Object.assign(r, values);
          return { error: null };
        },
      };
    },
  };
}

const sgSend = vi.fn(async (..._a: unknown[]) => {});

vi.mock("@/services/tenant-client", () => ({
  creatorInboxClient: () => ({ from: (t: string) => fakeFrom(t) }),
}));
vi.mock("@/services/humans/store", () => ({
  readPii: async (id: string) => ({ human_member_id: id, legal_name: "A Creator", email: "creator@example.com" }),
}));
vi.mock("@/services/notifications/agent-email-recipients", () => ({
  resolveAgentEmailRecipients: async () => [{ email: "owner@business.test", is_owner: true, id: null, label: "Owner" }],
}));
vi.mock("@/email/sendAuthEmail", () => ({ sgSend: (...a: unknown[]) => sgSend(...a) }));

import { applyCreatorOrderTransition, type CreatorOrderDeps } from "../order-transitions";
import { notify, notifyBothSides, sendWindowReminder } from "../notify";
import type { CreatorOrderStateRow } from "../orders-db";
import type { CreatorOrderTrigger } from "../order-state";

const TENANT = "11111111-1111-1111-1111-111111111111";
const ORDER = "22222222-2222-2222-2222-222222222222";
const CREATOR = "33333333-3333-3333-3333-333333333333";
const T0 = "2026-09-11T00:00:00.000Z";

function makeOrder(over: Partial<CreatorOrderStateRow> = {}): CreatorOrderStateRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "booking",
    status: "in_progress",
    closed_reason: null,
    created_at: T0,
    due_at: "2026-09-01T00:00:00.000Z",
    extension_requested_due_at: null,
    extension_state: null,
    next_deadline_at: null,
    next_deadline_kind: null,
    responded_at: null,
    accepted_at: null,
    cancel_requested_at: null,
    status_before_cancel_request: null,
    closed_at: null,
    payout_status: "not_due",
    payout_ready_at: null,
    payout_amount_cents: null,
    price_cents: 15_000,
    business_fee_cents: 1_500,
    creator_fee_cents: 2_250,
    business_total_cents: 16_500,
    creator_payout_cents: 12_750,
    package_snapshot: { title: "3 ad videos", creator_country_code: "US" },
    livemode: false,
    ...over,
  };
}

const SENT = {
  refund_id: "re_1",
  refunded_cents: 16_500,
  already_refunded: false,
  reversed_cents: 0,
  reversal_shortfall_cents: 0,
  needs_staff_review: false,
};
const BLOCKED = {
  refund_id: null,
  refunded_cents: 0,
  already_refunded: false,
  reversed_cents: 0,
  reversal_shortfall_cents: 0,
  needs_staff_review: true,
  blocked_reason: "charge_disputed",
};
const ALREADY_EMPTY = {
  refund_id: null,
  refunded_cents: 0,
  already_refunded: true,
  reversed_cents: 0,
  reversal_shortfall_cents: 0,
  needs_staff_review: false,
};
const ALREADY_REPLAY = { ...SENT, already_refunded: true };

type Alert = { source: string; code?: string; tenant_id?: string | null; msg: string; email?: { dedupeKey: string } };

function world(
  initial: CreatorOrderStateRow,
  opts: { refund?: unknown; transfer?: "ok" | "throws" | "claim_lost"; disputeOpen?: boolean } = {},
) {
  let order = { ...initial };
  const alerts: Alert[] = [];
  const deps: CreatorOrderDeps = {
    now: () => new Date("2026-09-20T00:00:00.000Z"),
    log: (async () => {}) as unknown as CreatorOrderDeps["log"],
    alert: (async (a: Alert) => {
      alerts.push(a);
    }) as unknown as CreatorOrderDeps["alert"],
    loadOrder: async () => ({ ...order }),
    writeOrder: (async (a: { expected_status: string; patch: Partial<CreatorOrderStateRow> }) => {
      if (order.status !== a.expected_status) return null;
      order = { ...order, ...a.patch } as CreatorOrderStateRow;
      return { ...order };
    }) as unknown as CreatorOrderDeps["writeOrder"],
    latestSubmissionAt: async () => null,
    submissionRounds: async () => 0,
    openDispute: async () => "opened",
    resolveDispute: async () => 1,
    hasOpenDispute: async () => opts.disputeOpen ?? false,
    markMissedDeadline: async () => 1,
    money: {
      capture: (async () => {
        throw new Error("no capture here");
      }) as unknown as CreatorOrderDeps["money"]["capture"],
      cancelHold: (async () => {
        throw new Error("no cancelHold here");
      }) as unknown as CreatorOrderDeps["money"]["cancelHold"],
      refund: (async () => opts.refund ?? SENT) as unknown as CreatorOrderDeps["money"]["refund"],
      transfer: (async () => {
        if (opts.transfer === "throws") throw new Error("Stripe connection reset");
        if (opts.transfer === "claim_lost") return { ok: false, reason: "claim_lost", message: "another worker" };
        return { ok: true, transfer_id: "tr_1", amount_cents: 12_750, already_transferred: false, recorded: true };
      }) as unknown as CreatorOrderDeps["money"]["transfer"],
    },
    notify: { notify, notifyBothSides, sendWindowReminder } as unknown as CreatorOrderDeps["notify"],
    businessName: async () => "UpcarAI",
    priorCompletedWithCreator: async () => false,
    armDeadline: async () => {},
    armPayoutBuffer: async () => {},
  };
  return { deps, alerts, row: () => order };
}

function run(
  w: ReturnType<typeof world>,
  trigger: CreatorOrderTrigger,
  extra: Partial<Parameters<typeof applyCreatorOrderTransition>[0]> = {},
) {
  return applyCreatorOrderTransition({ tenant_id: TENANT, order_id: ORDER, trigger, ...extra }, w.deps);
}

function tenantText(event: string): string {
  const r = rows.find((x) => x.recipient_kind === "tenant" && x.kind === event);
  if (!r) throw new Error(`no tenant row for ${event}; rows: ${rows.map((x) => `${x.recipient_kind}:${x.kind}`).join(",")}`);
  const mails = sgSend.mock.calls
    .filter((c) => c[0] === "owner@business.test")
    .map((c) => String(c[2]))
    .join("\n");
  if (!mails) throw new Error(`no tenant email for ${event}`);
  return `${String(r.title)}\n${String(r.body)}\n${mails}`;
}

const CLAIMS_MONEY_BACK = /goes back to (the|your) card|agreed amount/i;

beforeEach(() => {
  rows = [];
  sgSend.mockClear();
});

describe("a refund blocked by a card dispute is never announced as sent", () => {
  it("no_show: the business is told the refund is on hold, and staff are paged", async () => {
    const w = world(makeOrder(), { refund: BLOCKED });
    const res = await run(w, "no_show", { actor: "system" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.needs_staff_review).toBe(true);
    const text = tenantText("cancellation_outcome");
    expect(text).not.toMatch(CLAIMS_MONEY_BACK);
    expect(text).not.toContain("$165.00");
    expect(text).toContain("The refund is on hold because there is a chargeback on this payment with your bank, so the refund can't be sent through Zavi.");
    expect(text).not.toMatch(/open dispute/i);
    expect(text).toContain("Zavi staff will follow up");
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].code).toBe("creator_order_needs_staff");
    expect(w.alerts[0].tenant_id).toBe(TENANT);
    expect(w.alerts[0].msg).toContain(ORDER);
    expect(w.alerts[0].msg).toContain("no_show");
    expect(w.alerts[0].msg).toContain("refund_charge_disputed");
    expect(w.alerts[0].email?.dedupeKey).toBe(`creator_order_needs_staff:${ORDER}:no_show`);
  });

  it("cancel_agreed by the creator: same honest copy, and staff are paged because nobody else is looking", async () => {
    const w = world(makeOrder({ status: "cancel_requested", cancel_requested_at: "2026-09-19T00:00:00.000Z", status_before_cancel_request: "in_progress" }), {
      refund: BLOCKED,
    });
    const res = await run(w, "cancel_agreed", { actor: "creator" });
    expect(res.ok).toBe(true);
    expect(tenantText("cancellation_outcome")).not.toMatch(CLAIMS_MONEY_BACK);
    expect(tenantText("cancellation_outcome")).not.toMatch(/open dispute/i);
    expect(w.alerts.map((a) => a.code)).toEqual(["creator_order_needs_staff"]);
  });

  it("mediation_pay_part with a blocked refund stops before the order, the dispute or the creator's payout move", async () => {
    const w = world(makeOrder({ status: "in_dispute" }), { refund: BLOCKED, disputeOpen: true });
    const transfer = vi.fn(w.deps.money.transfer);
    const resolveDispute = vi.fn(w.deps.resolveDispute);
    const writeOrder = vi.fn(w.deps.writeOrder);
    const armDeadline = vi.fn(w.deps.armDeadline);
    const armPayoutBuffer = vi.fn(w.deps.armPayoutBuffer);
    w.deps.money.transfer = transfer;
    w.deps.resolveDispute = resolveDispute;
    w.deps.writeOrder = writeOrder;
    w.deps.armDeadline = armDeadline;
    w.deps.armPayoutBuffer = armPayoutBuffer;
    const res = await run(w, "mediation_pay_part", {
      actor: "staff",
      creator_amount_cents: 7_500,
      refund_amount_cents: 5_000,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("money_needs_staff");
    expect(transfer).not.toHaveBeenCalled();
    expect(resolveDispute).not.toHaveBeenCalled();
    expect(writeOrder).not.toHaveBeenCalled();
    expect(armDeadline).not.toHaveBeenCalled();
    expect(armPayoutBuffer).not.toHaveBeenCalled();
    expect(w.row().status).toBe("in_dispute");
    expect(w.row().payout_amount_cents).toBeNull();
    expect(rows).toEqual([]);
    expect(sgSend).not.toHaveBeenCalled();
  });

  it("mediation_pay_part retried after the chargeback settles pays the creator and closes the dispute", async () => {
    const w = world(makeOrder({ status: "in_dispute" }), { refund: BLOCKED, disputeOpen: true });
    const transfer = vi.fn(w.deps.money.transfer);
    const resolveDispute = vi.fn(w.deps.resolveDispute);
    w.deps.money.transfer = transfer;
    w.deps.resolveDispute = resolveDispute;
    const args = { actor: "staff" as const, creator_amount_cents: 7_500, refund_amount_cents: 5_000 };
    expect((await run(w, "mediation_pay_part", args)).ok).toBe(false);
    w.deps.money.refund = (async () => ({ ...SENT, refunded_cents: 5_000 })) as unknown as CreatorOrderDeps["money"]["refund"];
    const res = await run(w, "mediation_pay_part", args);
    expect(res.ok).toBe(true);
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(resolveDispute).toHaveBeenCalledTimes(1);
    expect(w.row().status).toBe("completed");
  });

  it("mediation_refund blocked has no transfer to protect, so it still closes the order and pages staff on the result", async () => {
    const w = world(makeOrder({ status: "in_dispute" }), { refund: BLOCKED, disputeOpen: true });
    const res = await run(w, "mediation_refund", { actor: "staff" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.needs_staff_review).toBe(true);
    expect(w.row().status).toBe("cancelled");
  });

  it("no_show blocked still closes the order", async () => {
    const w = world(makeOrder(), { refund: BLOCKED });
    const res = await run(w, "no_show", { actor: "system" });
    expect(res.ok).toBe(true);
    expect(w.row().status).toBe("cancelled");
  });

  it("mediation_refund blocked: no money-back line", async () => {
    const w = world(makeOrder({ status: "in_dispute" }), { refund: BLOCKED, disputeOpen: true });
    await run(w, "mediation_refund", { actor: "staff" });
    expect(tenantText("dispute_resolved")).not.toMatch(CLAIMS_MONEY_BACK);
  });
});

describe("a charge that was already refunded is not announced as new money", () => {
  it("says it was already refunded, without an amount", async () => {
    const w = world(makeOrder(), { refund: ALREADY_EMPTY });
    await run(w, "no_show", { actor: "system" });
    const text = tenantText("cancellation_outcome");
    expect(text).not.toMatch(CLAIMS_MONEY_BACK);
    expect(text).toContain("This charge was already refunded, so no new refund was sent.");
  });

  it("a replay of Zavi's own refund still reports the real amount", async () => {
    const w = world(makeOrder(), { refund: ALREADY_REPLAY });
    await run(w, "no_show", { actor: "system" });
    expect(tenantText("cancellation_outcome")).toContain(
      "$165.00 goes back to the card you paid with, including the 10% Zavi fee.",
    );
  });
});

describe("the ordinary refund copy is unchanged", () => {
  it("no_show with a real refund names the amount and pages nobody", async () => {
    const w = world(makeOrder(), { refund: SENT });
    const res = await run(w, "no_show", { actor: "system" });
    expect(res.ok && res.needs_staff_review).toBe(false);
    const text = tenantText("cancellation_outcome");
    expect(text).toContain("$165.00 goes back to the card you paid with, including the 10% Zavi fee.");
    expect(text).not.toContain("on hold");
    expect(w.alerts).toEqual([]);
  });

  it("mediation_pay_part with a real refund names the staff amount", async () => {
    const w = world(makeOrder({ status: "in_dispute" }), {
      refund: { ...SENT, refunded_cents: 5_000 },
      disputeOpen: true,
    });
    await run(w, "mediation_pay_part", { actor: "staff", creator_amount_cents: 7_500, refund_amount_cents: 5_000 });
    expect(tenantText("dispute_resolved")).toContain("$50.00 goes back to your card.");
  });

  it("mediation_pay_full refunds nothing and says so instead of 'the agreed amount goes back'", async () => {
    const w = world(makeOrder({ status: "in_dispute" }), { disputeOpen: true });
    await run(w, "mediation_pay_full", { actor: "staff" });
    const text = tenantText("dispute_resolved");
    expect(text).not.toContain("agreed amount");
    expect(text.replace(/Nothing goes back to your card\./g, "")).not.toMatch(CLAIMS_MONEY_BACK);
    expect(text).toContain("Nothing goes back to your card.");
  });
});

describe("a deadline-driven payout that needs a person reaches staff", () => {
  const due = () =>
    makeOrder({
      status: "completed",
      closed_reason: "auto_accepted",
      closed_at: T0,
      payout_status: "ready",
      payout_ready_at: "2026-09-19T00:00:00.000Z",
    });

  it("a transfer that threw pages staff with the reason and the order", async () => {
    const w = world(due(), { transfer: "throws" });
    const res = await run(w, "payout_buffer_elapsed", { actor: "system" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.needs_staff_review).toBe(true);
    expect(res.payout_sent).toBe(false);
    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0].msg).toContain(ORDER);
    expect(w.alerts[0].msg).toContain("transfer_failed");
  });

  it("a lost claim is ordinary, reports the payout as in flight rather than not sent, and pages nobody", async () => {
    const w = world(due(), { transfer: "claim_lost" });
    const res = await run(w, "payout_buffer_elapsed", { actor: "system" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payout_sent).toBeNull();
    expect(w.alerts).toEqual([]);
  });

  it("a sent payout reports payout_sent and pages nobody", async () => {
    const w = world(due());
    const res = await run(w, "payout_buffer_elapsed", { actor: "system" });
    expect(res.ok && res.payout_sent).toBe(true);
    expect(w.alerts).toEqual([]);
  });

  it("a failing pager never fails the transition", async () => {
    const w = world(due(), { transfer: "throws" });
    w.deps.alert = (async () => {
      throw new Error("slack down");
    }) as unknown as CreatorOrderDeps["alert"];
    const res = await run(w, "payout_buffer_elapsed", { actor: "system" });
    expect(res.ok).toBe(true);
    expect(w.row().status).toBe("completed");
  });
});

describe("Zavi's decision on a dispute tells the creator what they actually get", () => {
  const creatorText = (event: string): string => {
    const r = rows.find((x) => x.recipient_kind === "creator" && x.kind === event);
    if (!r) throw new Error(`no creator row for ${event}`);
    return `${r.title}\n${r.body}`;
  };

  it("a full refund to the business never tells the creator they are paid", async () => {
    const w = world(makeOrder({ status: "in_dispute" }), { refund: SENT, disputeOpen: true });
    const res = await run(w, "mediation_refund", { actor: "staff" });
    expect(res.ok).toBe(true);
    const text = creatorText("dispute_resolved");
    expect(text).toContain("no payout is due on this job");
    expect(text).not.toMatch(/Your payout for this job is \$/);
  });

  it("paying the creator in full still quotes their payout", async () => {
    const w = world(makeOrder({ status: "in_dispute" }), { refund: SENT, disputeOpen: true });
    await run(w, "mediation_pay_full", { actor: "staff" });
    expect(creatorText("dispute_resolved")).toMatch(/Your payout for this job is \$\d/);
  });
});

describe("the creator's approved notice only says the payout is on its way when it left", () => {
  const approvedText = (): string => {
    const r = rows.find((x) => x.recipient_kind === "creator" && x.kind === "approved");
    if (!r) throw new Error("no creator approved row");
    return `${r.title}\n${r.body}`;
  };

  it("a transfer that threw is not announced as on its way", async () => {
    const w = world(makeOrder({ status: "submitted" }), { transfer: "throws" });
    const res = await run(w, "approve", { actor: "business" });
    expect(res.ok).toBe(true);
    const text = approvedText();
    expect(text).not.toContain("on its way");
    expect(text).toContain("has not been sent yet");
  });

  it("a lost claim means another worker is sending it, so it never says it has not been sent", async () => {
    const w = world(makeOrder({ status: "submitted" }), { transfer: "claim_lost" });
    const res = await run(w, "approve", { actor: "business" });
    expect(res.ok).toBe(true);
    const text = approvedText();
    expect(text).not.toContain("has not been sent yet");
    expect(text).toContain("on its way to Stripe now");
  });

  it("a transfer that went out says so", async () => {
    const w = world(makeOrder({ status: "submitted" }), { transfer: "ok" });
    await run(w, "approve", { actor: "business" });
    expect(approvedText()).toContain("on its way to Stripe now");
  });

  it("a claim refused because a dispute is open is not announced as on its way, and pages staff", async () => {
    const w = world(makeOrder({ status: "submitted" }), { transfer: "claim_lost", disputeOpen: true });
    const res = await run(w, "approve", { actor: "business" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.needs_staff_review).toBe(true);
    const r = rows.find((x) => x.recipient_kind === "creator" && x.kind === "approved")!;
    const text = `${r.title}\n${r.body}`;
    expect(text).toContain("has not been sent yet");
    expect(text).not.toContain("on its way");
    expect(w.alerts.map((a) => a.code)).toContain("creator_order_needs_staff");
  });
});
