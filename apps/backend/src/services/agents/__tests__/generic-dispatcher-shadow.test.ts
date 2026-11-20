import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf-8");
const typesSrc = readFileSync(join(__dirname, "../types.ts"), "utf-8");
const runnerSrc = readFileSync(join(__dirname, "../runner.ts"), "utf-8");

const bodyStart = src.indexOf("export async function runGeneric(");
const body = src.slice(bodyStart);

describe("shadow-mode — context flag + plumbing", () => {
  it("AgentContext carries an optional shadow_mode flag (default off)", () => {
    expect(typesSrc).toMatch(/shadow_mode\?: boolean;/);
  });

  it("derives a run-scoped isShadowRun from ctx.shadow_mode", () => {
    expect(body).toMatch(/const isShadowRun = ctx\.shadow_mode === true;/);
  });

  it("exports ClaimedAgentRun for the replay script", () => {
    expect(runnerSrc).toMatch(/export type ClaimedAgentRun = \{/);
  });
});

describe("shadow-mode — thread-event CHOKEPOINT (leak-proof)", () => {
  it("defines teEmit + teOnce that no-op under shadow", () => {
    expect(body).toMatch(/const teEmit: typeof safeEmitThreadEvent = suppressThreadEvents/);
    expect(body).toMatch(/const teOnce: typeof emitThreadEventOnce = suppressThreadEvents/);
    expect(body).toMatch(/suppressThreadEvents\s*\n?\s*\?\s*async \(\) => \{\}/);
    expect(body).toMatch(/suppressThreadEvents\s*=\s*isShadowRun\s*\|\|\s*ctx\.draft_mode\s*===\s*true/);
  });

  it("LEAK GUARD: zero raw safeEmitThreadEvent(/emitThreadEventOnce( CALLS remain in the runGeneric body — all route through teEmit/teOnce", () => {
    const rawSafeCalls = (body.match(/\bsafeEmitThreadEvent\(/g) ?? []).length;
    const rawOnceCalls = (body.match(/\bemitThreadEventOnce\(/g) ?? []).length;
    expect(rawSafeCalls, "raw safeEmitThreadEvent( calls in body").toBe(0);
    expect(rawOnceCalls, "raw emitThreadEventOnce( calls in body").toBe(0);
  });

  it("routes the onEvent writer's thread-event sink through teEmit (covers the OpenAI branch)", () => {
    expect(body).toMatch(/safeEmitThreadEvent: teEmit/);
  });
});

describe("shadow-mode — engine forcing (no resolveRunEngine mutation)", () => {
  it("derives providerForRun from the configurable shadow provider (env, default openai)", () => {
    expect(body).toMatch(
      /const shadowProvider: Provider =[\s\S]*?PRAXIS_SHADOW_PROVIDER === "bedrock"[\s\S]*?"bedrock"[\s\S]*?PRAXIS_SHADOW_PROVIDER === "fireworks"[\s\S]*?"fireworks"[\s\S]*?PRAXIS_SHADOW_PROVIDER === "codex"[\s\S]*?"codex"[\s\S]*?: "openai";/,
    );
    expect(body).toMatch(/const providerForRun = isShadowRun \? shadowProvider : liveFunnel!\.providerForRun;/);
    expect(body).toMatch(/resolvedProvider:\s*provider,/);
  });

  it("derives modelForRun per shadow provider (openai gpt-5.5 / bedrock Qwen3 / fireworks GLM-5.2)", () => {
    expect(body).toMatch(/process\.env\.PRAXIS_SHADOW_OPENAI_MODEL \|\| "gpt-5\.5"/);
    expect(body).toMatch(
      /process\.env\.PRAXIS_SHADOW_BEDROCK_MODEL \|\| MODELS\.bedrock\.qwen3Next80b/,
    );
    expect(body).toMatch(
      /process\.env\.PRAXIS_SHADOW_FIREWORKS_MODEL \|\| MODELS\.fireworks\.glm52/,
    );
  });

  it("fail-closed: a shadow run that resolves to ANTHROPIC THROWS (any non-anthropic shadow engine OK)", () => {
    expect(body).toMatch(
      /if \(isShadowRun && providerForRun === "anthropic" && !isBenchClaudeSdkRun\) \{\s*\n?\s*throw new Error/,
    );
    expect(body).toMatch(/const isBench = isShadowRun && isBenchRun\(ctx\);/);
    expect(body).toMatch(
      /const isBenchClaudeSdkRun = isBench && ctx\.bench_engine === "claude_sdk";/,
    );
  });

  it("the provider branch + pickEngine + openAiSpec.model + budget monitor consume the run-locals (not the raw resolved const)", () => {
    expect(body).toMatch(/if \(providerForRun === "anthropic" && !useAnthropicEngine\) \{/);
    expect(body).toMatch(/pickEngine\(providerForRun\)/);
    expect((body.match(/model: modelForRun,/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("terminal cost uses modelForRun, NOT effectiveModel (shadow cost-model fix 2026-06-14)", () => {
    expect(body).toMatch(
      /sdkCostUsd =\s*\n?\s*ev\.costUsd \?\?\s*\n?\s*estimateEngineCostUsd\(\s*\n?\s*providerForRun,[\s\S]*?modelForRun,/,
    );
    expect(body).not.toMatch(
      /estimateEngineCostUsd\(\s*\n?\s*providerForRun,\s*\n?\s*effectiveModel,/,
    );
  });
});

describe("shadow-mode — spend + decision + chat-reply guards", () => {
  it("budget headroom is disabled under shadow (source tenant cap can't abort)", () => {
    expect(body).toMatch(
      /if \(isShadowRun\) \{\s*\n?\s*budgetHeadroomUsd = Number\.POSITIVE_INFINITY;/,
    );
  });

  it("the OpenAI dispatch funnel gets shadow_mode (gate-0) + a no-op emit_decision", () => {
    expect(body).toMatch(/shadow_mode: ctx\.shadow_mode,/);
    expect(body).toMatch(
      /emit_decision: ctx\.shadow_mode\s*\n?\s*\?\s*async \(\) => "shadow_noop"/,
    );
  });

  it("record_agent_chat_reply is guarded by !writesSuppressed(ctx) (no live chat write on shadow/draft)", () => {
    expect(body).toMatch(/if \(ctx\.thread_id && !writesSuppressed\(ctx\)\) \{/);
  });
});
