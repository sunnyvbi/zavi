import { describe, expect, it } from "vitest";
import { cardSendState, type SendFacts, type ViewState } from "../cards";
import { FANOUT_STALLED_REASON, notEmailedLine, stalledSendNote } from "../recovery";

const UNKNOWN_REST = "Zavi will not send it to the rest of the list on its own.";

describe("notEmailedLine and stalledSendNote with a total that was never read", () => {
  it("an undefined or NaN total reads like an unknown one instead of throwing", () => {
    for (const total of [undefined, Number.NaN, null]) {
      expect(notEmailedLine(1, total)).toBe(UNKNOWN_REST);
      expect(stalledSendNote(1, total)).toBe(`${FANOUT_STALLED_REASON} ${UNKNOWN_REST}`);
    }
  });

  it("a known total still says how many were not emailed", () => {
    expect(notEmailedLine(1, 3)).toBe("2 of the 3 people on the list were not emailed, and Zavi will not send it to them on its own.");
    expect(notEmailedLine(3, 3)).toBe(UNKNOWN_REST);
  });

  it("a stalled bulk row missing its total gives a partly-sent card, not a crash", () => {
    const bulk = { status: "held", hold_reason: "fanout_stalled", sent: 1, failed: 0, unknown: 0, hard_bounces: 0, finished_at: null } as unknown as NonNullable<NonNullable<SendFacts>["bulk"]>;
    const facts: SendFacts = { card: { status: "acted", approved: true, dispatched_at: "2026-10-22T00:00:00Z", error: null }, bulk, results: null };
    const s = cardSendState("decisions", { status: "acted" } as ViewState, facts);
    expect(s.status).toBe("partially_sent");
    expect(s.failure_reason).toBe(`${FANOUT_STALLED_REASON} ${UNKNOWN_REST}`);
  });
});
