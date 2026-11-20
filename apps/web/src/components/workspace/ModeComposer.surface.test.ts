import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModeComposer } from "./ModeComposer";

const composer = readFileSync(join(__dirname, "ModeComposer.tsx"), "utf8");
const globals = readFileSync(
  join(__dirname, "..", "..", "app", "globals.css"),
  "utf8",
);
const theme = readFileSync(
  join(__dirname, "..", "..", "..", "tailwind.config.ts"),
  "utf8",
);

const surfaceLine = composer
  .split("\n")
  .find((line) => line.includes("composer-surface") && line.includes("rounded-[16px]"))!;
const textareaLine = composer
  .split("\n")
  .find((line) => line.includes("resize-none") && line.includes("bg-transparent"))!;

const fontSize = Number(
  textareaLine.includes("text-composer")
    ? /composer:\s*\["(\d+)px"/.exec(theme)?.[1]
    : /text-\[(\d+)px\]/.exec(textareaLine)?.[1],
);

describe("the chat composer surface", () => {
  it("drops the border only when the build composer requests it", () => {
    const props = {
      value: "",
      onChange: () => {},
      placeholder: "Message Engineer…",
      ariaLabel: "Message Engineer",
      trailing: null,
    };
    const standard = renderToStaticMarkup(createElement(ModeComposer, props));
    const build = renderToStaticMarkup(createElement(ModeComposer, { ...props, borderless: true }));

    expect(standard).toContain("border border-rule");
    expect(build).toContain("border-0");
    expect(build).not.toContain("border border-rule");
  });

  it("keeps long leading controls from pushing mic and send outside the composer", () => {
    const markup = renderToStaticMarkup(
      createElement(ModeComposer, {
        value: "",
        onChange: () => {},
        placeholder: "Message Zavi…",
        ariaLabel: "Message Zavi",
        leading: createElement("span", null, "a very long repository name"),
        trailing: createElement("span", null, "actions"),
      }),
    );

    expect(markup).toContain("min-w-0 items-center justify-between");
    expect(markup).toContain("min-w-0 flex-1 items-center");
    expect(markup).toContain("shrink-0 items-center gap-1");
  });
  it("is white inside the workspace, not the grey paper tone", () => {
    expect(surfaceLine).toBeTruthy();
    expect(surfaceLine).toContain("bg-cream");
    expect(surfaceLine).not.toContain("creamDeep");
  });

  it("carries a soft, wide shadow, since white on white has no edge of its own", () => {
    expect(surfaceLine).toContain("shadow-composer");
    expect(surfaceLine).toContain("focus-within:shadow-composerFocus");
    expect(surfaceLine).not.toMatch(/\bshadow-elev(Md)?\b/);
    expect(surfaceLine).not.toMatch(/\bshadow-pop\b/);

    for (const token of ["composer", "composerFocus"]) {
      const value = new RegExp(`${token}:\\s*\n?\\s*"([^"]+)"`).exec(theme)?.[1];
      expect(value, token).toBeTruthy();
      const layers = value!.split("), ");
      expect(layers.length, token).toBe(2);
      const parse = (layer: string) =>
        [...layer.matchAll(/(-?\d+)(?:px)?(?=\s)/g)].map((m) => Number(m[1]));
      const [contact, lift] = layers.map(parse);
      expect(contact[2], `${token} contact blur`).toBeLessThanOrEqual(4);
      expect(lift[2], `${token} lift blur`).toBeGreaterThanOrEqual(24);
      expect(lift[3], `${token} lift spread`).toBeLessThan(0);
    }
  });

  it("sets the input text above the 16px thread body", () => {
    expect(fontSize).toBeGreaterThanOrEqual(17);
  });

  it("lifts off the dark chat surface instead of matching it", () => {
    const rule = /html\.dark \.workspace-shell \.composer-surface \{([^}]*)\}/.exec(
      globals,
    );
    expect(rule).toBeTruthy();
    expect(surfaceLine).toContain("composer-surface");
    const body = rule![1];
    expect(body).toContain("!important");
    expect(body).not.toContain("--c-cream)");
    const token = /background-color:\s*rgb\(var\((--c-dark-[\w-]+)\)\)/.exec(body);
    expect(token).toBeTruthy();
    const palette = /html\.dark \{([^}]*)\}/.exec(globals)?.[1] ?? "";
    const level = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+) `).exec(palette)?.[1]);
    expect(level(token![1])).toBeGreaterThan(level("--c-dark-base"));
  });
});
