
import { describe, it, expect } from "vitest";
import { branchToPersist } from "../post-run";

const repo = "rravi149/apna-tutor";
const base = { payload: null, repo_full_name: repo, base_branches: undefined };

describe("branchToPersist — persists a genuine declaration", () => {
  it("a plain non-main branch on a new single PR → persist it (the Apna case)", () => {
    expect(branchToPersist({ ...base, base_branch: "development" })).toBe("development");
  });

  it("a slash-containing REAL branch (feature/x) → persist it", () => {
    expect(branchToPersist({ ...base, base_branch: "release/1.2" })).toBe("release/1.2");
  });

  it("trims whitespace", () => {
    expect(branchToPersist({ ...base, base_branch: "  staging  " })).toBe("staging");
  });
});

describe("branchToPersist — REFUSES (the guards)", () => {
  it("main / empty → null (the default, no declaration)", () => {
    expect(branchToPersist({ ...base, base_branch: "main" })).toBeNull();
    expect(branchToPersist({ ...base, base_branch: "" })).toBeNull();
    expect(branchToPersist({ ...base, base_branch: undefined })).toBeNull();
  });

  it("follow-up run → null (base_branch there is a target-PR value, not a chosen base)", () => {
    expect(
      branchToPersist({
        payload: { kind: "engineer_pr_followup" },
        repo_full_name: repo,
        base_branch: "development",
        base_branches: undefined,
      }),
    ).toBeNull();
  });

  it("the value IS the repo full-name (owner/repo) → null — never stamp a repo slug as a branch", () => {
    expect(branchToPersist({ ...base, base_branch: repo })).toBeNull();
  });

  it("multi-PR base_branches (dev + main) → null — not a sticky preference", () => {
    expect(
      branchToPersist({
        payload: null,
        repo_full_name: repo,
        base_branch: "development",
        base_branches: ["development", "main"],
      }),
    ).toBeNull();
  });

  it("a single-entry base_branches still allows the scalar to persist", () => {
    expect(
      branchToPersist({
        payload: null,
        repo_full_name: repo,
        base_branch: "development",
        base_branches: ["development"],
      }),
    ).toBe("development");
  });

  it("an unsafe branch name (leading dash / spaces / bad chars) → null", () => {
    expect(branchToPersist({ ...base, base_branch: "-evil" })).toBeNull();
    expect(branchToPersist({ ...base, base_branch: "has space" })).toBeNull();
    expect(branchToPersist({ ...base, base_branch: "semi;colon" })).toBeNull();
  });
});
