import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function code(path: string): string {
  return readFileSync(join(__dirname, path), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const previewReaper = code("../preview-reaper.ts");
const infraReaper = code("../infra-reaper.ts");

describe("preview-reaper teardown shape", () => {
  it("PAUSES the sandbox — it must never destroy it", () => {
    expect(previewReaper).toMatch(/pauseSandbox\(/);
    expect(previewReaper).not.toMatch(/destroySandboxRow/);
    expect(previewReaper).not.toMatch(/destroySandbox\(/);
  });

  it("expires via expire_engineer_sandbox_preview (retains preview_run_id)", () => {
    expect(previewReaper).toMatch(/expire_engineer_sandbox_preview/);
    expect(previewReaper).not.toMatch(/rpc\(\s*["']clear_sandbox_preview["']/);
  });

  it("does NOT tear down the preview dir or kill the dev-server process", () => {
    expect(previewReaper).not.toMatch(/rm -rf/);
    expect(previewReaper).not.toMatch(/pkill/);
  });

  it("classifies a pause failure: expires on sandbox-gone, rethrows transient", () => {
    expect(previewReaper).toMatch(/isSandboxGoneError\(/);
    expect(previewReaper).toMatch(/if \(!isSandboxGoneError\([^)]*\)\) throw/);
  });

  it("pauses BEFORE it expires the row (a pause failure must stay retryable)", () => {
    const pauseAt = previewReaper.indexOf("pauseSandbox(");
    const expireAt = previewReaper.indexOf("expire_engineer_sandbox_preview");
    expect(pauseAt).toBeGreaterThan(-1);
    expect(expireAt).toBeGreaterThan(-1);
    expect(pauseAt).toBeLessThan(expireAt);
  });

  it("does not gate reaping on the GLOBAL feature flag", () => {
    expect(previewReaper).not.toMatch(/engineerPreviewGloballyEnabled\(\)/);
  });
});

describe("infra-reaper preview sweep", () => {
  it("excludes ENGINEER previews (preview_run_id NOT NULL) from its destroy path", () => {
    expect(infraReaper).toMatch(/\.is\(\s*["']preview_run_id["']\s*,\s*null\s*\)/);
  });

  it("still destroys PRODUCT-BUILDER previews (behaviour unchanged for them)", () => {
    expect(infraReaper).toMatch(/destroySandboxRow/);
  });
});
