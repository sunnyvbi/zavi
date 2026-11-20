import { describe, it, expect } from "vitest";
import { shouldRefuseUnapprovedExactActionCard, APPROVED_ROW_ONLY_CLASSES } from "../ship-pr-approval-gate";

describe("shouldRefuseUnapprovedExactActionCard", () => {
  it.each([...APPROVED_ROW_ONLY_CLASSES])("%s: refused unless approved", (cls) => {
    expect(shouldRefuseUnapprovedExactActionCard({ decision_class: cls, status: "proposed" })).toBe(true);
    expect(shouldRefuseUnapprovedExactActionCard({ decision_class: cls, status: null })).toBe(true);
    expect(shouldRefuseUnapprovedExactActionCard({ decision_class: cls, status: "approved" })).toBe(false);
  });
  it("other classes are untouched", () => {
    expect(shouldRefuseUnapprovedExactActionCard({ decision_class: "create_jira_issue", status: "proposed" })).toBe(false);
    expect(shouldRefuseUnapprovedExactActionCard(null)).toBe(false);
  });
});

import { shouldRefuseUnapprovedBulkEmail } from "../ship-pr-approval-gate";

describe("shouldRefuseUnapprovedBulkEmail (a forged decision.approved event sends nothing)", () => {
  const cls = "bulk_outbound.send";
  it("refuses a row that is not approved right now", () => {
    expect(shouldRefuseUnapprovedBulkEmail({ decision_class: cls, status: "proposed", approved_by: null })).toBe(true);
    expect(shouldRefuseUnapprovedBulkEmail({ decision_class: cls, status: "proposed", approved_by: "u1" })).toBe(true);
    expect(shouldRefuseUnapprovedBulkEmail({ decision_class: cls, status: "acted", approved_by: "u1" })).toBe(true);
  });
  it("refuses an 'approved' row with no approver", () => {
    expect(shouldRefuseUnapprovedBulkEmail({ decision_class: cls, status: "approved", approved_by: null })).toBe(true);
    expect(shouldRefuseUnapprovedBulkEmail({ decision_class: cls, status: "approved" })).toBe(true);
  });
  it("lets through only an approved row with its approver; other classes are not its business", () => {
    expect(shouldRefuseUnapprovedBulkEmail({ decision_class: cls, status: "approved", approved_by: "u1" })).toBe(false);
    expect(shouldRefuseUnapprovedBulkEmail({ decision_class: "outbound.send", status: "proposed", approved_by: null })).toBe(false);
    expect(shouldRefuseUnapprovedBulkEmail(null)).toBe(false);
  });
});
