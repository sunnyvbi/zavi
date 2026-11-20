
import { describe, it, expect } from "vitest";
import { isBulkApprovable } from "@/services/approvals/batch-decide-service";
import { OWNER_ONLY_APPROVE_CLASSES } from "@/services/approvals/decide-service";
import { NEVER_AUTO_DECISION_CLASSES } from "@/../workers/functions/dispatch-decision";

const FINAL = "dispute-response.final-submit-evidence";
const DRAFT = "dispute-response.submit-evidence";
const HANDLER = "stripe.submit_dispute_evidence";

describe("dispute-response final-submit money-path guards", () => {
  it("final-submit class is NOT bulk-approvable (never_auto)", () => {
    const r = isBulkApprovable({
      decision_class: FINAL,
      handler: HANDLER,
      never_auto: true,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("never_auto_class");
  });

  it("the Stripe evidence handler is excluded from bulk approve (covers draft + final)", () => {
    for (const cls of [DRAFT, FINAL]) {
      const r = isBulkApprovable({
        decision_class: cls,
        handler: HANDLER,
        never_auto: null,
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("money_or_customer_facing_handler");
    }
  });

  it("approving the final-submit class requires owner/admin (decide path)", () => {
    expect(OWNER_ONLY_APPROVE_CLASSES.has(FINAL)).toBe(true);
  });

  it("the final-submit class can never auto-fire (layer-3 mirror)", () => {
    expect(NEVER_AUTO_DECISION_CLASSES.has(FINAL)).toBe(true);
  });

  it("an ordinary non-money class is still bulk-approvable (guard is scoped, not blanket)", () => {
    const r = isBulkApprovable({
      decision_class: "operator.file-task",
      handler: "jira.create",
      never_auto: false,
    });
    expect(r.ok).toBe(true);
  });
});
