import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");

describe("post-run threads the verified site-repo exemption", () => {
  it("verifies every site payload server-side, independent of product-build codegen detection", () => {
    expect(src).toMatch(
      /siteCheck = isSiteRunPayload\(payload\)\s*\n?\s*\?\s*await verifySiteRepoRun\(\{ tenant_id: ctx\.tenant_id, repo_full_name: repoHint, payload \}\)/,
    );
    expect(src).toMatch(/const isSiteRepoBuild = siteCheck\?\.ok === true;/);
    expect(src).not.toMatch(/isSiteRepoBuild\s*=\s*\n?\s*isProductBuildCodegen/);
  });
  it("passes site_repo to the builder only when verified", () => {
    const call = src.slice(src.indexOf("built = await buildPrFilesFromSandboxFs({"), src.indexOf("built = await buildPrFilesFromSandboxFs({") + 600);
    expect(call).toMatch(/\.\.\.\(isSiteRepoBuild \? \{ site_repo: true \} : \{\}\)/);
  });
  it("the protected-path stamp uses the site policy for a verified site run", () => {
    const stamp = src.slice(src.indexOf("4-C3. PROTECTED-PATH stamp"), src.indexOf("4-C3. PROTECTED-PATH stamp") + 2500);
    expect(stamp).toMatch(/isSiteRepoBuild\s*\?\s*siteProtectedPathHits\(/);
  });
});
