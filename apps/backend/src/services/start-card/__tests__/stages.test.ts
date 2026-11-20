
import { describe, it, expect } from "vitest";
import { START_CARD_DONE_FIXTURE, START_CARD_STATUSES, type StartCardParts } from "@zavi/shared";
import { runGoogleStage, scoreCard, StageUnavailableError } from "../stages";

describe("scoreCard", () => {
  it("agrees with the shared fixture", () => {
    expect(scoreCard(START_CARD_DONE_FIXTURE.parts)).toEqual(START_CARD_DONE_FIXTURE.score);
  });

  it("scores out of 20 x available checks; unavailable is null, never 0", () => {
    const parts: StartCardParts = {
      google: { state: "done", evidence: null, points: 15, fetched_at: null },
      ai: { state: "unavailable", evidence: null, unavailable_reason: "vendor_not_configured", fetched_at: null },
      seo: { state: "done", evidence: null, points: 13, fetched_at: null },
    };
    expect(scoreCard(parts)).toEqual({
      total: 28,
      out_of: 40,
      by_check: { google: 15, ai: null, seo: 13, design: null, compare: null },
    });
  });

  it("is deterministic and clamps points to 0..20", () => {
    const parts: StartCardParts = { google: { state: "done", evidence: null, points: 99, fetched_at: null } };
    expect(scoreCard(parts)).toEqual(scoreCard(parts));
    expect(scoreCard(parts).by_check.google).toBe(20);
  });
});

describe("fixture", () => {
  it("uses a real status and a done card has every part", () => {
    expect(START_CARD_STATUSES).toContain(START_CARD_DONE_FIXTURE.status);
    expect(Object.keys(START_CARD_DONE_FIXTURE.parts).sort()).toEqual(
      ["ai", "compare", "design", "diagnosis", "google", "profile", "seo"],
    );
  });
});

describe("stage contract", () => {
  it("a check with no profile reports unavailable (not 0)", async () => {
    await expect(
      runGoogleStage({ card_id: "c", domain: "acme.com", url: "https://acme.com/", profile: null, parts: {} }),
    ).rejects.toBeInstanceOf(StageUnavailableError);
  });
});
