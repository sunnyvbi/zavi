
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COS_MD = readFileSync(
  join(__dirname, "..", "agent.md"),
  "utf-8",
);
const PM_MD = readFileSync(
  join(__dirname, "..", "..", "pm", "agent.md"),
  "utf-8",
);

describe("chief-of-staff + pm — Tier 4 'Learnings' label (qa-blind Section E #1, 2026-05-26)", () => {
  it("chief-of-staff agent.md uses 'Learnings' label, not 'Brain & trainer'", () => {
    expect(COS_MD).not.toContain("Brain & trainer");
    expect(COS_MD).not.toContain("Brain and trainer");
    expect(COS_MD).toContain("Learnings");
  });

  it("chief-of-staff agent.md uses 'learnings' category slug, not 'brain-and-trainer'", () => {
    expect(COS_MD).not.toContain("brain-and-trainer");
    expect(COS_MD).toMatch(/"category":\s*"auto-acted \| escalated \| fleet-health \| learnings"/);
  });

  it("pm agent.md uses 'Learnings' label, not 'Brain & trainer'", () => {
    expect(PM_MD).not.toContain("Brain & trainer");
    expect(PM_MD).not.toContain("Brain and trainer");
    expect(PM_MD).toContain("Learnings");
  });

  it("pm agent.md has the section heading + the drop-order rule both renamed", () => {
    expect(PM_MD).toMatch(/^## Learnings$/m);
    expect(PM_MD).toMatch(/drop the "Learnings" footer first/);
  });

  it("chief-of-staff Tier 4 section names 'Learnings' as the loop-closing surface", () => {
    expect(COS_MD).toMatch(/Tier 4 "Learnings"/);
  });
});
