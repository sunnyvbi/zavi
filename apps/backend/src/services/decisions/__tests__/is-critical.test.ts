
import { describe, it, expect } from "vitest";
import { isCriticalDecision } from "../is-critical";

describe("isCriticalDecision", () => {
  it("pins a security/money decision_class regardless of body", () => {
    expect(isCriticalDecision("payment.refund_review", {})).toBe(true);
    expect(isCriticalDecision("stripe.payout_hold", { note: "routine" })).toBe(true);
    expect(isCriticalDecision("security.rotate_key", null)).toBe(true);
  });

  it("pins a generic class when the body text matches the critical lexicon", () => {
    expect(
      isCriticalDecision("pm.needs_action", {
        theme: "Password reset token not invalidated after use, account takeover vector",
      }),
    ).toBe(true);
    expect(
      isCriticalDecision("chief-of-staff.dispatch-specialist", {
        intent: "IDOR on getPaymentInfo exposes payment method to other users",
      }),
    ).toBe(true);
    expect(
      isCriticalDecision("pm.needs_action", {
        theme: "Rotate the exposed PEM private deploy key at apps/backend/githubkey",
      }),
    ).toBe(true);
  });

  it("does NOT pin a summary/digest class even when it mentions the words (grounding false-positive)", () => {
    expect(
      isCriticalDecision("chief-of-staff.daily-digest", {
        summary: "Today: a password reset security issue and a payment refund were noted.",
      }),
    ).toBe(false);
    expect(
      isCriticalDecision("notetaker.write_atoms", { text: "discussed payment and auth" }),
    ).toBe(false);
  });

  it("does NOT pin a benign non-critical decision", () => {
    expect(
      isCriticalDecision("growth-lead.lifecycle-draft", {
        theme: "Draft a re-engagement email for lapsed hosts",
      }),
    ).toBe(false);
    expect(isCriticalDecision("pm.needs_action", { theme: "Add a social proof bar to the landing page" })).toBe(
      false,
    );
  });

  it("never throws on a malformed / non-object body", () => {
    expect(isCriticalDecision("pm.needs_action", "account takeover in a raw string")).toBe(true);
    expect(isCriticalDecision(null, undefined)).toBe(false);
    expect(isCriticalDecision("pm.plan", 12345 as unknown)).toBe(false);
  });
});

describe("isCriticalDecision — payment-method context (2026-07-18)", () => {
  it("does NOT pin UI copy in a shipped diff that merely says 'payment method'", () => {
    expect(
      isCriticalDecision("engineer.ship-pr", {
        intent:
          "feat(billing): add Private Rentals on/off toggle with subscription-state gating (PR #1418)",
        diff: `{subscription?.status === 'paused' ? 'Add payment method' : 'Update payment method'} "Your free trial has ended and there's no payment method on file. Add a card to activate your subscription."`,
      }),
    ).toBe(false);
  });

  it("does NOT pin a funnel/drop-off item that mentions the payment-method step", () => {
    expect(
      isCriticalDecision("pm.needs_action", {
        theme:
          "Guest checkout abandons at payment method step — 94% InitiateCheckout→AddPaymentInfo drop",
      }),
    ).toBe(false);
  });

  it("pins a payment-method exposure with NO other critical term (verb BEFORE noun)", () => {
    expect(
      isCriticalDecision("pm.needs_action", {
        theme: "Any signed-in user can access another customer's payment method",
      }),
    ).toBe(true);
  });

  it("pins a payment-method exposure with NO other critical term (verb AFTER noun)", () => {
    expect(
      isCriticalDecision("pm.needs_action", {
        theme: "Payment method can be accessed by another user",
      }),
    ).toBe(true);
  });

  it("STILL pins a real payment-method exposure (the abuse verb is what counts)", () => {
    expect(
      isCriticalDecision("pm.needs_action", {
        theme:
          "P0 IDOR: authenticated users can read other users' payment methods",
      }),
    ).toBe(true);
    expect(
      isCriticalDecision("pm.needs_action", {
        theme:
          "IDOR on POST /api/users/getPaymentInfo exposes full payment method to any authenticated user",
      }),
    ).toBe(true);
  });
});

describe("isCriticalDecision — active fraud (2026-07-18)", () => {
  it("pins a card-testing attack emitted under a generic class", () => {
    expect(
      isCriticalDecision("chief-of-staff.dispatch-specialist", {
        intent:
          "Card-testing attack on cus_Ut4Q5syowTocQs: 8 failed charges + 1 succeeded-then-refunded ($319.20) in ~90 min today.",
      }),
    ).toBe(true);
  });

  it("does NOT pin benign billing prose that happens to mention failed charges", () => {
    expect(
      isCriticalDecision("pm.needs_action", {
        theme:
          "Two large failed charges flagged for monitoring — different customers, no dispute, no repeat pattern",
      }),
    ).toBe(false);
  });
});
