
import { describe, it, expect } from "vitest";
import { planBriefBackfill, isWriteAction } from "../backfill-plan";

describe("planBriefBackfill", () => {
  it("renders a tenant whose story is in the record and whose note is stale", () => {
    expect(
      planBriefBackfill({
        hasStory: true,
        renderedBody: "# Acme\n\nWe rent cars.",
        liveBody: "old model prose",
      }),
    ).toBe("render");
  });

  it("renders a tenant with facts but no live note at all", () => {
    expect(
      planBriefBackfill({ hasStory: true, renderedBody: "# Acme\n\nWe rent cars.", liveBody: null }),
    ).toBe("render");
  });

  it("never touches a tenant whose story is not in the record", () => {
    expect(
      planBriefBackfill({ hasStory: false, renderedBody: "# Acme", liveBody: "the founder's own words" }),
    ).toBe("skip_no_story");
  });

  it("never retires: a record that renders to nothing is skipped, not cleared", () => {
    expect(
      planBriefBackfill({ hasStory: true, renderedBody: null, liveBody: "an existing brief" }),
    ).toBe("skip_would_empty");
  });

  it("skips a note that is already byte-identical to the render", () => {
    const body = "# Acme\n\nWe rent cars.";
    expect(planBriefBackfill({ hasStory: true, renderedBody: body, liveBody: body })).toBe(
      "skip_already_current",
    );
  });

  it("treats a near-miss body as stale", () => {
    expect(
      planBriefBackfill({
        hasStory: true,
        renderedBody: "# Acme\n\nWe rent cars.",
        liveBody: "# Acme\n\nWe rent cars. ",
      }),
    ).toBe("render");
  });

  it("reports the missing story first when both are true", () => {
    expect(planBriefBackfill({ hasStory: false, renderedBody: null, liveBody: "x" })).toBe(
      "skip_no_story",
    );
  });

  it("only `render` writes", () => {
    expect(isWriteAction("render")).toBe(true);
    for (const a of ["skip_no_story", "skip_would_empty", "skip_already_current"] as const) {
      expect(isWriteAction(a)).toBe(false);
    }
  });
});
