import { describe, expect, it } from "vitest";
import type { CardOutcome, PlannedEmail } from "@/lib/workspace/emailPlanApi";
import { comingUpStatus, shownPlanStatus } from "../comingUpStatus";

const CARD = { rail: "decisions", id: "d1" } as const;
const outcome = (status: string, extra: Partial<CardOutcome> = {}): CardOutcome => ({
  status,
  sent: null,
  total: null,
  unknown: null,
  may_have_sent: false,
  reason: null,
  pause_hold: null,
  ...extra,
});
const item = (status: PlannedEmail["status"], card_status: CardOutcome | null, card: PlannedEmail["card"] = CARD) => ({ status, card_status, card });

describe("Coming up never claims a send it cannot prove", () => {
  it.each([
    ["the card could not be read", null, "Checking"],
    ["the card is queued", outcome("queued"), "Sending"],
    ["the card is approved", outcome("approved"), "Sending"],
    ["the send is held", outcome("held"), "On hold"],
    ["the send was stopped", outcome("stopped"), "Stopped"],
    ["the outcome is unknown", outcome("outcome_unknown", { may_have_sent: true }), "Delivery unknown"],
  ])("a stored sent item is not Sent when %s", (_, card_status, label) => {
    const shown = comingUpStatus(item("sent", card_status));
    expect(shown.label).toBe(label);
    expect(shown.sent).toBe(false);
  });

  it("the week strip does not paint an unproven send as sent", () => {
    expect(shownPlanStatus(item("sent", null))).toBe("reconciling");
    expect(shownPlanStatus(item("sent", outcome("queued")))).toBe("sending");
  });

  it("shows Sent when the card proves it", () => {
    expect(comingUpStatus(item("sent", outcome("sent", { sent: 3, total: 3 })))).toMatchObject({ label: "Sent", sent: true, fromCard: true });
  });

  it("keeps Sent for an item with no card to read", () => {
    expect(comingUpStatus(item("sent", null, null))).toMatchObject({ label: "Sent", sent: true });
  });

  it.each([
    ["scheduled", "Approved"],
    ["ready", "Needs approval"],
  ] as const)("keeps the %s chip before a send starts", (status, label) => {
    expect(comingUpStatus(item(status, outcome("approved"))).label).toBe(label);
  });
});
