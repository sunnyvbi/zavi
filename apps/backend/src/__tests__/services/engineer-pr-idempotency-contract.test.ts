
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveHeadBranch } from "../../agents/engineer/branch-name";

const postRunSrc = readFileSync(
  resolve(__dirname, "../../agents/engineer/post-run.ts"),
  "utf8",
);
const githubSrc = readFileSync(
  resolve(__dirname, "../../services/mcp/internal/github.ts"),
  "utf8",
);

describe("engineer PR idempotency — deterministic head branch (post-run)", () => {
  const RUN = "a1ef6b99-4c2d-4f1a-9b3e-77c0d8e2f001";
  const base = {
    agentSlug: "engineer",
    runId: RUN,
    emitted: "engineer/whatever-the-model-chose",
    isProductBuildCodegen: false,
    followupCheckoutRef: "",
    slugSources: ["Fix the Android login crash"] as Array<string | undefined>,
    priorBranch: null as string | null,
  };

  it("resolves the SAME branch for the same run — the replay-convergence guarantee", () => {
    expect(resolveHeadBranch(base)).toBe(resolveHeadBranch({ ...base }));
  });

  it("embeds the run id, so two runs never collide on one branch", () => {
    const a = resolveHeadBranch(base);
    const b = resolveHeadBranch({ ...base, runId: "ffffffff-0000-4000-8000-000000000000" });
    expect(a).toContain("a1ef6b99");
    expect(a).not.toBe(b);
  });

  it("converges on the ALREADY-PUSHED branch even if the model reworded its title", () => {
    expect(
      resolveHeadBranch({
        ...base,
        slugSources: ["A Completely Reworded Title"],
        priorBranch: "engineer/fix-android-login-crash-a1ef6b99",
      }),
    ).toBe("engineer/fix-android-login-crash-a1ef6b99");
  });

  it("keeps the engineer/ prefix the PR-shepherd skip rule depends on", () => {
    expect(resolveHeadBranch(base)).toMatch(/^engineer\//);
  });

  it("scopes the override to the engineer slug (never clobbers another caller's branch)", () => {
    expect(postRunSrc).toMatch(/ctx\.agent\.slug\s*===\s*"engineer"/);
    expect(
      resolveHeadBranch({ ...base, agentSlug: "pm", emitted: "custom/branch" }),
    ).toBe("custom/branch");
  });

  it("post-run actually delegates to the resolver (wiring can't silently vanish)", () => {
    expect(postRunSrc).toMatch(/resolveHeadBranch\(/);
  });
});

describe("engineer PR idempotency — open_pr upsert (github.ts)", () => {
  it("has a findOpenPrForHead helper that filters by head=owner:branch", () => {
    expect(githubSrc).toMatch(/async function findOpenPrForHead/);
    expect(githubSrc).toMatch(/state=open&head=/);
  });

  it("the 422 branch-exists path resolves to the existing PR (reused) instead of throwing", () => {
    expect(githubSrc).toMatch(/findOpenPrForHead\(/);
    expect(githubSrc).toMatch(/reused:\s*true/);
    expect(githubSrc).not.toMatch(/throw new ExpectedToolError\(\s*"branch_exists"/);
  });

  it("the pull-create 422 (PR already exists) also resolves idempotently", () => {
    const matches = githubSrc.match(/findOpenPrForHead\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });
});
