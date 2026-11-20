import { describe, it, expect } from "vitest";
import { AGE_OPTIONS, afterSignup, breakLine, modeOf, nextStepHref, refToName, stepsFor, validate } from "./ApplyFlow";
import { defaultPackage } from "@/lib/creator/packageSpec";

const base = { goals: { affiliate: false, jobs: false }, age: "", lanes: [], handles: {}, followers: {}, niches: [], pkg: defaultPackage() };

describe("creator setup validation (D1, D2)", () => {
  it("the age is a pick from 18 up, and under 18 is refused", () => {
    expect(AGE_OPTIONS[0]).toBe(18);
    expect(AGE_OPTIONS).toContain(22);
    expect(validate("account", base).age).toBe("Pick your age.");
    expect(validate("account", { ...base, age: "17" }).age).toBe("You need to be 18 or older to sell on Zavi.");
    expect(validate("account", { ...base, age: "22" })).toEqual({});
  });

  it("each picked platform needs a real profile and a follower number", () => {
    expect(validate("make", { ...base, niches: ["Tech"] }).lanes).toBe("Pick at least one platform.");
    expect(validate("make", { ...base, lanes: ["TikTok"], handles: { TikTok: "instagram.com/x" }, niches: ["Tech"] }).lanes).toMatch(/Fix the profile link/);
    expect(validate("make", { ...base, lanes: ["TikTok"], handles: { TikTok: "@maya" }, niches: ["Tech"] }).lanes).toBe(
      "Add a follower number for each platform you picked.",
    );
    expect(validate("make", { ...base, lanes: ["TikTok"], handles: { TikTok: "@maya" }, followers: { TikTok: "1,200" }, niches: ["Tech"] })).toEqual({});
  });

  it("a package needs a price", () => {
    expect(validate("package", base).price).toBe("Set a price.");
  });

  it("?ref=acme-coffee reads Acme Coffee", () => {
    expect(refToName("acme-coffee")).toBe("Acme Coffee");
  });
});

describe("how you want to earn", () => {
  it("needs at least one pick", () => {
    expect(validate("goal", base).goal).toBe("Pick at least one.");
    expect(validate("goal", { ...base, goals: { affiliate: true, jobs: false } })).toEqual({});
    expect(modeOf({ affiliate: true, jobs: true })).toBe("both");
    expect(modeOf({ affiliate: false, jobs: true })).toBe("jobs");
    expect(modeOf({ affiliate: false, jobs: false })).toBeNull();
  });

  it("affiliate only skips photo and package; jobs and both keep them", () => {
    expect(stepsFor("affiliate").map((s) => s.id)).toEqual(["goal", "account", "make"]);
    expect(stepsFor("jobs").map((s) => s.id)).toEqual(["goal", "account", "make", "photo", "package"]);
    expect(stepsFor("both").map((s) => s.id)).toEqual(["goal", "account", "make", "photo", "package"]);
    expect(nextStepHref("make", "affiliate")).toBeNull();
    expect(nextStepHref("make", "both")).toBe("/creators/apply?step=photo");
    expect(breakLine("affiliate")).toBe("Your affiliate link is ready as soon as setup is done.");
  });

  it("a new creator starts at the goal step; anyone else goes home", () => {
    expect(afterSignup(true, "/creator")).toBe("/creators/apply?step=goal");
    expect(afterSignup(false, "/creator")).toBe("/creator");
    expect(afterSignup(true, "/workspace")).toBe("/workspace");
  });
});

describe("setup is one continuous flow", () => {
  it("each step lands on the next, and the last has none", () => {
    expect(nextStepHref("goal")).toBe("/creators/apply?step=account");
    expect(nextStepHref("account")).toBe("/creators/apply?step=make");
    expect(nextStepHref("make")).toBe("/creators/apply?step=photo");
    expect(nextStepHref("photo")).toBe("/creators/apply?step=package");
    expect(nextStepHref("package")).toBeNull();
  });
});
