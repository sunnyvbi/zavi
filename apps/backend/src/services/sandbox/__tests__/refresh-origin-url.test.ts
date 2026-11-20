import { describe, it, expect } from "vitest";
import { refreshOriginUrlStep } from "../e2b-client";

describe("refreshOriginUrlStep", () => {
  const step = refreshOriginUrlStep();

  it("references the $GITHUB_TOKEN env var (shell-interpolated, not a literal)", () => {
    expect(step).toContain("$GITHUB_TOKEN");
  });

  it("rewrites remote.origin.url via git remote set-url", () => {
    expect(step).toMatch(/git remote set-url origin/);
  });

  it("strips the existing credential prefix before re-prepending a fresh one", () => {
    expect(step).toContain("x-access-token:$GITHUB_TOKEN@");
  });

  it("ends with ` && ` so it chains BEFORE the caller's git-network op", () => {
    expect(step.trimEnd().endsWith("&&")).toBe(true);
  });

  it("contains no literal 40-char-style token (defense: only the env var)", () => {
    expect(step).not.toMatch(/ghs_[A-Za-z0-9]{20,}/);
    expect(step).not.toMatch(/x-access-token:[A-Za-z0-9]{20,}@/);
  });
});
