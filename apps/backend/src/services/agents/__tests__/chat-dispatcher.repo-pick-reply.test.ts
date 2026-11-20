import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DISP = readFileSync(
  join(__dirname, "../chat-dispatcher.ts"),
  "utf8",
);

function extractRepoPickBlock(): string {
  const m = DISP.match(
    /\/\/ 2a-bis\. Repo-pick reply detection[\s\S]*?\/\/ 2b\. Tenant-command injection/,
  );
  if (!m) {
    throw new Error(
      "Could not locate the 2a-bis repo-pick detection block — source layout changed?",
    );
  }
  return m[0];
}

describe("chat-dispatcher — repo-pick reply detection (BUG-001 v2, Task 2)", () => {
  it("queries agent_thread_messages for the last assistant msg with meta", () => {
    const block = extractRepoPickBlock();
    expect(block).toMatch(/agent_thread_messages/);
    expect(block).toMatch(/sender_role.*assistant|"assistant"/);
    expect(block).toMatch(/order\(\s*"created_at"[\s\S]*ascending:\s*false/);
    expect(block).toMatch(/\.limit\(\s*1\s*\)/);
  });

  it("allows only metadata fields and never selects message body/content", () => {
    const block = extractRepoPickBlock();
    const projections = [...block.matchAll(/\.select\(\s*["']([^"']+)["']\s*\)/g)]
      .map((match) => match[1].split(",").map((field) => field.trim()));

    expect(projections.length).toBeGreaterThan(0);
    for (const fields of projections) {
      expect(fields).toContain("meta");
      expect(fields).toContain("agent_run_id");
      expect(fields).not.toContain("body");
      expect(fields).not.toContain("content");
      expect(fields).not.toContain("message");
      expect(fields).not.toContain("text");
    }
  });

  it("checks awaiting_repo_pick === true (strict — not truthy)", () => {
    const block = extractRepoPickBlock();
    expect(block).toMatch(/awaiting_repo_pick\s*===\s*true/);
  });

  it("matches user message against repos list with EXACT (not fuzzy) match", () => {
    const block = extractRepoPickBlock();
    expect(block).toMatch(/\.includes\(\s*candidate\s*\)/);
    expect(block).toMatch(/current_message\.trim\(\)/);
  });

  it("persists PER-THREAD (agent_threads.repo_full_name), NOT a tenant-global default (P0.e)", () => {
    const block = extractRepoPickBlock();
    expect(block).toMatch(/\.from\(\s*["']agent_threads["']\s*\)/);
    expect(block).toMatch(/\.update\(\s*\{\s*repo_full_name:\s*candidate\s*\}\s*\)/);
    expect(block).not.toMatch(/\.update\(\s*\{\s*default_repo_full_name:/);
    expect(block).not.toMatch(/\.rpc\(\s*["']set_github_default_repo["']/);
  });

  it("injects repo_hint into payload on successful pick (so this run resolves)", () => {
    const block = extractRepoPickBlock();
    expect(block).toMatch(/repo_hint/);
  });

  it("restores pending_task_description as task_description (Fix 1 — preserve original ask)", () => {
    const block = extractRepoPickBlock();
    expect(block).toMatch(/pending_task_description/);
    expect(block).toMatch(/task_description/);
    expect(block).toMatch(/llm_input_message\s*=/);
  });

  it("filters the repos array to strings only (defensive vs poisoned meta)", () => {
    const block = extractRepoPickBlock();
    expect(block).toMatch(/typeof\s+r\s*===\s*["']string["']/);
  });

  it("degrades gracefully on UPDATE failure (warns, doesn't crash)", () => {
    const block = extractRepoPickBlock();
    expect(block).toMatch(/console\.warn[\s\S]*persist per-thread repo failed/);
  });

  it("guards on awaiting.repos being an array (defensive vs poisoned meta)", () => {
    const block = extractRepoPickBlock();
    expect(block).toMatch(/Array\.isArray\(\s*awaiting\.repos\s*\)/);
  });

  it("does nothing when there is no prior awaiting_repo_pick (normal flow)", () => {
    const block = extractRepoPickBlock();
    expect(block).toMatch(
      /if\s*\(\s*awaiting\.awaiting_repo_pick\s*===\s*true/,
    );
  });

  it("only runs ONCE per turn (within a single `let llm_input_message` scope)", () => {
    const allDeclarations = DISP.match(/let\s+llm_input_message\s*:/g) ?? [];
    expect(allDeclarations).toHaveLength(1);
  });
});
