import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DISP = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf8");

describe("generic-dispatcher repo resolution", () => {
  it("imports resolveRepoFullName", () => {
    expect(DISP).toMatch(
      /import\s*\{\s*resolveRepoFullName\s*,?\s*RepoResolutionError?\s*\}\s*from\s*["']@?\/?services\/agents\/repo-resolver["']/,
    );
  });

  it("no longer throws the legacy 'repo_hint missing' error verbatim", () => {
    expect(DISP).not.toMatch(
      /payload\.repo_hint missing — required to bind sandbox tools to the right repo\./,
    );
  });

  it("calls resolveRepoFullName for the sandbox-required branch", () => {
    const sandboxBlock = DISP.match(/requires_sandbox && !isShadowSandboxRun && !isBench\)\s*\{([\s\S]*?)mcpServerTools\(/);
    expect(sandboxBlock, "sandbox block not found").toBeTruthy();
    expect(sandboxBlock![1]).toMatch(/await resolveRepoFullName\(/);
  });

  it("passes resolved repo into mcpSandbox, mcpBrowser, and the lazyProvision callback", () => {
    const sandboxBlock = DISP.match(/requires_sandbox && !isShadowSandboxRun && !isBench\)\s*\{([\s\S]*?)mcpServerTools\(/);
    expect(sandboxBlock).toBeTruthy();
    const matches = (sandboxBlock![1].match(/repo_full_name:\s*resolvedRepo/g) ?? []).length;
    expect(matches).toBe(3);
  });

  it("a lazy-eligible run that can't resolve a repo soft-fails (no connect-GitHub refusal)", () => {
    const sandboxBlock = DISP.match(/requires_sandbox && !isShadowSandboxRun && !isBench\)\s*\{([\s\S]*?)mcpServerTools\(/);
    expect(sandboxBlock).toBeTruthy();
    const block = sandboxBlock![1];
    expect(block).toMatch(/if \(ctx\.lazySandboxEligible\) \{\s*\n\s*lazyRepoUnresolved = true;/);
    expect(block).toMatch(/if \(!lazyRepoUnresolved\) \{/);
  });
});
