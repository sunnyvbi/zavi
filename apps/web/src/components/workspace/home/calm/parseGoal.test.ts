import { describe, expect, it } from "vitest";
import { parseGoal, goalCreateBody } from "./parseGoal";

const NOW = new Date("2026-07-07T00:00:00Z");

describe("parseGoal", () => {
  it("extracts a percentage target + metric keyword", () => {
    const p = parseGoal("Get host activation to 70% by end of Q3", NOW);
    expect(p.target_value).toBe(70);
    expect(p.unit).toBe("percent");
    expect(p.target_metric).toBe("activation");
    expect(p.targetLabel).toBe("70%");
    expect(p.due_date).toBe("2026-09-30");
    expect(p.dueLabel).toBe("by Q3 2026");
  });

  it("extracts a plain-number target + comma numbers", () => {
    const p = parseGoal("Grow verified hosts to 1,200", NOW);
    expect(p.target_value).toBe(1200);
    expect(p.unit).toBe("number");
    expect(p.target_metric).toBe("hosts");
    expect(p.targetLabel).toBe("1,200");
    expect(p.due_date).toBeNull();
  });

  it("reads a baseline from 'from N' and doesn't confuse it with the target", () => {
    const p = parseGoal("Move activation from 58% to 70%", NOW);
    expect(p.baseline_value).toBe(58);
    expect(p.target_value).toBe(70);
  });

  it("does not read a due-clause year as the target", () => {
    const p = parseGoal("Launch buy/sell in 3 new states by 2027", NOW);
    expect(p.target_value).toBe(3);
    expect(p.due_date).toBe("2027-12-31");
    expect(p.dueLabel).toBe("by end of 2027");
  });

  it("resolves 'by <month>' to end of month", () => {
    const p = parseGoal("Grow signups to 500 by September", NOW);
    expect(p.target_metric).toBe("signups");
    expect(p.due_date).toBe("2026-09-30");
    expect(p.dueLabel).toBe("by September 2026");
  });

  it("handles no number gracefully", () => {
    const p = parseGoal("Improve customer retention", NOW);
    expect(p.target_value).toBeNull();
    expect(p.targetLabel).toBe("Set a target");
    expect(p.target_metric).toBe("retention");
  });

  it("falls back to a stripped objective phrase when no keyword matches", () => {
    const p = parseGoal("Reach 40 partnerships to close the quarter", NOW);
    expect(p.target_value).toBe(40);
    expect(p.target_metric.toLowerCase()).toContain("partnerships");
  });

  it("trims + normalizes whitespace in the objective", () => {
    const p = parseGoal("   Hold   blended  MER  above  2.5x  ", NOW);
    expect(p.objective).toBe("Hold blended MER above 2.5x");
    expect(p.target_metric).toBe("MER");
  });
});

describe("goalCreateBody", () => {
  it("OMITS target_value entirely when the text carries no number", () => {
    const p = parseGoal("Cut host verification time");
    expect(p.target_value).toBeNull();
    expect(p.targetLabel).toBe("Set a target");

    const body = goalCreateBody(p);
    expect("target_value" in body).toBe(false);
    expect(body.target_value).not.toBe(0);
    expect(body.objective).toBe("Cut host verification time");
  });

  it("no number anywhere in the text still yields a body with no target key", () => {
    for (const text of [
      "Make onboarding feel faster",
      "Improve retention",
      "Cut host verification time",
    ]) {
      const body = goalCreateBody(parseGoal(text, NOW));
      expect("target_value" in body, text).toBe(false);
    }
  });

  it("sends a parsed target as-is", () => {
    const body = goalCreateBody(parseGoal("Grow verified hosts to 800"));
    expect(body.target_value).toBe(800);
  });

  it("sends a percentage target as-is", () => {
    const body = goalCreateBody(parseGoal("Get activation to 70% from 58%"));
    expect(body.target_value).toBe(70);
    expect(body.baseline_value).toBe(58);
  });

  it("an operator's EXPLICIT zero is a real target and IS sent", () => {
    const p = parseGoal("Cut churn to 0");
    expect(p.target_value).toBe(0);
    const body = goalCreateBody(p);
    expect("target_value" in body).toBe(true);
    expect(body.target_value).toBe(0);
  });

  it("optional fields stay optional (absent, not null)", () => {
    const body = goalCreateBody(parseGoal("Grow signups to 500"));
    expect("baseline_value" in body).toBe(false);
    expect("due_date" in body).toBe(false);
  });
});
