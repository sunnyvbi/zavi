import { describe, expect, it } from "vitest";
import * as offers from "./offers";
import { offerDue, offerTitleOf, offerWhat, offerWhen } from "./offers";

describe("offer due wording", () => {
  it("a creator's offer that names a day reads that day", () => {
    const o = { delivery_days: 15, terms: { due_date: "2026-10-11" } };
    expect(offerDue(o)).toBe("Oct 11");
    expect(offerWhen(o)).toBe("due Oct 11");
  });
  it("an offer of N days reads days after it starts", () => {
    const o = { delivery_days: 7, terms: {} };
    expect(offerDue(o)).toBe("7 days after it starts");
    expect(offerWhen(o)).toBe("delivered in 7 days after it starts");
  });
});

describe("an offer is always UGC video", () => {
  it("there is no content type to pick and no audience kind to send", () => {
    expect(offers).not.toHaveProperty("CONTENT_TYPES");
    expect(offers).not.toHaveProperty("offerKind");
    expect(offerTitleOf(1)).toBe("1 UGC video");
    expect(offerTitleOf(3)).toBe("3 UGC videos");
  });
  it("an old audience offer with no title reads neutrally", () => {
    expect(offerWhat({ kind: "ugc_video", terms: {} })).toBe("Custom video");
    expect(offerWhat({ kind: "audience_post", terms: {} })).toBe("Custom offer");
  });
});
