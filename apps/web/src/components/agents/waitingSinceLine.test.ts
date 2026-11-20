import { describe, expect, it } from "vitest";
import { waitingSinceLine } from "./LiveDecisionCard";

describe("waitingSinceLine", () => {
  it("names the day a card filed well before this chat showed it", () => {
    expect(waitingSinceLine("2026-10-20T20:43:53Z", "2026-10-21T08:02:34Z")).toBe("Waiting since Oct 20");
  });
  it("says nothing for a card this run just filed", () => {
    expect(waitingSinceLine("2026-10-21T08:02:30Z", "2026-10-21T08:02:34Z")).toBeNull();
  });
  it("says nothing when either time is missing", () => {
    expect(waitingSinceLine(undefined, "2026-10-21T08:02:34Z")).toBeNull();
    expect(waitingSinceLine("2026-10-20T20:43:53Z", undefined)).toBeNull();
  });
});
