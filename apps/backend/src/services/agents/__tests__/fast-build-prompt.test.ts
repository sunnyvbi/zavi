import { describe, it, expect } from "vitest";
import { fastSiteBuildPrompt, fastSiteEditPrompt, fastSiteRefinePrompt, FAST_BUILD_REPLACEABLE_STARTER_PATHS, KEEP_JOURNEYS_RULE, SITE_LOOK_RULE } from "../fast-build-prompt";

describe("fastSiteBuildPrompt rule 1", () => {
  const base = { companyName: "Shop", targetRepo: "Praxis-build/shop-1", idea: "a bakery" };

  it("first pass: the first write is the replaceable starter home page", () => {
    const p = fastSiteBuildPrompt(base);
    for (const path of FAST_BUILD_REPLACEABLE_STARTER_PATHS) expect(p).toContain(`FIRST file write is \`${path}\``);
  });

  it("a pooled site gets the Zavi SDK contract and NO Supabase / SQL guidance; a dedicated one keeps today's", () => {
    const pooled = fastSiteBuildPrompt({ ...base, backend: "pooled", quality: { siteMeta: true } });
    expect(pooled).toContain("Vite + React + Zavi");
    expect(pooled).toContain("src/zavi/");
    expect(pooled).toContain("zavi.data");
    expect(pooled).not.toMatch(/supabase-js v2|VITE_SUPABASE_URL|supabase\/migrations\/NNN|profiles\.role|NotFound\.tsx/);
    const dedicated = fastSiteBuildPrompt({ ...base, quality: { siteMeta: true } });
    expect(dedicated).toContain("supabase/migrations/NNN_name.sql");
    expect(dedicated).toContain("VITE_SUPABASE_URL");
    expect(dedicated).not.toContain("zavi.data");
    expect(fastSiteBuildPrompt({ ...base, backend: "dedicated" })).toBe(fastSiteBuildPrompt(base));
  });

  it("a build with no plan and no facts still forbids invented social proof", () => {
    const p = fastSiteBuildPrompt(base);
    expect(p).not.toContain("### The site plan");
    expect(p).toMatch(/No reviews, ratings, "trusted by" lines, customer counts or years in business unless the founder's idea/);
  });

  it("fix pass: no home-first order", () => {
    const p = fastSiteBuildPrompt({ ...base, repairSignal: "smoke failed", repairAttempt: 1 });
    expect(p).not.toContain("FIRST file write");
    expect(p).toContain("FIX PASS #1");
    expect(p).toContain(KEEP_JOURNEYS_RULE);
    expect(fastSiteBuildPrompt(base)).not.toContain(KEEP_JOURNEYS_RULE);
  });

  it("the first-publish fix (a refine repair) is told to keep its smoke journeys too", () => {
    const refine = { targetRepo: "Praxis-build/shop-1", request: "fix the site", backend: "pooled" as const };
    expect(fastSiteRefinePrompt({ ...refine, repairSignal: 'journey "open-times" failed', repairAttempt: 1 })).toContain(KEEP_JOURNEYS_RULE);
    expect(fastSiteRefinePrompt(refine)).not.toContain(KEEP_JOURNEYS_RULE);
  });
});

describe("edits keep the brand the build set (edit drift)", () => {
  const repo = "Praxis-build/shop-1";
  const prompts = {
    "chat refine": fastSiteRefinePrompt({ targetRepo: repo, request: "add an FAQ section", backend: "pooled" }),
    "preview-check / pill fix pass": fastSiteRefinePrompt({
      targetRepo: repo,
      request: "fix the error",
      backend: "pooled",
      repairSignal: "visible error text on /: \"Something went wrong\"",
      repairAttempt: 1,
    }),
    "dedicated refine": fastSiteRefinePrompt({ targetRepo: repo, request: "add an FAQ section", backend: "dedicated" }),
    "fast edit": fastSiteEditPrompt({ targetRepo: repo, request: "make the button say Book now", backend: "pooled" }),
  };

  for (const [name, p] of Object.entries(prompts)) {
    it(`${name}: styles with the site's tokens, never raw colours, and never brings back placeholder copy`, () => {
      expect(p).toContain(SITE_LOOK_RULE);
      expect(p).toContain("`src/index.css`");
      expect(p).toMatch(/never raw hex or Tailwind palette colours/);
      expect(p).toMatch(/This site is being built/);
    });
  }

  it("the rule sits inside the numbered Rules, after the founder's untrusted request", () => {
    const p = prompts["chat refine"];
    expect(p.indexOf(SITE_LOOK_RULE)).toBeGreaterThan(p.indexOf("### Rules"));
    expect(p).toMatch(new RegExp(`\\n8\\. ${SITE_LOOK_RULE.slice(0, 20)}`));
    expect(prompts["fast edit"]).toMatch(new RegExp(`\\n7\\. ${SITE_LOOK_RULE.slice(0, 20)}`));
  });
});
