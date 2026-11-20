import { describe, it, expect } from "vitest";
import {
  normalizeVerdict,
  computeSkillLift,
  caseSkill,
  type AbTrial,
  type BlindPlacement,
} from "../../../scripts/skill-ab-lift";
import { REPLAY_CASES } from "../../../scripts/skill-runtime-replay-cases";

const injectA: BlindPlacement = { a_arm: "inject", b_arm: "suppress" };
const suppressA: BlindPlacement = { a_arm: "suppress", b_arm: "inject" };

describe("normalizeVerdict — de-anonymize a blind token via placement", () => {
  it("maps position to the arm that sat there (inject-as-A)", () => {
    expect(normalizeVerdict("A", injectA)).toBe("inject");
    expect(normalizeVerdict("B", injectA)).toBe("suppress");
  });
  it("maps position to the arm that sat there (suppress-as-A) — position bias cancels", () => {
    expect(normalizeVerdict("A", suppressA)).toBe("suppress");
    expect(normalizeVerdict("B", suppressA)).toBe("inject");
  });
  it("passes tie/error through unchanged regardless of placement", () => {
    expect(normalizeVerdict("tie", injectA)).toBe("tie");
    expect(normalizeVerdict("tie", suppressA)).toBe("tie");
    expect(normalizeVerdict("error", injectA)).toBe("error");
  });
  it("throws on a malformed placement so a driver bug can't miscredit lift", () => {
    expect(() => normalizeVerdict("A", { a_arm: "inject", b_arm: "inject" })).toThrow(/invalid BlindPlacement/);
  });
});

describe("computeSkillLift — reduce trials to a per-skill lift number", () => {
  const t = (skill: string, winner: AbTrial["winner"]): AbTrial => ({ skill, winner });

  it("all-inject wins → lift +1 and verdict 'helps'", () => {
    const r = computeSkillLift([t("page-cro", "inject"), t("page-cro", "inject"), t("page-cro", "inject")]);
    const s = r.perSkill[0];
    expect(s.skill).toBe("page-cro");
    expect(s.lift).toBe(1);
    expect(s.graded).toBe(3);
    expect(s.verdict).toBe("helps");
  });

  it("all-suppress wins → lift -1 and verdict 'hurts'", () => {
    const r = computeSkillLift([t("seo-audit", "suppress"), t("seo-audit", "suppress"), t("seo-audit", "suppress")]);
    expect(r.perSkill[0].lift).toBe(-1);
    expect(r.perSkill[0].verdict).toBe("hurts");
  });

  it("even split → lift 0 and verdict 'neutral'", () => {
    const r = computeSkillLift([t("copywriting", "inject"), t("copywriting", "suppress"), t("copywriting", "tie")]);
    const s = r.perSkill[0];
    expect(s.lift).toBe(0);
    expect(s.ties).toBe(1);
    expect(s.verdict).toBe("neutral");
  });

  it("ties count toward graded (denominator) but not the numerator", () => {
    const r = computeSkillLift([t("copywriting", "inject"), t("copywriting", "inject"), t("copywriting", "tie"), t("copywriting", "tie")]);
    const s = r.perSkill[0];
    expect(s.graded).toBe(4);
    expect(s.lift).toBe(0.5);
    expect(s.verdict).toBe("helps");
  });

  it("errors are excluded from graded entirely", () => {
    const r = computeSkillLift([t("page-cro", "inject"), t("page-cro", "inject"), t("page-cro", "inject"), t("page-cro", "error"), t("page-cro", "error")]);
    const s = r.perSkill[0];
    expect(s.errors).toBe(2);
    expect(s.graded).toBe(3);
    expect(s.lift).toBe(1);
  });

  it("below minGraded → 'insufficient' no matter the direction", () => {
    const r = computeSkillLift([t("page-cro", "inject"), t("page-cro", "inject")], { minGraded: 3 });
    expect(r.perSkill[0].graded).toBe(2);
    expect(r.perSkill[0].verdict).toBe("insufficient");
  });

  it("graded === 0 → lift 0, no divide-by-zero", () => {
    const r = computeSkillLift([t("page-cro", "error"), t("page-cro", "error")]);
    expect(r.perSkill[0].graded).toBe(0);
    expect(r.perSkill[0].lift).toBe(0);
    expect(r.perSkill[0].verdict).toBe("insufficient");
  });

  it("threshold is configurable (net-majority tuning)", () => {
    const trials = [t("seo-audit", "inject"), t("seo-audit", "inject"), t("seo-audit", "suppress")];
    expect(computeSkillLift(trials).perSkill[0].verdict).toBe("neutral");
    expect(computeSkillLift(trials, { threshold: 0.3 }).perSkill[0].verdict).toBe("helps");
  });

  it("groups by skill, sorts deterministically, and pools an overall", () => {
    const r = computeSkillLift([
      t("seo-audit", "inject"),
      t("copywriting", "suppress"),
      t("page-cro", "tie"),
      t("copywriting", "inject"),
    ]);
    expect(r.perSkill.map((s) => s.skill)).toEqual(["copywriting", "page-cro", "seo-audit"]);
    expect(r.overall.skill).toBe("__overall__");
    expect(r.overall.graded).toBe(4);
    expect(r.overall.lift).toBe(0.25);
  });
});

describe("caseSkill — clean single-skill attribution via the deterministic matcher", () => {
  it("attributes a single-skill positive case to that skill", () => {
    const seo = REPLAY_CASES.find((c) => c.id === "pos-seo-audit")!;
    expect(caseSkill(seo)).toBe("seo-audit");
    const cro = REPLAY_CASES.find((c) => c.id === "pos-landing-cro")!;
    expect(caseSkill(cro)).toBe("page-cro");
  });

  it("returns null for a negative case (nothing to A/B)", () => {
    const neg = REPLAY_CASES.find((c) => c.id === "neg-mrr-data")!;
    expect(caseSkill(neg)).toBeNull();
  });

  it("returns null when a prompt matches ≥2 skills (ambiguous credit)", () => {
    expect(caseSkill({ agent_slug: "content-design", prompt: "Rewrite our headline copy so the landing page converts better." })).toBeNull();
  });
});
