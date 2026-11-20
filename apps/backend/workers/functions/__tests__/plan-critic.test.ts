import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../plan-critic.ts"), "utf8");

describe("plan-critic worker fn — source-level guards", () => {
  it("has THREE step.run boundaries with run_id-suffixed stable IDs (memoization regression)", () => {
    expect(SRC).toMatch(/step\.run\(\s*`plan-critic-hydrate-\$\{run_id\}`/);
    expect(SRC).toMatch(/step\.run\(\s*`plan-critic-run-\$\{run_id\}`/);
    expect(SRC).toMatch(/step\.run\(\s*`plan-critic-emit-\$\{run_id\}`/);
  });

  it("re-derives tenant_id from agent_runs (Codex C8 trust boundary) — never trusts event payload", () => {
    expect(SRC).toMatch(/\.from\(\s*["']agent_runs["']\s*\)/);
    expect(SRC).toMatch(/\.select\(\s*["']tenant_id,\s*agent_slug,\s*payload["']\s*\)/);
    expect(SRC).not.toMatch(/\.select\([^)]*thread_id[^)]*\)/);
    expect(SRC).toMatch(/\.eq\(\s*["']id["']\s*,\s*run_id\s*\)/);
    expect(SRC).toMatch(/tenant_id:\s*hydrated\.tenant_id/);
  });

  it("derives thread_id from payload jsonb (no top-level thread_id column on agent_runs)", () => {
    expect(SRC).toMatch(/payloadObj\?\.thread_id|payload[^,]*\.thread_id|payload->>\s*['"]thread_id/);
    expect(SRC).toMatch(/typeof\s+\w+\s*===\s*["']string["']/);
  });

  it("slug-gates to engineer (spoofed-event defense)", () => {
    expect(SRC).toMatch(/row\.agent_slug\s*!==\s*["']engineer["']/);
    expect(SRC).toMatch(/plan-critic skipped: agent_slug=/);
  });

  it("emits as plan_critic_verdict kind — NOT mutating the plan row", () => {
    expect(SRC).toMatch(/kind:\s*["']plan_critic_verdict["']/);
    expect(SRC).not.toMatch(/\.from\(\s*["']thread_event["']\s*\)\s*\.update/);
    expect(SRC).not.toMatch(/jsonb_set/);
  });

  it("registers on the agent.plan-critic-needed event with retries: 2", () => {
    expect(SRC).toMatch(/event:\s*["']agent\.plan-critic-needed["']/);
    expect(SRC).toMatch(/retries:\s*2/);
    expect(SRC).toMatch(/id:\s*["']plan-critic["']/);
  });

  it("uses memory.company for stage_context with the documented fallback (mirrors engineer post-run)", () => {
    expect(SRC).toMatch(/loadMemoryDocs\(row\.tenant_id\)/);
    expect(SRC).toMatch(/STAGE_CONTEXT_FALLBACK/);
    expect(SRC).toMatch(/company.*trim\(\)\.length\s*>\s*0/);
  });
});

const REGISTRY_SRC = readFileSync(
  join(__dirname, "../index.ts"),
  "utf8",
);
describe("plan-critic worker fn — registry", () => {
  it("imported and listed in inngestFunctions array", () => {
    expect(REGISTRY_SRC).toMatch(/import\s+\{\s*planCriticFn\s*\}\s+from\s+["']\.\/plan-critic["']/);
    expect(REGISTRY_SRC).toMatch(/planCriticFn,/);
  });
});
