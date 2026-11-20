import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate } from "../../../../scripts/gen-workspace-dark.mjs";

const css = readFileSync(join(__dirname, "../../../app/workspace-dark.css"), "utf8");

describe("workspace-dark.css", () => {
  it("matches what the generator writes today, so no colour in the workspace is left without its dark rule", () => {
    expect(generate().css).toBe(css);
  });

  it("does not remap the theme-invariant bg-black and bg-[#fff] backgrounds", () => {
    expect(css).not.toContain(".workspace-shell .bg-black {");
    expect(css).not.toContain(".workspace-shell .bg-\\[\\#fff\\] {");
    expect(css).not.toContain(".workspace-shell .bg-\\[\\#000\\] {");
    expect(css).not.toContain(".workspace-shell .bg-\\[\\#232426\\] {");
  });

  it("still remaps the ordinary light surfaces", () => {
    expect(css).toContain(".workspace-shell .bg-white { background-color: rgb(var(--c-cream)); }");
    expect(css).toContain(".workspace-shell .hover\\:bg-black:hover {");
  });
});
