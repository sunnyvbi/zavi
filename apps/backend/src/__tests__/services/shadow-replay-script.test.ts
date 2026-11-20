import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(__dirname, "../../../scripts/shadow-replay.ts"),
  "utf-8",
);

describe("shadow-replay script — safety wiring", () => {
  it("Slice 2: --tenant gated on the shadow allowlist (dogfood always; customers opt-in)", () => {
    expect(src).toMatch(/isShadowTenantAllowed/);
    expect(src).toMatch(/from "\.\.\/src\/services\/eval\/shadow-tenant-allowlist"/);
    expect(src).toMatch(/function assertSourceTenantMatches/);
    expect(src).toMatch(/row\.tenant_id !== allowedTenant/);
    expect(src).not.toMatch(/row\.tenant_id !== DOGFOOD_TENANT/);
  });

  it("Slice 2: --tenant is required + asserted on the allowlist BEFORE any spend (fail-closed)", () => {
    expect(src).toMatch(/--tenant <uuid> is required/);
    expect(src).toMatch(/if \(!\(await isShadowTenantAllowed\(args\.tenant\)\)\)/);
    const mainIdx = src.indexOf("async function main()");
    const allowIdx = src.indexOf("is not on the shadow allowlist — aborting", mainIdx);
    const selectIdx = src.indexOf("await selectSources(args)", mainIdx);
    expect(allowIdx).toBeGreaterThan(mainIdx);
    expect(selectIdx).toBeGreaterThan(allowIdx);
    expect(src).toMatch(/if \(!\(await isShadowTenantAllowed\(tenant\)\)\)/);
  });

  it("Slice 2: selects success rows for the REQUESTED tenant WITH a prompt_snapshot, NO chat-trigger filter", () => {
    expect(src).toMatch(/\.eq\("tenant_id", tenant\)/);
    expect(src).toMatch(/\.eq\("status", "success"\)/);
    expect(src).toMatch(/\.not\("prompt_snapshot", "is", null\)/);
    expect(src).not.toMatch(/\.eq\("trigger", "chat"\)/);
  });

  it("P2/P3: growth-lead + engineer unlocked in SHADOW_AGENTS; qa still excluded", () => {
    expect(src).toMatch(/"growth-lead"/);
    expect(src).toMatch(/SHADOW_AGENTS = new Set\(\[[\s\S]*?"engineer"[\s\S]*?\]\)/);
    expect(src).not.toMatch(/SHADOW_AGENTS = new Set\(\[[\s\S]*?"qa"[\s\S]*?\]\)/);
  });

  it("P3: engineer is a SANDBOX agent → provisions a fresh box + tears it down", () => {
    expect(src).toMatch(/SHADOW_SANDBOX_AGENTS = new Set\(\["engineer"\]\)/);
    expect(src).toMatch(/createShadowSandboxForRun\(/);
    expect(src).toMatch(/ctx\.shadow_sandbox_id = handle\.sandbox_id/);
    expect(src).toMatch(/destroyShadowSandbox\(handle\?\.sandbox_id\)/);
  });

  it("P3: create the box BEFORE charging budget (no spend on a box that won't boot)", () => {
    const createIdx = src.indexOf("await createShadowSandboxForRun({");
    const budgetIdx = src.indexOf('.rpc(\n      "consume_shadow_budget_or_reject"');
    expect(createIdx).toBeGreaterThan(0);
    expect(budgetIdx).toBeGreaterThan(createIdx);
  });

  it("P3: sandbox-agent branch sets shadow_sandbox_id; tool-results map is the ELSE branch", () => {
    expect(src).toMatch(
      /if \(needsSandbox && handle\) \{[\s\S]*?ctx\.shadow_sandbox_id = handle\.sandbox_id;[\s\S]*?\} else \{[\s\S]*?ctx\.shadow_tool_results = buildShadowToolResults\(/,
    );
  });

  it("P3 teardown: a provision failure tears down the half-created box; finally always destroys", () => {
    expect(src).toMatch(/ShadowSandboxProvisionError/);
    expect(src).toMatch(/await destroyShadowSandbox\(e\.sandbox_id\)/);
    expect(src).toMatch(/\} finally \{[\s\S]*?await destroyShadowSandbox\(handle\?\.sandbox_id\)/);
  });

  it("P3: per-agent budget estimate — engineer reserves more than the light-agent floor", () => {
    expect(src).toMatch(/function shadowBudgetEstimateUsd/);
    expect(src).toMatch(/p_estimated_usd: shadowBudgetEstimateUsd\(row\.agent_slug\)/);
    expect(src).toMatch(/SHADOW_SANDBOX_AGENTS\.has\(agent_slug\) \? 2\.5 : 0\.5/);
  });

  it("P2b: selects tool_calls + sets ctx.shadow_tool_results from buildShadowToolResults (same-evidence)", () => {
    expect(src).toMatch(/tool_calls/);
    expect(src).toMatch(/ctx\.shadow_tool_results = buildShadowToolResults\(/);
  });

  it("P2: skips a setup-preflight short-circuit (LLM-not-called) instead of inserting a misleading success row", () => {
    expect(src).toMatch(/envelope_kind/);
    expect(src).toMatch(/=== "setup_required"/);
    expect(src).toMatch(/skip .* setup short-circuit/);
    const skipIdx = src.indexOf('setup short-circuit');
    const insertIdx = src.indexOf('insert_shadow_run', skipIdx);
    expect(skipIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(skipIdx);
  });

  it("P2: parses prompt_snapshot + skips (no lossy fallback) BEFORE budget spend, sets shadow_prompt_override", () => {
    expect(src).toMatch(/parsePromptSnapshot\(row\.prompt_snapshot, row\.trigger === "chat"\)/);
    expect(src).toMatch(/ctx\.shadow_prompt_override = pre/);
    const parseIdx = src.indexOf("parsePromptSnapshot(row.prompt_snapshot");
    const budgetIdx2 = src.indexOf("consume_shadow_budget_or_reject", parseIdx);
    expect(parseIdx).toBeGreaterThan(0);
    expect(budgetIdx2).toBeGreaterThan(parseIdx);
  });

  it("gates spend on consume_shadow_budget_or_reject BEFORE any OpenAI call (fail-closed)", () => {
    expect(src).toMatch(/consume_shadow_budget_or_reject/);
    expect(src).toMatch(/budget !== "charged"/);
    const budgetIdx = src.indexOf("consume_shadow_budget_or_reject");
    const runIdx = src.indexOf("runGeneric(");
    expect(budgetIdx).toBeGreaterThan(0);
    expect(runIdx).toBeGreaterThan(budgetIdx);
  });

  it("applies the FULL shadow ctx override set (shadow_mode + emitDecision + emitProgress no-op)", () => {
    expect(src).toMatch(/ctx\.shadow_mode = true;/);
    expect(src).toMatch(/ctx\.emitDecision = async \(\) => "shadow_noop";/);
    expect(src).toMatch(/ctx\.emitProgress = async \(\) => \{\};/);
  });

  it("calls runGeneric DIRECTLY — never runDispatch / persistTerminal / the worker", () => {
    expect(src).toMatch(/runGeneric\(ctx, claim\.payload\)/);
    expect(src).not.toMatch(/runDispatch\(/);
    expect(src).not.toMatch(/persistTerminal\(/);
  });

  it("persists via insert_shadow_run with source_agent_run_id + raw-vs-raw basis", () => {
    expect(src).toMatch(/insert_shadow_run/);
    expect(src).toMatch(/p_source_agent_run_id: row\.id/);
    expect(src).toMatch(/p_mode: "offline_replay"/);
    expect(src).toMatch(/p_comparison_basis: "raw_vs_raw"/);
  });

  it("aborts cleanly when OPENAI_API_KEY is absent (getOpenAi null check)", () => {
    expect(src).toMatch(/if \(!getOpenAi\(\)\)/);
    expect(src).toMatch(/process\.exit\(1\)/);
  });

  it("forces the shadow model from PRAXIS_SHADOW_OPENAI_MODEL (default gpt-5.5)", () => {
    expect(src).toMatch(
      /SHADOW_MODEL = process\.env\.PRAXIS_SHADOW_OPENAI_MODEL \|\| "gpt-5\.5"/,
    );
  });
});

describe("shadow-replay script — OpenAI-compatible provider extensions", () => {
  it("accepts --provider openai|bedrock|fireworks|codex (default openai)", () => {
    expect(src).toMatch(/provider: "openai" \| "bedrock" \| "fireworks" \| "codex"/);
    expect(src).toMatch(
      /out\.provider =[\s\S]*?p === "bedrock"[\s\S]*?"bedrock"[\s\S]*?p === "fireworks"[\s\S]*?"fireworks"[\s\S]*?p === "codex"[\s\S]*?"codex"[\s\S]*?: "openai"/,
    );
    expect(src).toMatch(/const out: Args = \{ limit: 5, provider: "openai" \}/);
  });

  it("WIRING: exports PRAXIS_SHADOW_PROVIDER (+ model env) BEFORE replay so --provider actually routes the dispatcher", () => {
    expect(src).toMatch(/process\.env\.PRAXIS_SHADOW_PROVIDER = "bedrock"/);
    expect(src).toMatch(/process\.env\.PRAXIS_SHADOW_BEDROCK_MODEL = SHADOW_MODEL/);
    expect(src).toMatch(/process\.env\.PRAXIS_SHADOW_PROVIDER = "fireworks"/);
    expect(src).toMatch(/process\.env\.PRAXIS_SHADOW_FIREWORKS_MODEL = SHADOW_MODEL/);
    expect(src).toMatch(/process\.env\.PRAXIS_SHADOW_PROVIDER = "openai"/);
    expect(src).toMatch(/process\.env\.PRAXIS_SHADOW_PROVIDER = "codex"/);
  });

  it("bedrock preflight requires the Bedrock envs (NOT getOpenAi); openai keeps getOpenAi", () => {
    expect(src).toMatch(/BEDROCK_OPENAI_BASE_URL[\s\S]*?AWS_BEARER_TOKEN_BEDROCK/);
    expect(src).toMatch(/MODELS\.bedrock\.qwen3Next80b/);
  });

  it("fireworks preflight requires FIREWORKS_API_KEY and defaults to GLM-5.2", () => {
    expect(src).toMatch(/FIREWORKS_API_KEY/);
    expect(src).toMatch(/MODELS\.fireworks\.glm52/);
  });

  it("stateless candidates EXCLUDE engineer (sandbox agent runs tools live under shadow) — runtime filter, set literal unchanged", () => {
    expect(src).toMatch(/function effectiveShadowAgents\(\)/);
    expect(src).toMatch(
      /SHADOW_PROVIDER !== "bedrock" && SHADOW_PROVIDER !== "fireworks"[\s\S]*?return SHADOW_AGENTS/,
    );
    expect(src).toMatch(/filter\(\(a\) => !SHADOW_SANDBOX_AGENTS\.has\(a\)\)/);
    expect(src).toMatch(/\.in\("agent_slug", \[\.\.\.effectiveShadowAgents\(\)\]\)/);
    expect(src).toMatch(/!effectiveShadowAgents\(\)\.has\(row\.agent_slug\)/);
  });

  it("writes p_provider to the agent_shadow_runs row", () => {
    expect(src).toMatch(/p_provider: SHADOW_PROVIDER/);
  });
});

import { buildEvidencePacket } from "../../../scripts/shadow-replay";

describe("shadow-replay — evidence-packet injection (eval fairness, 2026-06-14)", () => {
  it("buildEvidencePacket formats captured tool traces (name/input/output)", () => {
    const p = buildEvidencePacket([
      { name: "operator_db__query", input_preview: "GMV last 30d", output_preview: "GMV=$104k", ms: 5, status: "ok" } as any,
    ]);
    expect(p).toMatch(/## EVIDENCE/);
    expect(p).toMatch(/### operator_db__query\(GMV last 30d\)/);
    expect(p).toMatch(/GMV=\$104k/);
  });
  it("empty/no traces → empty packet (no injection)", () => {
    expect(buildEvidencePacket([])).toBe("");
    expect(buildEvidencePacket(undefined as any)).toBe("");
  });
  it("caps total size so a tool-heavy run can't blow context", () => {
    const big = Array.from({ length: 50 }, (_, i) => ({
      name: `t${i}`, input_preview: "x", output_preview: "y".repeat(6000), ms: 1, status: "ok",
    })) as any;
    expect(buildEvidencePacket(big).length).toBeLessThan(60_000);
  });
  it("the non-sandbox replay injects the packet into shadow_prompt_override (kill-switch PRAXIS_SHADOW_INJECT_EVIDENCE=0)", () => {
    expect(src).toMatch(/PRAXIS_SHADOW_INJECT_EVIDENCE !== "0"/);
    expect(src).toMatch(/buildEvidencePacket\(captured\)/);
    expect(src).toMatch(/system: pre\.system \+ packet/);
  });
});
