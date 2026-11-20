
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..");

const RECALL_PATHS = [
  "memory/loader.ts",
  "memory/feedback-recall.ts",
  "tools/memory/agentic-read.ts",
];

describe("archived_at is honored on every direct memory_note recall path", () => {
  for (const rel of RECALL_PATHS) {
    it(`${rel}: every superseded_by filter has an archived_at sibling`, () => {
      const src = readFileSync(join(SRC, rel), "utf8");
      const supersededFilters = src.match(/\.is\(\s*["']superseded_by["']\s*,\s*null\s*\)/g) ?? [];
      const archivedFilters = src.match(/\.is\(\s*["']archived_at["']\s*,\s*null\s*\)/g) ?? [];

      expect(
        supersededFilters.length,
        `${rel} should have at least one memory_note recall query`,
      ).toBeGreaterThan(0);

      expect(
        archivedFilters.length,
        `${rel} filters superseded_by ${supersededFilters.length}x but archived_at only ` +
          `${archivedFilters.length}x — an archived note still reaches the prompt through ` +
          `the unguarded query. Add .is("archived_at", null).`,
      ).toBeGreaterThanOrEqual(supersededFilters.length);
    });
  }

  it("memory_read returns no BODY for an archived note (code-side filter)", () => {
    const src = readFileSync(join(SRC, "tools/memory/agentic-read.ts"), "utf8");
    expect(src).toMatch(/if\s*\(\s*row\.archived_at\s*\)/);
  });
});
