
import { describe, it, expect } from "vitest";
import { isSideEffectingTool } from "../tool-effect-classifier";
import { classifyToolRisk } from "../tool-risk-registry";
import { effectOf } from "../tool-effects";

const GITHUB_READ_TOOLS = [
  "list_files",
  "read_file",
  "search_code",
  "grep",
  "list_open_prs",
  "get_pr_diff",
  "get_pr",
  "list_pr_status",
  "list_branches",
  "list_commits",
  "list_repos",
  "search_issues",
] as const;

const GITHUB_WRITE_TOOLS = [
  "open_pr",
  "push_to_main",
  "squash_merge",
  "comment_on_pr",
  "create_branch",
] as const;

describe("github tool read/write classification parity", () => {
  it.each(GITHUB_READ_TOOLS)("%s classifies as a READ (never guarded)", (tool) => {
    expect(effectOf("github", tool)).toBe("read");
    expect(isSideEffectingTool("github", tool)).toBe(false);
  });

  it.each(GITHUB_WRITE_TOOLS)("%s stays side-effecting (guarded)", (tool) => {
    expect(isSideEffectingTool("github", tool)).toBe(true);
  });

  it("grep specifically is not a code write (the 2026-09-01 regression)", () => {
    expect(isSideEffectingTool("github", "grep")).toBe(false);
    expect(classifyToolRisk("github", "grep")).not.toBe("write_code");
  });

  it("an unknown github tool still fail-safes to guarded", () => {
    expect(isSideEffectingTool("github", "obliterate_everything")).toBe(true);
  });
});
