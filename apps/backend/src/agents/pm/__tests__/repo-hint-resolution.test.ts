import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("P0a — pm prompt no longer hardcodes a repo", () => {
  const agentMd = readFileSync(join(__dirname, "../agent.md"), "utf-8");

  it("agent.md does NOT hardcode rravi149/praxis as repo_hint", () => {
    expect(agentMd).not.toMatch(/repo_hint["`']?\s*(?:to|:)\s*["']rravi149\/praxis/);
    expect(agentMd).not.toContain('"repo_hint": "rravi149/praxis"');
  });

  it("agent.md tells the model to pick a CONNECTED repo by file_hints/theme", () => {
    expect(agentMd).toMatch(/connected repo/i);
    expect(agentMd).toMatch(/file_hints/);
    expect(agentMd).toMatch(/Tenant GitHub\s+repositories/i);
  });
});

describe("P0a — generic-dispatcher injects connected repos for pm only", () => {
  const gd = readFileSync(
    join(__dirname, "../../../services/agents/generic-dispatcher.ts"),
    "utf-8",
  );

  it("gates the repo-list injection on ctx.agent.slug === 'pm'", () => {
    expect(gd).toMatch(/ctx\.agent\.slug === "pm"/);
    expect(gd).toMatch(/Tenant GitHub repositories/);
  });

  it("reads connected repos from connector_metadata (tenant + github scoped)", () => {
    expect(gd).toMatch(/repo_full_names, default_repo_full_name/);
    expect(gd).toMatch(/\.eq\("slug", "github"\)/);
  });
});

describe("P0b — pm post-run validates repo_hint server-side", () => {
  const postRun = readFileSync(join(__dirname, "../post-run.ts"), "utf-8");

  it("reads the tenant's SCOPED connected repos + default before dispatch", () => {
    expect(postRun).toMatch(/connector_metadata/);
    expect(postRun).toMatch(/getScopedRepoFullNames/);
    expect(postRun).toMatch(/default_repo_full_name/);
    expect(postRun).toMatch(/connectedRepos/);
  });

  it("falls back to the tenant default only when it is connected", () => {
    expect(postRun).toMatch(
      /tenantDefault && connectedRepos\.includes\(tenantDefault\)/,
    );
  });

  it("clears an invalid/empty hint (drops the dispatch) rather than guessing", () => {
    expect(postRun).toMatch(/d\.repo_hint = "";/);
  });

  it("runs the resolution BEFORE the dedup key is computed", () => {
    const resolveAt = postRun.indexOf("connectedRepos");
    const dedupAt = postRun.indexOf("computeDedupKey");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(dedupAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(dedupAt);
  });
});

