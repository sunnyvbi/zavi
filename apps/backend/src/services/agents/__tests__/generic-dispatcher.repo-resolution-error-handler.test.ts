import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DISP = readFileSync(
  join(__dirname, "../generic-dispatcher.ts"),
  "utf8",
);

function extractCatchBlock(): string {
  const m = DISP.match(
    /resolveRepoFullName\([^)]*\)\s*;\s*\}\s*catch\s*\(\s*e\s*\)\s*\{([\s\S]*?)\n\s{4}\}/,
  );
  if (!m) {
    throw new Error(
      "Could not locate the resolveRepoFullName try/catch block — source layout changed?",
    );
  }
  return m[1];
}

describe("generic-dispatcher — RepoResolutionError soft-handle (BUG-001 v2, Task 1)", () => {
  it("imports serviceClient (needed for the catch-block side-effects)", () => {
    expect(DISP).toMatch(
      /import\s*\{\s*serviceClient\s*\}\s*from\s*["']@?\/?services\/supabase["']/,
    );
  });

  it("handles BOTH no_default_set AND no_github_connection codes", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/no_default_set/);
    expect(block).toMatch(/no_github_connection/);
  });

  it("still throws dispatch_error for OTHER RepoResolutionError codes", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/sandbox agent dispatch:/);
  });

  it("calls record_agent_chat_reply RPC (so the chat UI sees a message)", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/record_agent_chat_reply/);
  });

  it("does NOT call set_github_default_repo RPC (Fix 2 — bypass admin gate)", () => {
    const block = extractCatchBlock();
    expect(block).not.toMatch(/\.rpc\(\s*["']set_github_default_repo["']/);
  });

  it("does NOT call clear_github_default_repo RPC either", () => {
    const block = extractCatchBlock();
    expect(block).not.toMatch(/\.rpc\(\s*["']clear_github_default_repo["']/);
  });

  it("Case A (1 repo) resolves directly WITHOUT writing a tenant-global default (P0.e)", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/resolveRepoFullName\(/);
    expect(block).not.toMatch(/\.update\(\s*\{\s*default_repo_full_name:/);
  });

  it("persists pending_task_description into p_meta (Fix 1 — Task 2 re-dispatch needs it)", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/pending_task_description/);
  });

  it("uses awaiting_repo_pick meta key (matches Task 2 expectation)", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/awaiting_repo_pick/);
  });

  it("emits a 'Connect a repo' message for the no_github_connection case", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/Connect.*Settings.*Connectors.*GitHub/i);
  });

  it("emits an 'I need a repo to work in' message for the multi-repo case", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/I need a repo to work in/);
  });

  it("returns a synthetic SUCCESS DispatcherResult (not throws) for repo-pick cases", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/parse_ok:\s*true/);
    expect(block).toMatch(/output_text:/);
  });

  it("warns (not throws) when the single-repo resolve fails — degrades to ask-in-thread", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/console\.warn[\s\S]*single-repo resolve failed/);
  });

  it("guards thread_id presence before calling record_agent_chat_reply", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/if\s*\(\s*ctx\.thread_id\s*&&\s*!writesSuppressed\(ctx\)\s*\)/);
  });
});

describe("generic-dispatcher repo-pick fallback is SCOPED (P0-1 round-2 leak)", () => {
  it("builds the fallback candidate list from getScopedRepos, NOT a raw repo_full_names read", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/await getScopedRepos\(ctx\.tenant_id\)/);
    expect(block).not.toMatch(/\.select\(\s*["']repo_full_names["']\s*\)/);
  });

  it("derives `connected` (the listed + persisted set) from scoped.repos", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/const connected = scoped\.repos;/);
  });

  it("fails CLOSED to a selection-required prompt when scoping is active + post-scope set empty", () => {
    const block = extractCatchBlock();
    expect(block).toMatch(/scoped\.selectionRequired/);
    expect(block).toMatch(/repoAccessBlockedMessage\(\s*["']selection_required["']\s*\)/);
    expect(block).toMatch(/awaiting_repo_pick:\s*false/);
  });
});
