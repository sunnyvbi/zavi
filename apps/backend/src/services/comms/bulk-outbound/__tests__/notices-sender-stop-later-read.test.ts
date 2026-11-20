import { describe, expect, it } from "vitest";
import { bulkSendLine, holdSentence, HOLD_SENTENCES } from "../notices";
import type { SendCounts } from "../store";

const counts = (over: Partial<SendCounts>): SendCounts =>
  ({ status: "held", hold_reason: "bulk_sending_paused", next_run_at: null, total: 400, sent: 0, skipped: 0, failed: 0, unknown: 0, pending: 400, sending: 0, ...over }) as SendCounts;

const STILL_STOPPED = /\b(is|are) stopped\b|right now|currently|still stopped/i;

describe("a global sender stop read after the sender runs again", () => {
  const shapes: Array<[string, Partial<SendCounts>]> = [
    ["nothing sent", { sent: 0, pending: 400 }],
    ["part sent", { sent: 100, pending: 300 }],
    ["part sent, some refused", { sent: 100, failed: 5, pending: 295 }],
    ["nothing confirmed", { sent: 0, unknown: 4, pending: 396 }],
    ["part sent, some unconfirmed", { sent: 100, unknown: 4, pending: 296 }],
    ["one person left", { sent: 399, pending: 1 }],
  ];

  it.each(shapes)("the held notice for %s never says the sender is stopped now", (_n, over) => {
    const line = bulkSendLine("held", counts(over));
    expect(line).toContain("Zavi's own sender was stopped for every workspace");
    expect(line).not.toMatch(STILL_STOPPED);
  });

  it("holdSentence for the global stop is past tense and says nothing about right now", () => {
    expect(holdSentence("bulk_sending_paused")).toBe("Zavi's own sender was stopped for every workspace");
  });

  it("no hold sentence claims a live global stop", () => {
    for (const [reason, sentence] of Object.entries(HOLD_SENTENCES)) {
      expect({ reason, bad: STILL_STOPPED.test(sentence) }).toEqual({ reason, bad: false });
    }
  });
});
