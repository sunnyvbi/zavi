import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "ModeComposer.tsx"), "utf8");

const SPACING_PX: Record<string, number> = { "0.5": 2, "1": 4, "1.5": 6, "2": 8, "2.5": 10, "3": 12 };

function classBlockFor(marker: string): string {
  const at = SOURCE.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const start = SOURCE.lastIndexOf('"', at);
  const end = SOURCE.indexOf('"', at);
  return SOURCE.slice(start, end);
}

function sizePx(block: string, prefix: "h" | "w", compact: boolean): number {
  const m = compact
    ? block.match(new RegExp(`compact:${prefix}-(\\d+)\\b`))
    : block.replace(/compact:\S+/g, "").match(new RegExp(`\\b${prefix}-(\\d+)\\b`));
  expect(m, `no ${compact ? "compact " : ""}${prefix}- size in: ${block}`).not.toBeNull();
  return Number(m![1]) * 4;
}

function insetPx(block: string, compact: boolean): number {
  const m = compact
    ? block.match(/compact:after:-inset-([\d.]+)/)
    : block.replace(/compact:\S+/g, "").match(/after:-inset-([\d.]+)/);
  if (!m) return 0;
  const px = SPACING_PX[m[1]];
  expect(px, `unmapped spacing token: ${m[1]}`).toBeDefined();
  return px;
}

describe("composer controls are tappable on a phone", () => {
  for (const [name, marker] of [
    ["icon button", "rounded-full text-inkLight"],
    ["send circle", "rounded-full transition-colors"],
  ] as const) {
    it(`${name} reaches a 44px touch target on a phone`, () => {
      const block = classBlockFor(marker);
      const pad = insetPx(block, true) * 2;
      expect(block).toContain("relative");
      expect(block).toMatch(/after:absolute/);
      expect(sizePx(block, "h", true) + pad).toBeGreaterThanOrEqual(44);
      expect(sizePx(block, "w", true) + pad).toBeGreaterThanOrEqual(44);
    });

    it(`${name} has no enlarged hit area on desktop, so it cannot cover its neighbour`, () => {
      expect(insetPx(classBlockFor(marker), false)).toBe(0);
    });
  }
});
