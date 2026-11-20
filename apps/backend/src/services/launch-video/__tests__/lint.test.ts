import { describe, it, expect } from "vitest";
import { lintVideoBrief, isOutwardClaimType, formatLintAdvisory, selectAdvisories } from "../lint";
import { intakeToVideoBrief, type LaunchVideoIntake, type VideoBrief } from "../brief-mapper";

const base: LaunchVideoIntake = {
  product_name: "Upcar",
  one_liner: "Rent the perfect car from local hosts.",
  url: "https://upcar.ai",
  audience: "people who need a car for the weekend",
  tone: "bold",
  features: [
    { title: "Book in two minutes", detail: "Find a car near you and reserve it instantly." },
    { title: "Real local hosts", detail: "Thousands of cars from real people in your city." },
    { title: "Fully insured", detail: "Every trip covered end to end." },
  ],
  cta_text: "Start your trip",
  cta_url: "https://upcar.ai",
};

function adBriefWith(hookHeadline?: string): VideoBrief {
  const brief = intakeToVideoBrief({ ...base, video_type: "ad" });
  if (hookHeadline) {
    const hook = brief.beats.find((b) => b.kind === "hook");
    if (hook && hook.kind === "hook") hook.headline = hookHeadline;
  }
  return brief;
}

describe("isOutwardClaimType", () => {
  it("ad + social get the ad-policy rule set; launch/explainer/story do not", () => {
    expect(isOutwardClaimType("ad")).toBe(true);
    expect(isOutwardClaimType("social")).toBe(true);
    expect(isOutwardClaimType("launch")).toBe(false);
    expect(isOutwardClaimType("explainer")).toBe(false);
    expect(isOutwardClaimType("story")).toBe(false);
  });
});

describe("lintVideoBrief — clean ad passes", () => {
  it("a grounded, claim-clean ad passes (ok=true, no violations)", () => {
    const r = lintVideoBrief(adBriefWith(), "ad");
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("a clean launch also passes", () => {
    const r = lintVideoBrief(intakeToVideoBrief(base), "launch");
    expect(r.ok).toBe(true);
  });
});

describe("lintVideoBrief — flags fabricated / policy-violating ad claims", () => {
  it("FLAGS a fabricated financial claim (get-rich / guaranteed returns)", () => {
    const r = lintVideoBrief(adBriefWith("Guaranteed returns — double your money in a week!"), "ad");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "ad.financial_claim")).toBe(true);
  });

  it("FLAGS an unverifiable health/weight-loss claim", () => {
    const r = lintVideoBrief(adBriefWith("Lose 20 pounds fast, clinically proven."), "ad");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "ad.health_claim")).toBe(true);
  });

  it("FLAGS a fabricated endorsement", () => {
    const r = lintVideoBrief(adBriefWith("9 out of 10 doctors recommend Upcar."), "ad");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "ad.fabricated_endorsement")).toBe(true);
  });

  it("FLAGS an unsupported superlative (generic, all types)", () => {
    const r = lintVideoBrief(adBriefWith("The #1 best car rental, guaranteed."), "ad");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "generic.superlative")).toBe(true);
  });

  it("FLAGS fake urgency / a misleading countdown", () => {
    const r = lintVideoBrief(adBriefWith("Only today — just 3 spots left!"), "ad");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "generic.fake_urgency")).toBe(true);
  });

  it("FLAGS when an avoid-list term survived into the copy", () => {
    const r = lintVideoBrief(adBriefWith("Cheapest prices, no hidden price."), "ad", { avoid: ["price"] });
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code === "generic.avoid_violation")).toBe(true);
  });

  it("formatLintAdvisory produces a pre-publish warning listing the reasons + caveats", () => {
    const r = lintVideoBrief(adBriefWith("Guaranteed returns, double your money."), "ad");
    const msg = formatLintAdvisory(r);
    expect(msg).toBeDefined();
    expect(msg).toContain("ad-policy");
    expect(msg!.toLowerCase()).toContain("before you publish");
    expect(msg!.toLowerCase()).not.toContain("couldn't");
    expect(msg!.toLowerCase()).toContain("not auto-checkable");
  });
});

describe("lintVideoBrief — superlative hedging", () => {
  it.each([
    "You keep 90% of every trip. One of the best splits in car sharing.",
    "Among the best payouts in the category.",
    "Some of the best hosts in the state.",
    "One of the world's best car-sharing payouts.",
    "Among the world's best rated hosts.",
    "One of the fastest ways to earn from your car.",
    "Among the cheapest options in the city.",
  ])("does NOT flag a hedged comparative: %s", (copy) => {
    const r = lintVideoBrief(adBriefWith(copy), "ad");
    expect(r.violations.some((v) => v.code === "generic.superlative")).toBe(false);
  });

  it.each([
    "The best split in car sharing.",
    "The world's best car rental app.",
    "The #1 way to rent a car.",
    "Number one for hosts.",
    "The fastest way to earn from your car.",
    "Guaranteed to beat your current payout.",
    "The only car-sharing app that pays 90%.",
    "One of our hosts said it: this is the best app, guaranteed.",
  ])("STILL flags an unhedged absolute claim: %s", (copy) => {
    const r = lintVideoBrief(adBriefWith(copy), "ad");
    expect(r.violations.some((v) => v.code === "generic.superlative")).toBe(true);
  });
});

describe("selectAdvisories — only warn about videos that actually landed", () => {
  it("drops the advisory for a variant whose upload failed", () => {
    const advisories = new Map([
      ["A", "A is fine but caveated"],
      ["B", "B trips the superlative rule"],
    ]);
    const out = selectAdvisories(advisories, new Set(["A"]), true);
    expect(out).toContain("*Variant A*");
    expect(out).not.toContain("*Variant B*");
  });

  it("returns undefined when NO variant landed (never warn into a video-less thread)", () => {
    const advisories = new Map([["A", "something to fix"]]);
    expect(selectAdvisories(advisories, new Set(), true)).toBeUndefined();
  });

  it("omits the variant label on a single-variant run", () => {
    const advisories = new Map([["A", "fix the hook"]]);
    const out = selectAdvisories(advisories, new Set(["A"]), false);
    expect(out).toBe("fix the hook");
  });

  it("returns undefined when the lint was clean (no advisories to post)", () => {
    expect(selectAdvisories(new Map(), new Set(["A"]), false)).toBeUndefined();
  });
});

describe("lintVideoBrief — advisory for EVERY type, nothing fails closed", () => {
  it("an EXPLAINER superlative reports ok=false but carries no ad-specific checks", () => {
    const brief = intakeToVideoBrief({ ...base, video_type: "explainer" });
    const cta = brief.beats.at(-1);
    if (cta) (cta as { headline?: string }).headline = "The best, guaranteed.";
    const r = lintVideoBrief(brief, "explainer");
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.code.startsWith("ad."))).toBe(false);
  });

  it("a clean brief yields NO advisory at all (no reassuring noise attached to the video)", () => {
    const r = lintVideoBrief(intakeToVideoBrief({ ...base, video_type: "explainer" }), "explainer");
    expect(r.ok).toBe(true);
    expect(formatLintAdvisory(r)).toBeUndefined();
  });

  it("isOutwardClaimType selects the RULE SET — it no longer gates delivery", () => {
    expect(isOutwardClaimType("ad")).toBe(true);
    expect(isOutwardClaimType("explainer")).toBe(false);
  });
});
