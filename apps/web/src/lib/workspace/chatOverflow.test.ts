import { describe, it, expect } from "vitest";
import { readScrubbedOverflow } from "./chatOverflow";

describe("readScrubbedOverflow — renders only provably-scrubbed overflow", () => {
  it("returns the overflow when the row proves it was scrubbed", () => {
    expect(
      readScrubbedOverflow({ overflow_scrubbed: true, full_reply_markdown: "the full answer" }),
    ).toBe("the full answer");
  });

  it("returns NOTHING when the scrub marker is absent (legacy, presumed unscrubbed)", () => {
    expect(readScrubbedOverflow({ full_reply_markdown: "raw jane.doe@example.com text" })).toBeUndefined();
  });

  it("returns NOTHING for the legacy NESTED path — that copy is the unscrubbed one", () => {
    expect(
      readScrubbedOverflow({
        envelope: {
          metadata: {
            report_lead_collapsed: true,
            full_reply_markdown: "unscrubbed jane.doe@example.com body",
          },
        },
      }),
    ).toBeUndefined();
  });

  it("does not trust a non-literal-true marker", () => {
    for (const marker of ["true", 1, {}, null]) {
      expect(
        readScrubbedOverflow({ overflow_scrubbed: marker, full_reply_markdown: "body" }),
      ).toBeUndefined();
    }
  });

  it("returns nothing on empty / missing / malformed meta", () => {
    expect(readScrubbedOverflow(null)).toBeUndefined();
    expect(readScrubbedOverflow(undefined)).toBeUndefined();
    expect(readScrubbedOverflow("nope")).toBeUndefined();
    expect(readScrubbedOverflow([])).toBeUndefined();
    expect(readScrubbedOverflow({ overflow_scrubbed: true })).toBeUndefined();
    expect(readScrubbedOverflow({ overflow_scrubbed: true, full_reply_markdown: "" })).toBeUndefined();
  });
});
