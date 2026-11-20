import { describe, it, expect } from "vitest";
import {
  parseProposal,
  proposeGoalWith,
  buildProposerPrompt,
  MEASURABLE_METRICS,
  type ProposeModel,
} from "../goal-proposer";

describe("parseProposal — only usable, measurable proposals survive", () => {
  const ok = '{"objective":"Grow monthly bookings","target_metric":"bookings","target_value":50,"rationale":"marketplace"}';

  it("accepts a well-formed proposal with an allowed metric", () => {
    const p = parseProposal(ok);
    expect(p).not.toBeNull();
    expect(p!.target_metric).toBe("bookings");
    expect(p!.target_value).toBe(50);
  });

  it("rejects a metric outside the measurable vocab (would never resolve)", () => {
    expect(parseProposal('{"objective":"x","target_metric":"revenue","target_value":1000}')).toBeNull();
    expect(parseProposal('{"objective":"x","target_metric":"cac","target_value":10}')).toBeNull();
  });

  it("rejects a non-positive or non-numeric target", () => {
    expect(parseProposal('{"objective":"x","target_metric":"signups","target_value":0}')).toBeNull();
    expect(parseProposal('{"objective":"x","target_metric":"signups","target_value":"lots"}')).toBeNull();
  });

  it("rejects a missing objective", () => {
    expect(parseProposal('{"target_metric":"signups","target_value":10}')).toBeNull();
  });

  it("rejects non-JSON", () => {
    expect(parseProposal("here is a goal: grow signups")).toBeNull();
  });

  it("every allowed metric maps to the resolver regex families", () => {
    const re = [/book/, /sign[\s_-]?up/, /activat/, /purchase|order|sale/, /key[\s_-]?action/];
    for (const m of MEASURABLE_METRICS) {
      expect(re.some((r) => r.test(m))).toBe(true);
    }
  });
});

describe("proposeGoalWith — the proposer core", () => {
  const model: ProposeModel = async () =>
    '{"objective":"Grow signups","target_metric":"signups","target_value":100,"rationale":"signup-led"}';

  it("proposes nothing when the brain is empty (nothing honest to ground on)", async () => {
    let called = false;
    const spy: ProposeModel = async (p) => {
      called = true;
      return p;
    };
    expect(await proposeGoalWith("   ", spy)).toBeNull();
    expect(called).toBe(false);
  });

  it("returns a parsed proposal from a real brain", async () => {
    const p = await proposeGoalWith("We are a signup-led SaaS.", model);
    expect(p?.target_metric).toBe("signups");
  });

  it("returns null when the model call throws (never seed a junk goal)", async () => {
    const p = await proposeGoalWith("brain", async () => {
      throw new Error("model down");
    });
    expect(p).toBeNull();
  });
});

describe("buildProposerPrompt", () => {
  it("constrains the metric to the allowed list and includes the brain", () => {
    const p = buildProposerPrompt("We run a car-rental marketplace.");
    expect(p).toContain("car-rental marketplace");
    for (const m of MEASURABLE_METRICS) expect(p).toContain(m);
  });
});
