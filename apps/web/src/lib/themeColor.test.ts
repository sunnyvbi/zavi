// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyThemeColor,
  resolveDark,
  THEME_COLOR,
  THEME_COLOR_META_SELECTOR,
  THEME_KEY,
} from "./themeColor";

const rootLayout = readFileSync(join(__dirname, "../app/layout.tsx"), "utf8");

function themeBoot(): string {
  const match = /const THEME_BOOT = `([^`]*)`;/.exec(rootLayout);
  if (!match) throw new Error("THEME_BOOT not found in app/layout.tsx");
  return new Function(
    "THEME_COLOR",
    "THEME_COLOR_META_SELECTOR",
    `return \`${match[1]}\`;`,
  )(THEME_COLOR, THEME_COLOR_META_SELECTOR) as string;
}

function mountViewportMetas() {
  for (const [media, color] of [
    ["(prefers-color-scheme: light)", THEME_COLOR.light],
    ["(prefers-color-scheme: dark)", THEME_COLOR.dark],
  ] as const) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.media = media;
    meta.content = color;
    document.head.append(meta);
  }
}

const metas = () =>
  Array.from(
    document.head.querySelectorAll<HTMLMetaElement>(THEME_COLOR_META_SELECTOR),
  );

afterEach(() => {
  document.head.innerHTML = "";
  document.documentElement.classList.remove("dark");
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("the root layout", () => {
  it("no longer paints cream browser chrome over the white marketing and login pages", () => {
    const viewport = /export const viewport: Viewport = \{([\s\S]*?)\};/.exec(
      rootLayout,
    );
    expect(viewport).not.toBeNull();
    expect(viewport![1]).not.toContain("themeColor");
  });
});

describe("applyThemeColor", () => {
  it("writes the workspace theme into every theme-color meta, whichever media the browser picks", () => {
    mountViewportMetas();
    applyThemeColor(true);
    expect(metas().map((m) => m.content)).toEqual([
      THEME_COLOR.dark,
      THEME_COLOR.dark,
    ]);
    applyThemeColor(false);
    expect(metas().map((m) => m.content)).toEqual([
      THEME_COLOR.light,
      THEME_COLOR.light,
    ]);
  });

  it("creates one meta when the page has none, and takes it away again on cleanup", () => {
    const cleanup = applyThemeColor(true);
    expect(metas()).toHaveLength(1);
    expect(metas()[0].content).toBe(THEME_COLOR.dark);
    cleanup();
    expect(metas()).toHaveLength(0);
  });
});

describe("THEME_BOOT", () => {
  it("paints the stored workspace theme before React mounts, on a light-mode OS", () => {
    window.history.replaceState(null, "", "/workspace");
    window.localStorage.setItem("zavi:dark", "1");
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
    mountViewportMetas();

    new Function(themeBoot())();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(metas().map((m) => m.content)).toEqual([
      THEME_COLOR.dark,
      THEME_COLOR.dark,
    ]);
  });

  it("forces light chrome when the founder chose light on a dark-mode OS", () => {
    window.history.replaceState(null, "", "/workspace/settings");
    window.localStorage.setItem("zavi:dark", "0");
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    mountViewportMetas();

    new Function(themeBoot())();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(metas().map((m) => m.content)).toEqual([
      THEME_COLOR.light,
      THEME_COLOR.light,
    ]);
  });

  it("leaves marketing pages alone", () => {
    window.history.replaceState(null, "", "/pricing");
    window.localStorage.setItem("zavi:dark", "1");
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    mountViewportMetas();

    new Function(themeBoot())();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(metas().map((m) => m.content)).toEqual([
      THEME_COLOR.light,
      THEME_COLOR.dark,
    ]);
  });
});

describe("resolveDark", () => {
  it.each([
    ["1", false, true],
    ["1", true, true],
    ["0", false, false],
    ["0", true, false],
    [null, false, false],
    [null, true, true],
    ["", false, false],
    ["", true, true],
    ["true", false, false],
    ["true", true, true],
  ] as const)("stored %j with system dark %s resolves to %s", (stored, systemDark, expected) => {
    expect(resolveDark(stored, systemDark)).toBe(expected);
  });

  it.each([
    ["1", false],
    ["1", true],
    ["0", false],
    ["0", true],
    [null, false],
    [null, true],
  ] as const)("agrees with THEME_BOOT for stored %j with system dark %s", (stored, systemDark) => {
    window.history.replaceState(null, "", "/workspace");
    if (stored !== null) window.localStorage.setItem(THEME_KEY, stored);
    window.matchMedia = (() => ({ matches: systemDark })) as unknown as typeof window.matchMedia;

    new Function(themeBoot())();

    expect(document.documentElement.classList.contains("dark")).toBe(resolveDark(stored, systemDark));
  });
});
