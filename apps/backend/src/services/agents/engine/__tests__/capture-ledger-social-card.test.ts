import { describe, it, expect, beforeEach } from "vitest";
import {
  recordCapture,
  unverifiedCaptures,
  getCapturedText,
  __resetCaptureLedgerForTest,
} from "../capture-ledger";

const RUN = "run-social-card";

describe("social_card capture trust", () => {
  beforeEach(() => __resetCaptureLedgerForTest());

  it("is included in unverifiedCaptures (not trusted as a full read)", () => {
    recordCapture(RUN, {
      requested_url: "https://www.linkedin.com/in/x/",
      final_url: "https://www.linkedin.com/in/x/",
      capture: "social_card",
      status: 200,
      truncated: false,
    });
    const unv = unverifiedCaptures(RUN);
    expect(unv).toHaveLength(1);
    expect(unv[0].capture).toBe("social_card");
  });

  it("dom_text / rendered captures stay OUT of unverifiedCaptures (regression guard)", () => {
    recordCapture(RUN, {
      requested_url: "https://example.com/a",
      final_url: "https://example.com/a",
      capture: "dom_text",
      status: 200,
      truncated: false,
      text_snippet: "real page text",
    });
    expect(unverifiedCaptures(RUN)).toHaveLength(0);
    expect(getCapturedText(RUN, "https://example.com/a")).toContain("real page text");
  });
});
