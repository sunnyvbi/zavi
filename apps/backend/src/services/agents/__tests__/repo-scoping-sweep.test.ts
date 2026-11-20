
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PRAXIS = readFileSync(
  join(__dirname, "../../mcp/internal/praxis.ts"),
  "utf8",
);
const VERIFIER = readFileSync(
  join(__dirname, "../negative-existence-grounding-verifier.ts"),
  "utf8",
);

describe("praxis__handoff repo-pickers are SCOPED (round-2 sweep)", () => {
  it("imports the scoping helper", () => {
    expect(PRAXIS).toMatch(
      /import\s*\{\s*getScopedRepoFullNames\s*\}\s*from\s*["']@\/services\/connectors\/github\/scoped-repos["']/,
    );
  });

  it("routes the engineer child repo-pick through getScopedRepoFullNames (both handoff paths)", () => {
    const matches = PRAXIS.match(
      /connectedRepos\s*=\s*await getScopedRepoFullNames\(ctx\.tenant_id\)/g,
    );
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("no longer feeds pickRepoForTask from a raw connector_metadata repo_full_names read", () => {
    expect(PRAXIS).not.toMatch(/\.select\(\s*["']repo_full_names["']\s*\)/);
  });
});

describe("negative-existence grounding verifier greps only SCOPED repos (round-2 sweep)", () => {
  it("imports the scoping helper", () => {
    expect(VERIFIER).toMatch(
      /import\s*\{\s*getScopedRepoFullNames\s*\}\s*from\s*["']@\/services\/connectors\/github\/scoped-repos["']/,
    );
  });

  it("defaultListConnectedRepos returns the scoped set (not a raw repo_full_names read)", () => {
    expect(VERIFIER).toMatch(
      /async function defaultListConnectedRepos[\s\S]*?return getScopedRepoFullNames\(tenant_id\)/,
    );
    expect(VERIFIER).not.toMatch(/\.select\(\s*["']repo_full_names["']\s*\)/);
  });
});
