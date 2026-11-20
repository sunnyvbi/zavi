
import { describe, expect, it } from "vitest";
import {
  MAX_REVISION_ROUNDS,
  revisionsUsed,
  TRANSITIONS,
  creatorOrderTriggersFrom,
  transitionCreatorOrder,
  type CreatorOrderSource,
  type CreatorOrderStatus,
  type CreatorOrderTrigger,
} from "../order-state";

function decide(
  status: CreatorOrderStatus,
  trigger: CreatorOrderTrigger,
  source: CreatorOrderSource = "booking",
  actor?: Parameters<typeof transitionCreatorOrder>[0]["actor"],
) {
  return transitionCreatorOrder({ status, source, trigger, actor });
}

describe("every LEGAL transition in the spec", () => {
  const LEGAL: [CreatorOrderStatus, CreatorOrderTrigger, CreatorOrderSource, CreatorOrderStatus, string | null][] = [
    ["checkout_pending", "checkout_completed", "booking", "awaiting_acceptance", null],
    ["checkout_pending", "offer_started", "offer", "in_progress", null],
    ["checkout_pending", "checkout_abandoned", "booking", "cancelled", "checkout_abandoned"],
    ["checkout_pending", "hire_applicant", "applicant", "in_progress", null],
    ["checkout_pending", "offer_expired", "offer", "cancelled", "expired"],
    ["checkout_pending", "capture_failed", "applicant", "cancelled", "payment_failed"],
    ["checkout_pending", "creator_removed", "booking", "cancelled", "creator_removed"],
    ["awaiting_acceptance", "creator_accept", "booking", "in_progress", null],
    ["awaiting_acceptance", "creator_pass", "booking", "cancelled", "declined"],
    ["awaiting_acceptance", "accept_expired", "booking", "cancelled", "expired"],
    ["awaiting_acceptance", "business_withdraw", "booking", "cancelled", "withdrawn"],
    ["awaiting_acceptance", "capture_failed", "booking", "cancelled", "payment_failed"],
    ["awaiting_acceptance", "creator_removed", "booking", "cancelled", "creator_removed"],
    ["in_progress", "submit", "booking", "submitted", null],
    ["revision_requested", "submit", "booking", "submitted", null],
    ["submitted", "request_revision", "booking", "revision_requested", null],
    ["in_progress", "product_received", "booking", "in_progress", null],
    ["in_progress", "due_date_reached", "booking", "in_progress", null],
    ["in_progress", "request_extension", "booking", "in_progress", null],
    ["in_progress", "approve_extension", "booking", "in_progress", null],
    ["in_progress", "decline_extension", "booking", "in_progress", null],
    ["submitted", "approve", "booking", "completed", "approved"],
    ["submitted", "review_auto_accept", "booking", "completed", "auto_accepted"],
    ["completed", "payout_buffer_elapsed", "booking", "completed", null],
    ["in_progress", "no_show", "booking", "cancelled", "no_show"],
    ["in_progress", "request_cancellation", "booking", "cancel_requested", null],
    ["submitted", "request_cancellation", "booking", "cancel_requested", null],
    ["revision_requested", "request_cancellation", "booking", "cancel_requested", null],
    ["cancel_requested", "cancel_agreed", "booking", "cancelled", "cancel_agreed"],
    ["cancel_requested", "cancel_declined", "booking", "in_progress", null],
    ["cancel_requested", "cancel_revoked", "booking", "in_progress", null],
    ["cancel_requested", "cancel_no_response", "booking", "cancelled", "cancel_no_response"],
    ["cancel_requested", "cancel_disputed", "booking", "in_dispute", null],
    ["in_progress", "open_dispute", "booking", "in_dispute", null],
    ["submitted", "open_dispute", "booking", "in_dispute", null],
    ["revision_requested", "open_dispute", "booking", "in_dispute", null],
    ["cancel_requested", "open_dispute", "booking", "in_dispute", null],
    ["completed", "open_dispute_in_buffer", "booking", "completed", null],
    ["in_dispute", "mediation_pay_full", "booking", "completed", "mediation_pay_full"],
    ["in_dispute", "mediation_pay_part", "booking", "completed", "mediation_pay_part"],
    ["in_dispute", "mediation_refund", "booking", "cancelled", "mediation_refund"],
  ];

  it.each(LEGAL)("%s + %s (%s) -> %s", (from, trigger, source, to, reason) => {
    const r = decide(from, trigger, source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.to).toBe(to);
    expect(r.closed_reason).toBe(reason);
  });

  it("covers every trigger in the table", () => {
    const covered = new Set(LEGAL.map(([, t]) => t));
    for (const t of TRANSITIONS) {
      expect(covered.has(t.trigger), `trigger '${t.trigger}' has no legal-path test`).toBe(true);
    }
  });
});

describe("illegal transitions are REJECTED, not ignored", () => {
  const ILLEGAL: [CreatorOrderStatus, CreatorOrderTrigger, string][] = [
    ["cancelled", "approve", "approving a cancelled order"],
    ["completed", "approve", "approving twice"],
    ["completed", "creator_accept", "accepting a finished job"],
    ["cancelled", "payout_buffer_elapsed", "paying out a cancelled order"],
    ["in_progress", "creator_accept", "accepting an already accepted job"],
    ["awaiting_acceptance", "approve", "approving before any work exists"],
    ["awaiting_acceptance", "submit", "submitting before accepting"],
    ["in_progress", "request_revision", "asking for a revision with nothing submitted"],
    ["submitted", "no_show", "no-show after a draft arrived"],
    ["revision_requested", "no_show", "no-show after a draft arrived"],
    ["in_dispute", "approve", "approving around mediation"],
    ["in_dispute", "payout_buffer_elapsed", "paying out while a dispute is open"],
    ["cancel_requested", "approve", "approving mid-cancellation"],
    ["checkout_pending", "approve", "approving an unpaid order"],
    ["completed", "mediation_pay_full", "mediating a job that is not in dispute"],
  ];

  it.each(ILLEGAL)("%s + %s is refused (%s)", (from, trigger) => {
    const r = decide(from, trigger);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("illegal_transition");
    expect(r.message).toContain(trigger);
  });

  it("an unknown trigger is refused by name", () => {
    const r = decide("in_progress", "definitely_not_a_trigger" as CreatorOrderTrigger);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_trigger");
  });

  it("Q37: staff removal never cancels a job already in progress", () => {
    for (const live of ["in_progress", "submitted", "revision_requested"] as CreatorOrderStatus[]) {
      const r = decide(live, "creator_removed", "booking", "staff");
      expect(r.ok, `${live} should refuse creator_removed`).toBe(false);
    }
    expect(decide("awaiting_acceptance", "creator_removed", "booking", "staff").ok).toBe(true);
  });
});

describe("the wrong actor and the wrong source are refused", () => {
  it("only the creator accepts a booking", () => {
    expect(decide("awaiting_acceptance", "creator_accept", "booking", "creator").ok).toBe(true);
    for (const a of ["business", "staff", "system"] as const) {
      const r = decide("awaiting_acceptance", "creator_accept", "booking", a);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("wrong_actor");
    }
  });

  it("only staff decide a mediation outcome", () => {
    for (const a of ["business", "creator"] as const) {
      const r = decide("in_dispute", "mediation_pay_full", "booking", a);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("wrong_actor");
    }
    expect(decide("in_dispute", "mediation_pay_full", "booking", "staff").ok).toBe(true);
  });

  it("only a timer expires a window", () => {
    for (const t of ["accept_expired", "review_auto_accept", "no_show", "cancel_no_response"] as const) {
      const legalFrom: Record<string, CreatorOrderStatus> = {
        accept_expired: "awaiting_acceptance",
        review_auto_accept: "submitted",
        no_show: "in_progress",
        cancel_no_response: "cancel_requested",
      };
      expect(decide(legalFrom[t], t, "booking", "system").ok).toBe(true);
      expect(decide(legalFrom[t], t, "booking", "business").ok).toBe(false);
    }
  });

  it("hire_applicant only applies to an applicant order, offer_expired only to an offer", () => {
    expect(decide("checkout_pending", "hire_applicant", "applicant").ok).toBe(true);
    for (const s of ["booking", "offer"] as CreatorOrderSource[]) {
      const r = decide("checkout_pending", "hire_applicant", s);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("wrong_source");
    }
    expect(decide("checkout_pending", "offer_expired", "offer").ok).toBe(true);
    expect(decide("checkout_pending", "offer_expired", "booking").ok).toBe(false);
  });
});

describe("invariant 2: the money a trigger is allowed to move", () => {
  const MONEY: Record<string, string[]> = {
    checkout_completed: [],
    offer_started: ["capture:hire"],
    checkout_abandoned: ["cancel_hold:checkout_abandoned"],
    hire_applicant: ["capture:hire"],
    creator_accept: ["capture:creator_accept"],
    capture_failed: ["cancel_hold:payment_failed"],
    creator_pass: ["cancel_hold:decline"],
    accept_expired: ["cancel_hold:expiry"],
    offer_expired: ["cancel_hold:expiry"],
    business_withdraw: ["cancel_hold:withdrawn"],
    creator_removed: ["cancel_hold:creator_removed"],
    submit: [],
    request_revision: [],
    product_received: [],
    due_date_reached: [],
    request_extension: [],
    approve_extension: [],
    decline_extension: [],
    approve: ["transfer:approval"],
    review_auto_accept: ["arm_payout_buffer:"],
    payout_buffer_elapsed: ["transfer:auto_accept_buffer"],
    no_show: ["refund:no_show"],
    request_cancellation: [],
    cancel_agreed: ["refund:cancel_agreed"],
    cancel_declined: [],
    cancel_revoked: [],
    cancel_no_response: ["refund:cancel_no_response"],
    cancel_disputed: ["freeze_payout:"],
    open_dispute: ["freeze_payout:"],
    open_dispute_in_buffer: ["freeze_payout:"],
    mediation_pay_full: ["transfer:mediation"],
    mediation_pay_part: ["refund:mediation", "transfer:mediation"],
    mediation_refund: ["refund:mediation"],
  };

  it.each(TRANSITIONS.map((t) => [t.trigger] as const))("%s moves exactly what it should", (trigger) => {
    const row = TRANSITIONS.find((t) => t.trigger === trigger);
    const actual = (row?.money ?? []).map(
      (m) => `${m.kind}:${"cause" in m ? m.cause : ""}`,
    );
    expect(actual).toEqual(MONEY[trigger]);
  });

  it("no trigger both captures and refunds", () => {
    for (const t of TRANSITIONS) {
      const kinds = t.money.map((m) => m.kind);
      expect(kinds.includes("capture") && kinds.includes("refund")).toBe(false);
    }
  });

  it("only a terminal transition or the buffer releases a transfer", () => {
    for (const t of TRANSITIONS) {
      if (!t.money.some((m) => m.kind === "transfer")) continue;
      const paysOut = t.to === "completed" || t.trigger === "payout_buffer_elapsed";
      expect(paysOut, `${t.trigger} transfers without completing the order`).toBe(true);
    }
  });
});

describe("table hygiene", () => {
  it("a terminal destination always carries a closed_reason and a live one never does", () => {
    for (const t of TRANSITIONS) {
      const terminal = t.to === "completed" || t.to === "cancelled";
      expect(Boolean(t.closed_reason), `${t.trigger}`).toBe(terminal);
    }
  });

  it("completed only ever closes with a paying reason", () => {
    const paying = ["approved", "auto_accepted", "mediation_pay_full", "mediation_pay_part"];
    for (const t of TRANSITIONS) {
      if (t.to !== "completed") continue;
      expect(paying).toContain(t.closed_reason);
    }
  });

  it("every transition names its trigger and cites the spec", () => {
    for (const t of TRANSITIONS) {
      expect(t.trigger.length).toBeGreaterThan(0);
      expect(t.spec.length).toBeGreaterThan(20);
      expect(t.actors.length).toBeGreaterThan(0);
      expect(t.from.length).toBeGreaterThan(0);
    }
  });

  it("no user-visible copy uses an em dash, an en dash or a double hyphen", () => {
    for (const t of TRANSITIONS) {
      expect(t.spec).not.toMatch(/[—–]|--/);
    }
  });

  it("creatorOrderTriggersFrom lists what a screen may offer", () => {
    const forBusiness = creatorOrderTriggersFrom("submitted", "booking", "business");
    expect(forBusiness).toEqual(
      expect.arrayContaining(["approve", "request_revision", "request_cancellation", "open_dispute"]),
    );
    expect(forBusiness).not.toContain("review_auto_accept");
    expect(creatorOrderTriggersFrom("cancelled")).toEqual([]);
  });
});

describe("a declined or revoked cancellation puts the order back exactly where it was", () => {
  const restoring: CreatorOrderTrigger[] = ["cancel_declined", "cancel_revoked"];

  for (const trigger of restoring) {
    for (const before of ["in_progress", "submitted", "revision_requested"] as const) {
      it(`${trigger} from ${before} returns to ${before}`, () => {
        const d = transitionCreatorOrder({
          status: "cancel_requested",
          source: "booking",
          trigger,
          status_before_cancel_request: before,
        });
        expect(d.ok).toBe(true);
        if (!d.ok) return;
        expect(d.to).toBe(before);
        expect(d.status_changed).toBe(true);
        expect(d.is_terminal).toBe(false);
        expect(d.money).toEqual([]);
        expect(d.closed_reason).toBeNull();
      });
    }

    it(`${trigger} falls back to in_progress when the row predates the column`, () => {
      const d = transitionCreatorOrder({
        status: "cancel_requested",
        source: "booking",
        trigger,
        status_before_cancel_request: null,
      });
      expect(d.ok).toBe(true);
      if (!d.ok) return;
      expect(d.to).toBe("in_progress");
      expect(d.money).toEqual([]);
    });

    it(`${trigger} clears the request so the 72h sweep cannot still fire`, () => {
      const d = transitionCreatorOrder({
        status: "cancel_requested",
        source: "booking",
        trigger,
        status_before_cancel_request: "submitted",
      });
      expect(d.ok).toBe(true);
      if (!d.ok) return;
      expect(d.sets.cancel_requested_at).toBe("clear");
      expect(d.sets.status_before_cancel_request).toBe("clear");
    });
  }

  it("only the creator may decline, and only the business may revoke", () => {
    const declineByBusiness = transitionCreatorOrder({
      status: "cancel_requested", source: "booking", trigger: "cancel_declined", actor: "business",
    });
    expect(declineByBusiness.ok).toBe(false);
    const revokeByCreator = transitionCreatorOrder({
      status: "cancel_requested", source: "booking", trigger: "cancel_revoked", actor: "creator",
    });
    expect(revokeByCreator.ok).toBe(false);
  });

  it("declining is NOT disputing: only the dispute freezes money and calls in staff", () => {
    const declined = decide("cancel_requested", "cancel_declined", "booking", "creator");
    const disputed = decide("cancel_requested", "cancel_disputed", "booking", "creator");
    expect(declined.ok && declined.money).toEqual([]);
    expect(disputed.ok && disputed.to).toBe("in_dispute");
    expect(disputed.ok && disputed.money).toEqual([{ kind: "freeze_payout" }]);
  });

  it("request_cancellation remembers the status it interrupted", () => {
    for (const before of ["in_progress", "submitted", "revision_requested"] as const) {
      const d = decide(before, "request_cancellation", "booking", "business");
      expect(d.ok).toBe(true);
      if (!d.ok) return;
      expect(d.to).toBe("cancel_requested");
      expect(d.sets.status_before_cancel_request).toBe("now");
      expect(d.money).toEqual([]);
    }
  });
});

describe("S4: offer_started is ONLY for a custom offer", () => {
  it("is refused as wrong_source for a booking and for an applicant", () => {
    for (const source of ["booking", "applicant"] as const) {
      const r = decide("checkout_pending", "offer_started", source, "system");
      expect(r).toMatchObject({ ok: false, code: "wrong_source" });
    }
  });

  it("is a system trigger (paying pulls it), never a person's button", () => {
    for (const actor of ["business", "creator", "staff"] as const) {
      expect(decide("checkout_pending", "offer_started", "offer", actor)).toMatchObject({
        ok: false,
        code: "wrong_actor",
      });
    }
  });

  it("checkout_completed is bookings only now, so an offer cannot wait 72h for a second yes", () => {
    expect(decide("checkout_pending", "checkout_completed", "offer", "system")).toMatchObject({
      ok: false,
      code: "wrong_source",
    });
  });

  it("stamps accepted_at and responded_at, starts the due clock, and tells the creator they were hired", () => {
    const r = decide("checkout_pending", "offer_started", "offer", "system");
    expect(r.ok && r.sets).toEqual({ accepted_at: "now", responded_at: "now", due_at: "job_start" });
    expect(r.ok && r.notices).toEqual([{ event: "hired", to: "creator" }]);
  });
});

describe("S4: product_received and the revision count", () => {
  it("product_received is the creator's, from in_progress only, and moves the due date", () => {
    expect(decide("in_progress", "product_received", "offer", "creator").ok).toBe(true);
    expect(decide("in_progress", "product_received", "offer", "business")).toMatchObject({ code: "wrong_actor" });
    expect(decide("submitted", "product_received", "offer", "creator")).toMatchObject({ code: "illegal_transition" });
    const r = decide("in_progress", "product_received", "booking", "creator");
    expect(r.ok && r.sets).toEqual({ product_received_at: "now", due_at: "job_start" });
  });

  it("counts revision rounds from submission rounds", () => {
    expect(revisionsUsed(0, "in_progress")).toBe(0);
    expect(revisionsUsed(1, "submitted")).toBe(0);
    expect(revisionsUsed(1, "revision_requested")).toBe(1);
    expect(revisionsUsed(2, "submitted")).toBe(1);
    expect(revisionsUsed(2, "revision_requested")).toBe(2);
    expect(revisionsUsed(3, "submitted")).toBe(2);
    expect(MAX_REVISION_ROUNDS).toBe(2);
  });
});
