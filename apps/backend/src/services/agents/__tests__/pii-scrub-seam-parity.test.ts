import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PII_SCRUB_AGENT_SLUGS } from "../scrub-agent-egress";

const SRC = join(__dirname, "..");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

describe("PII scrub — seam parity", () => {
  it("the slug set still contains the operator_db readers (guards the premise)", () => {
    for (const slug of [
      "pm",
      "chief-of-staff",
      "support-lead",
      "dispute-response",
      "growth-lead",
      "performance-marketer",
    ]) {
      expect(PII_SCRUB_AGENT_SLUGS.has(slug)).toBe(true);
    }
  });

  it("REGRESSION: no egress seam hardcodes a slug to decide PII policy", () => {
    const hardcoded = /scrubPii:\s*[^,\n]*===\s*["'][a-z-]+["']/;

    for (const file of ["chat-dispatcher.ts", "runner.ts", "generic-dispatcher.ts"]) {
      expect(hardcoded.test(read(file)), `${file} hardcodes a slug in scrubPii`).toBe(false);
    }
  });

  it("REGRESSION: every scrubPii decision reads the central PII policy", () => {
    for (const file of ["chat-dispatcher.ts", "runner.ts"]) {
      const src = read(file);
      const decisions = src.match(/scrubPii:\s*[^,\n]+/g) ?? [];
      expect(decisions.length, `${file} has no scrubPii decision`).toBeGreaterThan(0);
      for (const d of decisions) {
        expect(
          d.includes("isPiiScrubAgent") || d.includes("PII_SCRUB_AGENT_SLUGS"),
          `${file}: "${d.trim()}" does not read the central PII policy (isPiiScrubAgent)`,
        ).toBe(true);
      }
    }
  });

  it("REGRESSION: the reminder/standing-order scrubs pass an agentSlug", () => {
    const src = read("runner.ts");
    expect(src).not.toContain('scrub: (text) => scrubAgentEgress(text, { surface: "persist" }).text');
  });
});
