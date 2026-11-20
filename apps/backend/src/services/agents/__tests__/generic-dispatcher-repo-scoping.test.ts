
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf8");

describe("generic-dispatcher repo injection scoping (P0-4, fail-closed)", () => {
  it("imports the tri-state resolveScopedRepos helper", () => {
    expect(SRC).toMatch(
      /import\s*\{[\s\S]*?\bresolveScopedRepos\b[\s\S]*?\}\s*from\s*["']@\/services\/connectors\/github\/scoped-repos["']/,
    );
  });

  it("derives the injected repo list from resolveScopedRepos (not raw repo_full_names)", () => {
    expect(SRC).toMatch(/const resolved = await resolveScopedRepos\(ctx\.tenant_id\)/);
    expect(SRC).toMatch(
      /ghRepos = resolved\.mode === "deny" \? \[\] : resolved\.repos/,
    );
    expect(SRC).toMatch(/const repoLines = ghRepos/);
  });

  it("FAILS CLOSED on a resolver throw — never reverts to the raw connected set", () => {
    expect(SRC).not.toMatch(/ghRepos = rawGhRepos/);
    expect(SRC).not.toMatch(/const rawGhRepos\b/);
    expect(SRC).toMatch(/}\s*catch\s*\{\s*\/\/[^\n]*fail closed[^\n]*\n\s*ghRepos = \[\];/);
  });

  it("only labels the default repo when it survived scoping", () => {
    expect(SRC).toMatch(/ghRepos\.includes\(ghMeta\.default_repo_full_name\)/);
  });
});
