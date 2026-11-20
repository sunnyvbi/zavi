import { describe, it, expect } from "vitest";
import { isLiveStateQuestion, LIVE_STATE_PATTERN_COUNT } from "../live-state-classify";

describe("isLiveStateQuestion", () => {
  describe("positives (must classify as live-state)", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["incident — Bay Area budget", "is the bay area ads doubled?"],
      ["current status of an entity", "what's the current status of the Q4 campaign?"],
      ["currently marker", "are we currently running the host-acquisition campaign?"],
      ["right now", "how much are we spending right now on Meta?"],
      ["today", "did the campaign spend change today?"],
      ["is X still active", "is Bay Area Rentals 2026-04-29 still active?"],
      ["is X paused", "is the gig-rental campaign paused?"],
      ["is X connected", "is the Stripe connector connected?"],
      ["doubled (single word)", "did the budget get doubled?"],
      ["did X change", "has the listing fee changed?"],
      ["status of", "what is the status of stripe payouts?"],
      ["live spend", "show me live spend by campaign"],
      ["current budget", "what's the current budget for the host campaign"],
      ["this week", "how many bookings have we had this week?"],
      ["does X exist", "does the rental_bayarea_intent campaign still exist?"],
      ["is X up", "is api.zaviagent.com up?"],
    ];
    for (const [label, text] of cases) {
      it(label, () => {
        expect(isLiveStateQuestion(text)).toBe(true);
      });
    }
  });

  describe("negatives (must NOT classify as live-state)", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["historical question", "how did our Meta campaigns perform in March?"],
      ["last week (memory-OK range)", "what did we spend last week vs the week before?"],
      ["entity lookup", "look up user u_abc"],
      ["definitional", "what is upcar's pricing strategy?"],
      ["narrative / planning", "draft a launch plan for the buy/sell product"],
      ["yesterday past-tense (history)", "what happened with payouts yesterday morning's batch"],
      ["empty input", ""],
      ["whitespace only", "    \n\t"],
      ["short fragment", "hi"],
      ["null input", null as unknown as string],
      ["undefined input", undefined as unknown as string],
    ];
    for (const [label, text] of cases) {
      it(label, () => {
        expect(isLiveStateQuestion(text)).toBe(false);
      });
    }
  });

  it("exposes a non-empty pattern count for the lint test", () => {
    expect(LIVE_STATE_PATTERN_COUNT).toBeGreaterThan(0);
  });
});
