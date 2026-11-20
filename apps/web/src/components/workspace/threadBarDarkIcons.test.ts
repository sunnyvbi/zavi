
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "ThreadBar.tsx"), "utf8");
const dark = readFileSync(join(__dirname, "..", "..", "app", "workspace-dark.css"), "utf8");

describe("the ThreadBar's header icons in dark mode", () => {
  it("paints every svg from currentColor, never a literal hex", () => {
    const paints = [...source.matchAll(/\b(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]);
    expect(paints.length).toBeGreaterThan(0);
    expect(paints.filter((p) => p.startsWith("#"))).toEqual([]);
    expect(paints).toContain("currentColor");
  });

  it("gives the conversation-history button a colour class the dark generator can see", () => {
    const at = source.indexOf('aria-label="Conversation history"');
    expect(at).toBeGreaterThan(-1);
    const button = source.slice(at, source.indexOf("</button>", at));
    expect(button).toContain("text-[#1f1f1f]");
    expect(button).toContain('fill="currentColor"');
  });

  it("relies on a dark override that actually exists for that class", () => {
    expect(dark).toContain("html.dark .workspace-shell .text-\\[\\#1f1f1f\\]");
  });
});
