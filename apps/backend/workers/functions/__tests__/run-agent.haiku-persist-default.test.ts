import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../run-agent.ts"), "utf8");

function extractPickBranch(): string {
  const m = SRC.match(
    /\/\/ decision === "pick"[\s\S]*?resolve-repo-creds-retry[\s\S]*?\}\),?\s*\n/,
  );
  if (!m) {
    throw new Error(
      "Could not locate the decision==='pick' branch — source layout changed?",
    );
  }
  return m[0];
}

describe("run-agent — Haiku pick persists PER-THREAD, not tenant-global (P0.e)", () => {
  it("wraps the per-thread persist in a step.run for Inngest replay safety", () => {
    const branch = extractPickBranch();
    expect(branch).toMatch(/step\.run\(\s*["']persist-haiku-pick-per-thread["']/);
  });

  it("writes agent_threads.repo_full_name (per-thread), NOT connector_metadata default", () => {
    const branch = extractPickBranch();
    expect(branch).toMatch(/\.from\(\s*["']agent_threads["']\s*\)/);
    expect(branch).toMatch(/\.update\(\s*\{\s*repo_full_name:\s*decision\.repo\s*\}\s*\)/);
    expect(branch).not.toMatch(/\.update\(\s*\{\s*default_repo_full_name:/);
  });

  it("does NOT use the set_github_default_repo RPC", () => {
    const branch = extractPickBranch();
    expect(branch).not.toMatch(/\.rpc\(\s*["']set_github_default_repo["']/);
  });

  it("scopes the per-thread UPDATE to (id=thread, tenant_id)", () => {
    const branch = extractPickBranch();
    expect(branch).toMatch(/\.eq\(\s*["']id["']\s*,\s*threadIdForStick\s*\)/);
    expect(branch).toMatch(/\.eq\(\s*["']tenant_id["']\s*,\s*claim\.tenant_id\s*\)/);
  });

  it("degrades gracefully on UPDATE failure (logger.warn, doesn't throw)", () => {
    const branch = extractPickBranch();
    expect(branch).toMatch(/logger\.warn[\s\S]*persist-per-thread-repo failed/);
  });

  it("the WHOLE run-agent file no longer writes default_repo_full_name implicitly", () => {
    expect(SRC).not.toMatch(/\.update\(\s*\{\s*default_repo_full_name:/);
  });

  it("per-thread persist runs AFTER claim.payload is set with the picked hint", () => {
    const branch = extractPickBranch();
    const mergedIdx = branch.indexOf("claim.payload = merged");
    const persistIdx = branch.indexOf("persist-haiku-pick-per-thread");
    expect(mergedIdx).toBeGreaterThan(-1);
    expect(persistIdx).toBeGreaterThan(mergedIdx);
  });
});
