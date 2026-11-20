import { shapeLinkedIn } from "@/routes/agents/dashboards/linkedin-organic";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const FILES = [
  "src/channels/linkedin_organic/recipe.md",
  "src/agents/linkedin_organic/agent.md",
  "src/agents/linkedin_organic/skills/diagnose.md",
  "src/agents/linkedin_organic/skills/rank.md",
  "src/agents/linkedin_organic/skills/artifact.md",
  "src/agents/linkedin_organic/skills/references.md",
];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

describe("linkedin_organic never asserts that member analytics are impossible", () => {
  it("every capsule file exists", () => {
    expect(FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)))).toEqual([]);
  });

  it("does not instruct the agent to deny that a connection could reveal the numbers", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      if (/never tell the operator that connecting/i.test(read(f))) bad.push(f);
    }
    expect(bad).toEqual([]);
  });

  it("does not assert that no personal-profile analytics API exists", () => {
    const bad: string[] = [];
    const claim = /(publishes|exposes)\s+NO\s+(organic-)?analytics\s+API/i;
    for (const f of FILES) {
      if (claim.test(read(f))) bad.push(f);
    }
    expect(bad).toEqual([]);
  });

  it("states the real reason the numbers are unavailable: Zavi lacks the scope", () => {
    const withScope = FILES.filter((f) => /r_member_postAnalytics/.test(read(f)));
    expect(withScope.length).toBeGreaterThanOrEqual(3);
  });

  it("distinguishes observed response counts and the supplied follower-based rate from impressions", () => {
    const diagnose = read("src/agents/linkedin_organic/skills/diagnose.md");
    expect(diagnose).toMatch(/not the dashboard's follower-based rate/i);
    expect(diagnose).toMatch(/does not measure impressions, reach or leads/i);
  });

  it("calculates only the measured follower-based rate and omits it without that denominator", () => {
    const post = { external_post_id: "example", captured_on: "2026-11-01", posted_at: null, text: "Example", url: null, metrics: { reactions: 4, comments: 1, reposts: 0 } };
    const account = { captured_on: "2026-11-01", name: "Example", followers_count: 100 };
    expect(shapeLinkedIn([account], [post]).metrics.find(m => m.key === "engagement_rate")).toMatchObject({ value: 5, unit: "pct" });
    expect(shapeLinkedIn([{...account, followers_count:null}], [post]).metrics.some(m => m.key === "engagement_rate")).toBe(false);
  });
});
