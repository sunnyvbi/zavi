import { describe, expect, it } from "vitest";
import { mediationResultMessage, payPartCheck } from "./creator-mediation";

describe("what staff are told after resolving a creator dispute", () => {
  it("never says money moved when the money came back short", () => {
    for (const outcome of ["pay_full", "pay_part", "refund"] as const) {
      const m = mediationResultMessage(outcome, { needs_staff_review: true, money_frozen: false, payout_waiting: false });
      expect(m.tone).toBe("warn");
      expect(m.text).not.toMatch(/released|being refunded in full|Paid in full/);
      expect(m.text).toContain("settle it by hand");
    }
  });

  it("warns that the payout is still frozen when the dispute did not close", () => {
    const m = mediationResultMessage("pay_full", { money_frozen: true });
    expect(m.tone).toBe("warn");
    expect(m.text).toContain("stays frozen");
    expect(m.text).not.toContain("released");
  });

  it("says the payout waits when the creator has not finished Stripe setup", () => {
    const m = mediationResultMessage("pay_part", { payout_waiting: true });
    expect(m.tone).toBe("warn");
    expect(m.text).toContain("waits until they do");
    expect(m.text).not.toContain("released");
  });

  it("does not say released when the payout was not actually sent", () => {
    const m = mediationResultMessage("pay_full", { payout_sent: false });
    expect(m.tone).toBe("warn");
    expect(m.text).toContain("was not sent yet");
    expect(m.text).not.toContain("released");
  });

  it("confirms a clean outcome plainly", () => {
    for (const payout_sent of [null, undefined]) {
      const m = mediationResultMessage("pay_part", { payout_sent });
      expect(m.tone).toBe("warn");
      expect(m.text).not.toContain("released");
    }
    expect(mediationResultMessage("pay_full", { payout_sent: true })).toEqual({ tone: "ok", text: "Paid in full. The creator's payout has been released." });
    expect(mediationResultMessage("refund", {}).text).toContain("refunded in full");
  });
});

describe("the pay part form refuses a split above what the business paid", () => {
  const limits = { max_creator_amount_cents: 8_500, max_refund_amount_cents: 11_000, max_total_cents: 11_000 };

  it("blocks $85 + $110 on a $110 charge and says by how much", () => {
    const c = payPartCheck(8_500, 11_000, limits);
    expect(c.ready).toBe(false);
    expect(c.over).toBe(true);
    expect(c.total).toBe("$85.00 + $110.00 = $195.00, which is $85.00 more than the $110.00 the business paid.");
  });

  it("allows a split that uses the whole charge", () => {
    const c = payPartCheck(8_500, 2_500, limits);
    expect(c.ready).toBe(true);
    expect(c.over).toBe(false);
    expect(c.total).toBe("$85.00 + $25.00 = $110.00 of the $110.00 the business paid.");
  });

  it("is not ready with a box empty or zero", () => {
    expect(payPartCheck(null, 2_500, limits).ready).toBe(false);
    expect(payPartCheck(0, 2_500, limits).ready).toBe(false);
  });
});
