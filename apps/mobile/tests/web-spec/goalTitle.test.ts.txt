import { describe, expect, it } from "vitest";
import type { GrowthGoal } from "@/lib/workspace/useGrowthPlan";
import { goalTitle } from "./GrowthGoals";
import { shortDate } from "./growthPresentation";

const NOW = new Date("2026-09-24T12:00:00Z");
const g = (over: Partial<GrowthGoal>): GrowthGoal =>
  ({
    id: "g",
    objective: "Grow verified hosts to 800 by the end of September",
    target_metric: "verified_hosts",
    target_value: 800,
    baseline_value: null,
    current_value: 612,
    due_date: "2026-09-30",
    status: "active",
    priority: 1,
    ...over,
  }) as GrowthGoal;

describe("goalTitle", () => {
  it("builds the title from the goal's own fields when measured", () => {
    expect(goalTitle(g({}), NOW)).toBe("Verified Hosts 612 / 800 · by Sep 30");
  });

  it("uses an arrow to the target when there is no current value", () => {
    expect(goalTitle(g({ target_metric: "activation_rate", target_value: 5, current_value: null, due_date: "2026-12-11" }), NOW)).toBe(
      "Activation Rate → 5% · by Dec 11",
    );
  });

  it("formats money the way the goal editor does, and keeps acronyms", () => {
    expect(goalTitle(g({ target_metric: "mrr", target_value: 100000, current_value: 1390 }), NOW)).toBe(
      "MRR $1,390 / $100,000 · by Sep 30",
    );
  });

  it("leaves the date off when there is none, and keeps the year when it is not this year", () => {
    expect(goalTitle(g({ due_date: null }), NOW)).toBe("Verified Hosts 612 / 800");
    expect(goalTitle(g({ due_date: "2027-03-03" }), NOW)).toBe("Verified Hosts 612 / 800 · by Mar 3, 2027");
  });

  it("returns null with no target or no metric, so the objective shows instead", () => {
    expect(goalTitle(g({ target_value: null }), NOW)).toBeNull();
    expect(goalTitle(g({ target_metric: "" }), NOW)).toBeNull();
    expect(goalTitle(g({ target_metric: "   " }), NOW)).toBeNull();
  });

  it("adds no words the goal does not store", () => {
    const title = goalTitle(g({}), NOW)!;
    for (const word of title.split(/\s+/)) {
      expect(["Verified", "Hosts", "612", "/", "800", "·", "by", "Sep", "30"]).toContain(word);
    }
  });
});

describe("shortDate", () => {
  it("drops the year in the current year only", () => {
    expect(shortDate("2026-12-23", NOW)).toBe("Dec 23");
    expect(shortDate("2027-01-02", NOW)).toBe("Jan 2, 2027");
  });
});
