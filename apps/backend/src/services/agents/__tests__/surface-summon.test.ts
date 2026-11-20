
import { describe, it, expect } from "vitest";
import {
  SUMMON_REGISTRY,
  resolveSummonedSurface,
  surfacesForAgent,
} from "../surface-summon";

describe("resolveSummonedSurface — positives (builds)", () => {
  const hits = [
    "what pull requests are open?",
    "show me my PRs",
    "anything awaiting my merge?",
    "is there anything waiting on merge",
    "which ones are ready to merge",
    "what's the build status",
    "status of the deployment",
    "what did you ship this week",
    "what's shipped so far",
    "did the build pass",
  ];
  for (const text of hits) {
    it(`mounts builds for: ${text}`, () => {
      const r = resolveSummonedSurface("operator", text);
      expect(r).not.toBeNull();
      expect(r?.key).toBe("builds");
      expect(r?.dashboard_slug).toBe("engineer");
    });
  }
});

describe("resolveSummonedSurface — negatives (nothing mounts)", () => {
  const misses = [
    "build me a landing page for the new pricing tier",
    "build a marketplace for dog walkers",
    "what should our PR strategy be for the launch",
    "draft a PR announcement",
    "what's our MRR",
    "cut wasted ad spend on the retargeting campaigns",
    "rewrite the pricing page",
    "find where signups drop off",
    "why is CPA up this week",
    "",
    "   ",
  ];
  for (const text of misses) {
    it(`mounts nothing for: ${JSON.stringify(text)}`, () => {
      expect(resolveSummonedSurface("operator", text)).toBeNull();
    });
  }
});

describe("resolveSummonedSurface — gating", () => {
  it("only operator may summon in slice 1 (engineer's tab already shows it)", () => {
    const text = "what pull requests are open?";
    expect(resolveSummonedSurface("operator", text)).not.toBeNull();
    expect(resolveSummonedSurface("engineer", text)).toBeNull();
    expect(resolveSummonedSurface("performance-marketer", text)).toBeNull();
  });

  it("an unknown or empty agent slug summons nothing", () => {
    expect(resolveSummonedSurface("", "show me my PRs")).toBeNull();
    expect(resolveSummonedSurface("not-an-agent", "show me my PRs")).toBeNull();
    expect(surfacesForAgent("")).toEqual([]);
  });

  it("returns AT MOST one surface — a reply mounts one thing or nothing", () => {
    const r = resolveSummonedSurface("operator", "what pull requests are open and what's the build status");
    expect(r).not.toBeNull();
    expect(Array.isArray(r)).toBe(false);
  });
});

describe("SUMMON_REGISTRY invariants", () => {
  it("keys are unique lowercase-kebab", () => {
    const keys = SUMMON_REGISTRY.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("no trigger carries the /g flag (a stateful regex would alternate hit/miss)", () => {
    for (const s of SUMMON_REGISTRY) expect(s.trigger.global).toBe(false);
  });

  it("the persisted payload is flat scalars only — no user content on meta", () => {
    const r = resolveSummonedSurface("operator", "show me my PRs");
    expect(r).not.toBeNull();
    expect(Object.keys(r!).sort()).toEqual(["dashboard_slug", "key", "label"]);
    for (const v of Object.values(r!)) expect(typeof v).toBe("string");
  });
});
