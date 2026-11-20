import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(__dirname, "../../routes/agents/chat-send.ts"),
  "utf8",
);

function extractPickedBlock(): string {
  const m = SRC.match(
    /const picked = parseRepoPickReply\([\s\S]*?\}\s*else if \(pendingTask\.length > 0\)/,
  );
  if (!m) {
    throw new Error(
      "Could not locate the parseRepoPickReply picked-block — chat-send.ts layout changed?",
    );
  }
  return m[0];
}

describe("chat-send — pick-reply does NOT write a tenant-global default (P0.e)", () => {
  it("the pick-reply branch sets repoHint = picked (per-run resolution intact)", () => {
    const block = extractPickedBlock();
    expect(block).toMatch(/repoHint = picked/);
  });

  it("does NOT write connector_metadata.default_repo_full_name in the pick branch", () => {
    const block = extractPickedBlock();
    expect(block).not.toMatch(/\.update\(\s*\{\s*default_repo_full_name:/);
  });

  it("the WHOLE chat-send file no longer writes default_repo_full_name implicitly", () => {
    expect(SRC).not.toMatch(/\.update\(\s*\{\s*default_repo_full_name:/);
  });

  it("does NOT use the set_github_default_repo RPC either", () => {
    const block = extractPickedBlock();
    expect(block).not.toMatch(/\.rpc\(\s*["']set_github_default_repo["']/);
  });
});

describe("chat-send — repo-switch via chat (explicit / infer / sticky)", () => {
  it("Body schema accepts an optional repo_hint", () => {
    expect(SRC).toMatch(/repo_hint:\s*z\.string\(\)\.max\(120\)\.optional\(\)/);
  });

  function selectionBlock(): string {
    const start = SRC.indexOf("if (!repoHint) {");
    expect(start).toBeGreaterThan(-1);
    return SRC.slice(start, start + 3500);
  }

  it("explicit repo_hint is validated against the tenant's connected repos", () => {
    const b = selectionBlock();
    expect(b).toMatch(/if \(body\.repo_hint\)/);
    expect(b).toMatch(/connectedRepos\.includes\(body\.repo_hint\)/);
  });

  it("an unconnected repo_hint is REJECTED with 400 + the run is cancelled (no orphan)", () => {
    const b = selectionBlock();
    expect(b).toMatch(/status:\s*["']cancelled["']/);
    expect(b).toMatch(/repo_hint_not_connected/);
    expect(b).toMatch(/res\.status\(400\)/);
    const cancelIdx = b.indexOf('status: "cancelled"');
    const respIdx = b.indexOf("repo_hint_not_connected");
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeLessThan(respIdx);
  });

  it("explicit wins over inference (body.repo_hint checked before pickRepoForTask)", () => {
    const b = selectionBlock();
    const explicitIdx = b.indexOf("if (body.repo_hint)");
    const inferIdx = b.indexOf("pickRepoForTask");
    expect(explicitIdx).toBeGreaterThan(-1);
    expect(inferIdx).toBeGreaterThan(-1);
    expect(explicitIdx).toBeLessThan(inferIdx);
  });

  it("inference only runs when >1 repo is connected (single-repo common case unchanged)", () => {
    const b = selectionBlock();
    expect(b).toMatch(/connectedRepos\.length > 1/);
  });

  it("thread stickiness reads agent_threads.repo_full_name, re-validated against connected", () => {
    const b = selectionBlock();
    expect(b).toMatch(/\.from\(\s*["']agent_threads["']\s*\)[\s\S]*?repo_full_name/);
    expect(b).toMatch(/connectedRepos\.includes\(sticky\)/);
  });

  it("resolved repo is persisted to the THREAD (per-thread), not the tenant global default", () => {
    expect(SRC).toMatch(/\.update\(\s*\{\s*repo_full_name:\s*repoHint\s*\}\s*\)/);
    expect(SRC).toMatch(/persist sticky repo failed/);
    const stickyIdx = SRC.indexOf(".update({ repo_full_name: repoHint })");
    expect(stickyIdx).toBeGreaterThan(-1);
  });

  it("stickiness persist keys on the RESOLVED thread_id, not body.thread_id (first-turn fix)", () => {
    const persistBlock = SRC.slice(
      SRC.indexOf("persist the resolved repo onto the THREAD"),
      SRC.indexOf(".update({ repo_full_name: repoHint })") + 200,
    );
    expect(persistBlock).toMatch(/if \(repoHint && thread_id\)/);
    expect(persistBlock).not.toMatch(/if \(repoHint && body\.thread_id\)/);
  });
});
