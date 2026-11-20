import { describe, it, expect } from "vitest";
import { renderLiveStuntReviewEmail } from "../live-stunt-review";

describe("renderLiveStuntReviewEmail", () => {
  it("renders day, headline, link and the not-public-yet line", () => {
    const r = renderLiveStuntReviewEmail({
      day: "2026-10-03",
      dayNumber: 3,
      headline: "Raised Meta <b>",
      link: "https://www.zaviagent.com/live/upcar/review/2026-10-03?t=abc",
      ttlHours: 72,
    });
    expect(r.subject).toBe("Mission log, day 3: review and publish");
    expect(r.html).toContain("Raised Meta &lt;b&gt;");
    expect(r.html).toContain("/live/upcar/review/2026-10-03?t=abc");
    expect(r.html).toContain(">Zavi</a>");
    expect(r.html).not.toMatch(/<img[^>]*zavi-wordmark/i);
    expect(r.html).toContain("<!doctype html>");
    expect(r.text).toContain(
      "Nothing is public until you press Publish. The link works once, for 72 hours.",
    );
    expect(r.text + r.html).not.toContain("—");
  });
});
