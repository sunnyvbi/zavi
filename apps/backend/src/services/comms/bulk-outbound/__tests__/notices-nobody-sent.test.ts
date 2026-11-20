import { describe, expect, it } from "vitest";
import { bulkSendLine } from "../notices";
import type { SendCounts } from "../store";

const counts = (over: Partial<SendCounts>): SendCounts => ({
  status: "done",
  hold_reason: null,
  next_run_at: null,
  total: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
  unknown: 0,
  pending: 0,
  sending: 0,
  ...over,
} as SendCounts);

describe("bulkSendLine when nobody was emailed", () => {
  it("does not claim every email was refused when most people were skipped", () => {
    const line = bulkSendLine("done", counts({ total: 120, failed: 3, skipped: 117 }));
    expect(line).not.toMatch(/every email/);
    expect(line).toBe(
      "Not sent: the email provider refused 3 emails and 117 people were skipped (unsubscribed or bounced), so nobody was emailed.",
    );
  });
  it("uses singular words for one refusal and one skip", () => {
    expect(bulkSendLine("done", counts({ total: 2, failed: 1, skipped: 1 }))).toBe(
      "Not sent: the email provider refused 1 email and 1 person was skipped (unsubscribed or bounced), so nobody was emailed.",
    );
  });
  it("still says every email was refused when nobody was skipped", () => {
    expect(bulkSendLine("done", counts({ total: 3, failed: 3 }))).toBe(
      "Not sent: the email provider refused every email, so nobody was emailed.",
    );
  });
});
