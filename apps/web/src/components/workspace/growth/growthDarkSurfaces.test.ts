import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const GROWTH_DIR = __dirname;
const GLOBALS = readFileSync(join(__dirname, "../../../app/globals.css"), "utf8");

const sources = readdirSync(GROWTH_DIR)
  .filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
  .map((f) => ({ file: f, body: readFileSync(join(GROWTH_DIR, f), "utf8") }));

function darkBlock(selector: string): string | null {
  const re = new RegExp(`html\\.dark \\.workspace-shell \\.${selector}\\s*\\{([^}]*)\\}`);
  return GLOBALS.match(re)?.[1] ?? null;
}

function darkToken(name: string): number {
  const palette = GLOBALS.match(/html\.dark \{([^}]*)\}/)?.[1] ?? "";
  const value = new RegExp(`--c-dark-${name}:\\s*(\\d+) \\d+ \\d+;`).exec(palette);
  expect(value, `--c-dark-${name}`).not.toBeNull();
  return Number(value![1]);
}

function floatingCreamSurfaces() {
  const hits: Array<{ file: string; className: string }> = [];
  for (const { file, body } of sources) {
    for (const m of body.matchAll(/className=\{?[`"]([^`"]*)[`"]/g)) {
      const cls = m[1];
      if (!/\b(absolute|fixed)\b/.test(cls)) continue;
      if (!/\bbg-cream\b/.test(cls)) continue;
      if (!/\bshadow-/.test(cls)) continue;
      hits.push({ file, className: cls });
    }
  }
  return hits;
}

describe("the growth tab's floating surfaces on dark", () => {
  it("has a lifted surface defined, and it is NOT the same value as the page behind it", () => {
    const block = darkBlock("raised-surface");
    expect(block).not.toBeNull();
    expect(block).toMatch(/background-color:\s*rgb\(var\(--c-dark-surface\)\)\s*!important/);
    expect(block).toMatch(/border-color:\s*rgb\(var\(--c-dark-strong\)\)/);
    expect(block).not.toMatch(/var\(--c-cream\)/);
    expect(darkToken("surface")).toBeGreaterThan(darkToken("base"));
    expect(darkToken("strong")).toBeGreaterThan(darkToken("surface"));
  });

  it("lifts it to the same value the workspace already uses for a floating panel", () => {
    const raised = darkBlock("raised-surface");
    for (const peer of ["account-menu", "credit-card", "composer-surface"]) {
      const block = darkBlock(peer);
      expect(block, `${peer} should still define the lifted surface`).not.toBeNull();
      expect(block).toMatch(/rgb\(var\(--c-dark-surface\)\)/);
    }
    expect(raised).toMatch(/rgb\(var\(--c-dark-surface\)\)/);
  });

  it("finds the menus it is meant to be guarding, so the sweep cannot silently match nothing", () => {
    const hits = floatingCreamSurfaces();
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.map((h) => h.file).sort()).toEqual(
      expect.arrayContaining(["GrowthChannels.tsx"]),
    );
  });

  it("gives every floating bg-cream surface in growth/ the lifted class", () => {
    const naked = floatingCreamSurfaces().filter((h) => !/\braised-surface\b/.test(h.className));
    expect(
      naked.map((h) => `${h.file}: ${h.className.slice(0, 70)}`),
      "a popup painted bg-cream is rgb(20 20 20) on dark, the same value as the surface behind it",
    ).toEqual([]);
  });

  it("keeps the rule reachable: bg-cream is !important, so the lift must be too", () => {
    expect(GLOBALS).toMatch(
      /\.workspace-shell \.bg-cream\s*\{\s*background-color:\s*rgb\(var\(--c-cream\)\)\s*!important/,
    );
  });
});
