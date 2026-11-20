import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");

const start = src.indexOf("Ensure the inline-editor runtime <script> survives");
const block = start === -1 ? "" : src.slice(start, start + 3200);

describe("product-build re-injects the editor runtime into the generated layout", () => {
  it("has the injection block", () => {
    expect(start).toBeGreaterThan(-1);
  });

  it("is gated to a product-build codegen run", () => {
    expect(block).toContain("isProductBuildCodegen");
  });

  it("does NOT inject into a repo the customer owns (github_target_mode='user_repo')", () => {
    expect(block).toContain("github_target_mode");
    expect(block).toMatch(/!==\s*"user_repo"/);
    expect(block).toMatch(/if \(isZaviOwnedBuildTarget\)/);
    expect(block).not.toMatch(/if \(isProductBuildCodegen\)\s*\{/);
  });

  it("defaults a marker-less legacy payload to umbrella (Zavi-owned), not user_repo", () => {
    expect(block).toMatch(/"umbrella"/);
  });

  it("targets the root layout at both app/ and src/app/ (tsx + jsx)", () => {
    expect(block).toContain('"app/layout.tsx"');
    expect(block).toContain('"src/app/layout.tsx"');
    expect(block).toContain('"app/layout.jsx"');
    expect(block).toContain('"src/app/layout.jsx"');
  });

  it("skips deletes / missing content and calls the pure injector, mutating the committed file", () => {
    expect(block).toMatch(/action === "delete" \|\| typeof f\.content !== "string"/);
    expect(block).toMatch(/injectEditorRuntimeIntoLayout\(f\.content\)/);
    expect(block).toMatch(/f\.content = withRuntime/);
  });

  it("runs BEFORE the proposal is assembled, so the committed files carry the tag", () => {
    expect(start).toBeLessThan(src.indexOf("files: built.files"));
  });
});
