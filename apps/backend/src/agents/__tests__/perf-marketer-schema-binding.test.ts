
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const indexSrc = readFileSync(join(__dirname, "..", "index.ts"), "utf8");

describe("performance-marketer schema binding (parse-failed-every-run regression)", () => {
  it("performance-marketer is bound to the flat growthOrchestratorOutputSchema, not the tiered digestSchema", () => {
    expect(indexSrc).toMatch(
      /import\s*\{\s*growthDigestSchema as growthOrchestratorOutputSchema\s*\}/,
    );
    expect(indexSrc).toMatch(
      /"performance-marketer":\s*growthOrchestratorOutputSchema/,
    );
  });

  it("performance-marketer is NOT registered against the tiered digestSchema (the broken shape)", () => {
    expect(indexSrc).not.toMatch(/"performance-marketer":\s*digestSchema\b/);
  });

  it("growth-lead and performance-marketer share the same flat schema", () => {
    expect(indexSrc).toMatch(/"growth-lead":\s*growthOrchestratorOutputSchema/);
    expect(indexSrc).toMatch(/"performance-marketer":\s*growthOrchestratorOutputSchema/);
  });
});
