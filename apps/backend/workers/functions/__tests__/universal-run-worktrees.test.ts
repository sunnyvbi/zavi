
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  universalRunWorktreesEnabled,
  SANDBOX_AGENT_SLUGS,
} from "../run-agent";
import { escapeGuardRefusal } from "@/services/agents/sdk/mcp-sandbox";
import {
  detectCarriedConstants,
  type SandboxRunner,
} from "@/agents/engineer/helper-detection";

const BACKEND_ROOT = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(BACKEND_ROOT, rel), "utf8");

const CANARY_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

describe("universalRunWorktreesEnabled (rollout latch)", () => {
  it("off: '0' / 'false' / empty disable universal isolation", () => {
    expect(universalRunWorktreesEnabled("t-1", { UNIVERSAL_RUN_WORKTREES: "0" })).toBe(false);
    expect(universalRunWorktreesEnabled("t-1", { UNIVERSAL_RUN_WORKTREES: "false" })).toBe(false);
    expect(universalRunWorktreesEnabled("t-1", { UNIVERSAL_RUN_WORKTREES: "" })).toBe(false);
  });

  it("on: '1' / 'true' enable for every tenant", () => {
    expect(universalRunWorktreesEnabled("t-any", { UNIVERSAL_RUN_WORKTREES: "1" })).toBe(true);
    expect(universalRunWorktreesEnabled("t-any", { UNIVERSAL_RUN_WORKTREES: "true" })).toBe(true);
  });

  it("CSV canary: only listed tenants enabled", () => {
    const env = { UNIVERSAL_RUN_WORKTREES: "t-a, t-b" };
    expect(universalRunWorktreesEnabled("t-a", env)).toBe(true);
    expect(universalRunWorktreesEnabled("t-b", env)).toBe(true);
    expect(universalRunWorktreesEnabled("t-c", env)).toBe(false);
  });

  it("default (no env): ON for every tenant — canary phase completed 2026-06-09", () => {
    expect(universalRunWorktreesEnabled(CANARY_TENANT, {})).toBe(true);
    expect(universalRunWorktreesEnabled("t-other", {})).toBe(true);
  });
});

describe("SANDBOX_AGENT_SLUGS ↔ agent.md frontmatter parity", () => {
  it("matches exactly the agents declaring requires_sandbox: true", () => {
    const agentsDir = join(BACKEND_ROOT, "src", "agents");
    const fromFrontmatter = new Set<string>();
    for (const slug of readdirSync(agentsDir)) {
      const md = join(agentsDir, slug, "agent.md");
      if (!existsSync(md)) continue;
      const head = readFileSync(md, "utf8").slice(0, 2000);
      if (/^\s*requires_sandbox:\s*true\s*$/m.test(head)) {
        fromFrontmatter.add(slug);
      }
    }
    expect(new Set(SANDBOX_AGENT_SLUGS)).toEqual(fromFrontmatter);
  });
});

describe("escape-guard refusal text (worktree-isolated runs)", () => {
  const ROOT = "/home/user/wt-abc";
  it("names the actual repo root and drops the 'multi-task child' framing", () => {
    const cdMsg = escapeGuardRefusal("cd /etc", ROOT);
    const dotMsg = escapeGuardRefusal("cat ../sibling/f", ROOT);
    for (const msg of [cdMsg, dotMsg]) {
      expect(msg).toBeTruthy();
      expect(msg).toContain(ROOT);
      expect(msg).not.toContain("multi-task");
    }
  });
});

describe("sandbox detection repo_root threading", () => {
  function captureRunner(cmds: string[]): SandboxRunner {
    return async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.startsWith("test -f")) return { stdout: "", stderr: "", exit_code: 0 };
      if (cmd.startsWith("head -c"))
        return { stdout: "export const helper = 1;", stderr: "", exit_code: 0 };
      if (cmd.includes("git log"))
        return { stdout: `${Math.floor(Date.now() / 1000)}`, stderr: "", exit_code: 0 };
      return { stdout: "", stderr: "", exit_code: 1 };
    };
  }
  const files = [
    {
      path: "apps/web/src/lib/caller.ts",
      action: "modify" as const,
      diff: `+const HERO_SUFFIX = "no text, no logos, no watermarks please";`,
    },
  ];

  it("with repo_root: every sandbox command targets the worktree, never the main clone", async () => {
    const cmds: string[] = [];
    await detectCarriedConstants({
      files,
      run: captureRunner(cmds),
      repo_root: "/home/user/wt-zzz",
    });
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c).toContain("/home/user/wt-zzz");
      expect(c).not.toContain("/home/user/repo");
    }
  });

  it("without repo_root: legacy main-clone behavior is byte-identical", async () => {
    const cmds: string[] = [];
    await detectCarriedConstants({ files, run: captureRunner(cmds) });
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c).toContain("/home/user/repo");
    }
  });
});

describe("wiring grep-guards", () => {
  it("run-agent gates the universal worktree on !provisioned + the latch", () => {
    const src = read("workers/functions/run-agent.ts");
    expect(src).toContain("!resolvedCreds.provisioned &&");
    expect(src).toContain("universalRunWorktreesEnabled(claim.tenant_id)");
  });

  it("repo-creds marks ONLY the provision-token branch as provisioned", () => {
    const src = read("src/services/sandbox/repo-creds.ts");
    expect(src).toContain("provisioned: true");
    expect(src).toContain("provisioned: false");
  });

  it("post-run threads the run's worktree root into BOTH sandbox consumers", () => {
    const src = read("src/agents/engineer/post-run.ts");
    expect(src).toContain("_mt_repo_root");
    expect(src.match(/runRepoRoot \? \{ repo_root: runRepoRoot \}/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);
  });

  it("git_diff tool diffs HEAD, not a hardcoded origin/main", () => {
    const src = read("src/services/sandbox/tool-registry.ts");
    expect(src).toContain("git diff --no-ext-diff HEAD");
    expect(src).not.toContain("git diff --no-ext-diff origin/main");
  });

  it("worktree remove/reap + resetToMain run under the shared wt lock", () => {
    const wt = read("src/services/sandbox/run-worktree.ts");
    expect(wt.match(/flock -w 60 \/tmp\/_praxis_wt\.lock/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(4);
    const e2b = read("src/services/sandbox/e2b-client.ts");
    expect(e2b).toContain("exec 9>/tmp/_praxis_wt.lock && flock -w 60 9");
  });

  it("cron reaper keeps live runs with ABSENT repo_hint (never reaps a defaulted-repo live run)", () => {
    const src = read("workers/functions/batch-fanout-worktree-reaper.ts");
    expect(src).toContain("return true; // no hint → keep");
  });

  it("cron reaper DISCOVERS ordinary sandbox-agent worktrees, not just batch (Codex P2 — crashed ordinary runs would leak wt-* forever)", () => {
    const src = read("workers/functions/batch-fanout-worktree-reaper.ts");
    expect(src).toContain("SANDBOX_AGENT_SLUGS");
    expect(src).toContain("agent_slug.in.(");
  });

  it("run-agent opportunistic reap also keeps absent-repo_hint live runs", () => {
    const src = read("workers/functions/run-agent.ts");
    expect(src).toContain('typeof rh !== "string" || rh.length === 0');
  });
});
