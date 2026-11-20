import { describe, it, expect } from "vitest";
import {
  shouldWrapToolOutput,
  isAttackerAuthorableGithubOutput,
} from "../tool-output-trust";

describe("tool-output-trust (E8) — attacker-authorable github reads are wrapped", () => {
  const GITHUB_UNTRUSTED = [
    "search_issues",
    "get_pr_diff",
    "list_open_prs",
    "list_commits",
  ];
  for (const tool of GITHUB_UNTRUSTED) {
    it(`github__${tool} → wrapped (external-contributor content)`, () => {
      expect(isAttackerAuthorableGithubOutput("github", tool)).toBe(true);
      expect(shouldWrapToolOutput("github", tool)).toBe(true);
    });
  }

  const GITHUB_TRUSTED = ["read_file", "search_code", "list_files"];
  for (const tool of GITHUB_TRUSTED) {
    it(`github__${tool} → unwrapped (own-repo read stays trusted)`, () => {
      expect(isAttackerAuthorableGithubOutput("github", tool)).toBe(false);
      expect(shouldWrapToolOutput("github", tool)).toBe(false);
    });
  }

  it("memory / praxis_corpus / operator_db stay unwrapped (unchanged)", () => {
    for (const server of ["memory", "praxis_corpus", "operator_db"]) {
      expect(shouldWrapToolOutput(server, "search")).toBe(false);
      expect(isAttackerAuthorableGithubOutput(server, "search")).toBe(false);
    }
  });

  it("stripe / jira / linear / web stay wrapped (unchanged)", () => {
    for (const server of ["stripe", "jira", "linear", "web_search"]) {
      expect(shouldWrapToolOutput(server, "anything")).toBe(true);
    }
  });
});
