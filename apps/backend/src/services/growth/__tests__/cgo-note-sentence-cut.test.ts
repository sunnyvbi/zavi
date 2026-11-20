import { describe, expect, it } from "vitest";
import { autoRunLine, cutAtSentence, easedGoalAsk, planNote, raisedGoalAsk, type GoalMoves } from "../goal-owner";
import { renderCgoNoteSlack } from "../cgo-note-slack";
import { renderCgoNoteEmail } from "@/email/templates/cgo-note";

const NOW = new Date("2026-10-05T12:00:00Z");
const LONG =
  "Paused Meta ad set Awareness because it spent $412 in the last 14 days with zero bookings, zero signups and zero leads, while the host goal needs new listings every single week of the quarter. " +
  "It still reaches a lot of people who look at cars, and the plan is to rebuild the same audience as a conversion campaign that optimises for the booking event once the pixel records it again, which the channel proposed on the 21st and again on the 23rd, so nothing is lost by stopping the awareness spend now.";

const note = () =>
  planNote({
    meta: { kind: "scheduled", alarm_keys: [], autopilot: true },
    moves: { goals: [], goal_changes: [], channel_changes: [] } as unknown as GoalMoves,
    saw: [],
    changedLines: [LONG],
    wouldLines: [],
    needLines: [],
    refused: [],
    now: NOW,
    reviewDays: 7,
  });

const FIRST = LONG.slice(0, LONG.indexOf(". ") + 1);

describe("cutAtSentence", () => {
  it("keeps whole sentences and never ends mid-word", () => {
    expect(LONG.length).toBeGreaterThan(400);
    expect(cutAtSentence(LONG, 400)).toBe(FIRST);
    const g = { objective: "Grow hosts", target_value: 900, due_date: "2026-12-31" };
    for (const ask of [raisedGoalAsk(g as never, { ...g, target_value: 1200 } as never, LONG), easedGoalAsk(g as never, { ...g, target_value: 700 } as never, LONG)]) {
      expect(ask.length).toBeLessThanOrEqual(400);
      expect(ask).toMatch(/[.?!]$/);
    }
    expect(autoRunLine("meta_ads", LONG)).toMatch(/[.!?…]$/);
  });
});

describe("the stored note, as each surface sends it", () => {
  it("Slack: the change line ends at a sentence end", () => {
    const n = note();
    expect(n.changed).toEqual([FIRST]);
    const slack = renderCgoNoteSlack({ companyName: "Upcar", changed: n.changed, need: n.need, growthUrl: "https://www.zaviagent.com/growth" });
    expect(slack).toContain(`• ${FIRST}`);
    expect(slack).not.toContain("It still reaches");
  });

  it("email: the change line ends at a sentence end", () => {
    const n = note();
    const email = renderCgoNoteEmail({ companyName: "Upcar", autopilot: true, saw: [], changed: n.changed, need: n.need, growthUrl: "https://www.zaviagent.com/growth" });
    expect(email.text).toContain(FIRST);
    expect(email.text).not.toContain("It still reaches");
    expect(email.html).not.toContain("It still reaches");
  });
});
