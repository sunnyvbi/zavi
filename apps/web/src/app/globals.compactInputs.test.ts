import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "globals.css"), "utf8");

function ruleFor(needle: string) {
  const at = css.indexOf(needle);
  expect(at).toBeGreaterThan(-1);
  const open = css.lastIndexOf("@media", at);
  const media = css.slice(open, css.indexOf("{", open)).trim();
  const body = css.slice(at, css.indexOf("}", at));
  return { media, body };
}

describe("the 16px input floor that stops iOS zooming into a field", () => {
  const rule = ruleFor("font-size: max(16px, 1em) !important");
  const selector = css.slice(css.lastIndexOf("}", css.indexOf(rule.body)) + 1, css.indexOf(rule.body));

  it("applies only on a touch phone, not to a narrow desktop window", () => {
    expect(rule.media).toContain("(max-width: 639px)");
    expect(rule.media).toContain("(pointer: coarse)");
  });

  it("leaves checkboxes, radios and range sliders alone", () => {
    for (const type of ["checkbox", "radio", "range"]) {
      expect(selector).toContain(`:not([type="${type}"])`);
    }
  });

  it("is not scoped to the workspace shell, so the login form keeps it", () => {
    expect(selector).not.toContain(".workspace-shell");
  });
});

describe("the safe-area padding at the bottom of the shell", () => {
  it("pads once, however many nested surfaces carry the class", () => {
    const nested = ruleFor(".compact-safe-bottom .compact-safe-bottom");
    expect(nested.body).toContain("padding-bottom: 0");
    expect(css.indexOf(".compact-safe-bottom {")).toBeLessThan(
      css.indexOf(".compact-safe-bottom .compact-safe-bottom"),
    );
  });
});
