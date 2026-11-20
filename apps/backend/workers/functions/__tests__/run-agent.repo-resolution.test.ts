import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "../../../src/services/sandbox/repo-creds.ts"),
  "utf8",
);

describe("resolveRepoCredsForRun default-repo wire-up", () => {
  it("reads default_repo_full_name from connector_metadata", () => {
    expect(SRC).toMatch(/\.select\(["'][^"']*default_repo_full_name[^"']*["']\)/);
  });

  it("uses tenantDefault before single-repo fallback when hint empty", () => {
    expect(SRC).toMatch(/const tenantDefault = meta\?\.default_repo_full_name/);
    expect(SRC).toMatch(/tenantDefault && connectedRepos\.includes\(tenantDefault\)/);
  });

  it("still returns needs_pick when no hint, no default, multiple repos", () => {
    expect(SRC).toMatch(/return\s*\{\s*kind:\s*["']needs_pick["']/);
  });
});
