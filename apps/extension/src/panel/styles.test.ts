
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  resolve(__dirname, "styles.css"),
  "utf8",
);

describe("the composer's focus opt-out actually wins", () => {
  it("scopes the opt-out with the parent class, beating the shared rule", () => {
    expect(CSS).toContain(".zv-composer .zv-input:focus-visible");
    expect(CSS).toContain(".zv-composer :focus-visible");

    const optOut = CSS.indexOf(".zv-composer .zv-input:focus-visible");
    const shared = CSS.indexOf(".zv-composer :focus-visible");
    expect(optOut).toBeGreaterThan(-1);
    expect(shared).toBeGreaterThan(-1);
  });
});

describe("the bundled font is referenced by a package-relative url", () => {
  it("declares both faces with a plain fonts/ path", () => {
    const urls = [...CSS.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]);
    const fontUrls = urls.filter((u) => u.endsWith(".woff2"));
    expect(fontUrls.length).toBeGreaterThanOrEqual(2);
    for (const u of fontUrls) {
      expect(u.startsWith("fonts/")).toBe(true);
      expect(u).not.toContain("..");
    }
  });
});

describe("the display face and the UI stack are one property each", () => {
  it("defines both, and every font var used is defined", () => {
    expect(CSS).toContain("--zv-font-display:");
    expect(CSS).toContain("--zv-font-ui:");
    const used = new Set([...CSS.matchAll(/var\((--zv-font-[a-z]+)\)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(CSS).toContain(`${name}:`);
  });

  it("names the brand family ONLY in @font-face and in --zv-font-display", () => {
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const mentions = [...rules.matchAll(/Plus Jakarta Sans/g)].length;
    const inFontFace = [...rules.matchAll(/font-family: "Plus Jakarta Sans";/g)].length;
    const inToken = [...rules.matchAll(/--zv-font-display: "Plus Jakarta Sans"/g)].length;
    expect(inFontFace).toBe(2);
    expect(inToken).toBe(1);
    expect(mentions).toBe(inFontFace + inToken);
  });

  it("puts the panel's default on the UI stack", () => {
    const body = /\nbody \{[^}]*\}/.exec(CSS)?.[0] ?? "";
    expect(body).toContain("var(--zv-font-ui)");
    expect(body).not.toContain("Jakarta");
  });

  it("applies the display face AFTER every `font: inherit` shorthand", () => {
    const display = CSS.lastIndexOf("font-family: var(--zv-font-display)");
    expect(display).toBeGreaterThan(-1);
    const inherits = [...CSS.matchAll(/font: inherit;/g)].map((m) => m.index ?? -1);
    expect(inherits.length).toBeGreaterThan(0);
    for (const at of inherits) expect(display).toBeGreaterThan(at);
  });
});
