import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { COMPACT_MAX_PX } from "@/lib/responsive";

const css = readFileSync(join(__dirname, "globals.css"), "utf8");

function mediaOwning(selector: string): string | null {
  const at = css.indexOf(selector, css.indexOf(selector) + 1);
  const before = css.slice(0, at);
  const open = before.lastIndexOf("@media");
  if (open === -1) return null;
  const body = before.slice(open);
  let depth = 0;
  for (const ch of body) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  if (depth <= 0) return null;
  return body.slice(0, body.indexOf("{")).trim();
}

const SELECTOR = "html.dark .workspace-shell aside.bg-cream";

describe("the floating chat button on a phone", () => {
  it("takes a dark surface instead of the inverted disc light mode uses", () => {
    const at = css.indexOf("html.dark .workspace-shell .channel-chat-fab");
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toContain("background-color: rgb(var(--c-cream-deep))");
    expect(rule).toContain("color: rgb(var(--c-ink))");
    expect(rule).not.toContain("255 255 255");
  });
});

describe("dark-mode panel surfaces", () => {
  it("keeps the desktop sidebar on its own darker black", () => {
    const first = css.slice(css.indexOf(SELECTOR));
    expect(first.slice(0, first.indexOf("}"))).toContain("rgb(var(--c-dark-sunken))");
    const palette = css.match(/html\.dark \{([^}]*)\}/)?.[1] ?? "";
    expect(palette).toMatch(/--c-dark-sunken:\s*16 16 16;/);
    expect(palette).toMatch(/--c-dark-base:\s*20 20 20;/);
  });

  it("puts every phone surface on the card black, at the compact breakpoint", () => {
    const owner = mediaOwning(SELECTOR);
    expect(owner).toBe(`@media (max-width: ${COMPACT_MAX_PX}px)`);

    const second = css.slice(css.indexOf(SELECTOR, css.indexOf(SELECTOR) + 1));
    const rule = second.slice(0, second.indexOf("}"));
    expect(rule).toContain("rgb(var(--c-cream))");
    expect(rule).not.toContain("--c-dark-sunken");
  });
});

describe("the Zavi wordmark in dark mode", () => {
  it("inverts the black wordmark so it reads on the dark chat surface", () => {
    const at = css.indexOf("html.dark .workspace-shell .theme-logo");
    expect(at).toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf("}", at))).toContain("filter: invert(1)");
    expect(mediaOwning("html.dark .workspace-shell .theme-logo")).toBeNull();
  });
});

describe("code tokens in the Code tab", () => {
  it("use the Light+ colour by default and swap to Dark+ in dark mode", () => {
    const base = css.indexOf(".code-token {");
    expect(css.slice(base, css.indexOf("}", base))).toContain("color: var(--tok-light)");
    const dark = css.indexOf("html.dark .workspace-shell .code-token");
    expect(dark).toBeGreaterThan(-1);
    expect(css.slice(dark, css.indexOf("}", dark))).toContain("color: var(--tok-dark)");
  });
});
