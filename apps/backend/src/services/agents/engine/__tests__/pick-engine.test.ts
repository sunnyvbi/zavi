
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { pickProvider, pickEngine } from "../pick-engine";
import {
  OpenAIAgentEngine,
  BedrockOpenAICompatAgentEngine,
  FireworksOpenAICompatAgentEngine,
} from "../openai-engine";
import { AnthropicAgentEngine } from "../anthropic-engine";

describe("pickProvider", () => {
  it("(a) default agent (no provider field) → anthropic (Claude query() path)", () => {
    expect(pickProvider({})).toBe("anthropic");
    expect(pickProvider({ provider: undefined })).toBe("anthropic");
  });

  it("(b) provider:'openai' agent → openai", () => {
    expect(pickProvider({ provider: "openai" })).toBe("openai");
  });

  it("provider:'bedrock' agent → bedrock", () => {
    expect(pickProvider({ provider: "bedrock" })).toBe("bedrock");
  });

  it("provider:'fireworks' agent → fireworks", () => {
    expect(pickProvider({ provider: "fireworks" })).toBe("fireworks");
  });

  it("provider:'anthropic' explicit → anthropic", () => {
    expect(pickProvider({ provider: "anthropic" })).toBe("anthropic");
  });
});

describe("pickEngine", () => {
  it("(b) provider 'openai' → an OpenAIAgentEngine instance", () => {
    const engine = pickEngine("openai");
    expect(engine).toBeInstanceOf(OpenAIAgentEngine);
    expect(engine.provider).toBe("openai");
  });

  it("anthropic → an AnthropicAgentEngine instance (Phase 2, Design C)", () => {
    const engine = pickEngine("anthropic");
    expect(engine).toBeInstanceOf(AnthropicAgentEngine);
    expect(engine.provider).toBe("anthropic");
  });

  it("provider 'bedrock' → a BedrockOpenAICompatAgentEngine instance", () => {
    const engine = pickEngine("bedrock");
    expect(engine).toBeInstanceOf(BedrockOpenAICompatAgentEngine);
    expect(engine.provider).toBe("bedrock");
  });

  it("provider 'fireworks' → a FireworksOpenAICompatAgentEngine instance", () => {
    const engine = pickEngine("fireworks");
    expect(engine).toBeInstanceOf(FireworksOpenAICompatAgentEngine);
    expect(engine.provider).toBe("fireworks");
  });
});

const DISP = readFileSync(
  join(__dirname, "../../generic-dispatcher.ts"),
  "utf8",
);

function openAiBranchBody(): string {
  const m = DISP.match(
    /OPENAI ENGINE BRANCH[\s\S]*?(?=\n  if \(lastStopReason === "error_max_turns"\))/,
  );
  expect(m, "OpenAI branch body not found").toBeTruthy();
  return m![0];
}

function anthropicBranchBody(): string {
  const m = DISP.match(
    /if \(providerForRun === "anthropic" && !useAnthropicEngine\) \{([\s\S]*?)\n  \} else if \(useAnthropicEngine\) \{/,
  );
  expect(m, "anthropic inline branch body not found").toBeTruthy();
  return m![1];
}

function anthropicEngineBranchBody(): string {
  const m = DISP.match(
    /ANTHROPIC ENGINE BRANCH[\s\S]*?(?=\n  \} else \{\n    \/\/ ─+\n    \/\/ OPENAI ENGINE BRANCH)/,
  );
  expect(m, "anthropic engine branch body not found").toBeTruthy();
  return m![0];
}

describe("generic-dispatcher provider branch", () => {
  it("resolves provider+model once via resolveRunEngine (per-tenant override over agent default)", () => {
    expect(DISP).toMatch(/await resolveRunEngine\(\s*ctx\.tenant_id,\s*ctx\.agent\.slug,\s*ctx\.agent\.metadata_praxis,?\s*\)/);
    expect(DISP).toMatch(/model: effectiveModel,/);
    expect(DISP).toMatch(/source: engineSource,/);
  });

  it("(a) the Claude query() path is wrapped in `if (provider === \"anthropic\")` (untouched, zero-regression)", () => {
    expect(anthropicBranchBody()).toMatch(/const stream = query\(\{/);
  });

  it("(a) the OpenAI engine is NEVER referenced inside the anthropic branch", () => {
    const body = anthropicBranchBody();
    expect(body).not.toMatch(/pickEngine/);
    expect(body).not.toMatch(/openAiSpec/);
    expect(body).not.toMatch(/applyOpenAiAddendum/);
  });

  it("(b) the OpenAI branch instantiates the engine via pickEngine(providerForRun) + drives engine.run(spec)", () => {
    const body = openAiBranchBody();
    expect(body).toMatch(/const openAiEngine = pickEngine\(providerForRun\)/);
    expect(body).toMatch(/openAiEngine\.run\(openAiSpec\)/);
    expect(body).toMatch(/systemPrompt: applyOpenAiAddendum\(ctx\.agent\.slug, sdkSystemPrompt\)/);
    expect(body).toMatch(/model: modelForRun/);
    expect(body).toMatch(/maxTurns: ctx\.agent\.metadata_praxis\.tool_iter_cap \?\? MAX_TOOL_ITERS/);
    expect(body).toMatch(/resume: null/);
    expect(body).toMatch(/resumeSessionId: null/);
  });

  it("(c) the OpenAI branch routes tools through the SAME makeDispatchTool funnel", () => {
    const body = openAiBranchBody();
    expect(body).toMatch(/const openAiDispatchTool = makeDispatchTool\(\{/);
    expect(body).toMatch(/dispatchTool: benchWrap\(openAiDispatchTool\)/);
    expect(DISP).toMatch(/const benchWrap = [\s\S]*?\n\s+isBench\n\s+\? \(wrapBenchDispatch\(d, \{[\s\S]*?\n\s+: d;/);
    expect(body).toMatch(/evaluateToolCallPolicy/);
    expect(body).toMatch(/isAgentKilled/);
    expect(body).toMatch(/shouldDenyPmOperatorDb/);
    expect(body).toMatch(/resolved_tool_names: resolvedToolNames/);
  });

  it("(c) the OpenAI funnel uses a REAL onEvent (NOT the no-op the Claude funnel uses)", () => {
    const body = openAiBranchBody();
    expect(body).toMatch(/onEvent: onEventWithText/);
    expect(body).toMatch(/makeOnEventHandler\(\{/);
    expect(body).not.toMatch(/onEvent: \(\) => \{\}/);
  });

  it("(d) EngineToolSpec[] is derived from the SAME `resolved` set, dropping sandbox tools", () => {
    const body = openAiBranchBody();
    expect(body).toMatch(/const engineTools: EngineToolSpec\[\] = resolved/);
    expect(body).toMatch(
      /shouldDropSandboxToolFromOpenAi\(parts\.server_id, parts\.tool_name\)/,
    );
    expect(body).not.toMatch(/OPENAI_SANDBOX_TOOL_NAMES\.has\(parts\.tool_name\)/);
    expect(body).toMatch(/jsonSchema: t\.input_schema/);
  });

  it("(e) the OpenAI branch drives the engine through the shared mid-stream budget monitor", () => {
    const body = openAiBranchBody();
    expect(body).toMatch(/withBudgetMonitor\(openAiEngine\.run\(openAiSpec\)/);
    expect(body).toMatch(/shouldAbortForBudget/);
  });

  it("(f) the OpenAI branch applies the iter-top killedRef short-circuit (kill parity)", () => {
    const body = openAiBranchBody();
    expect(body).toMatch(/if \(killedRef\.value\)/);
    expect(body).toMatch(/const code = stopped \? "run_cancelled" : "kill_switch";/);
    expect(body).toMatch(/throw new Error\(code\)/);
  });
});

describe("generic-dispatcher anthropic engine branch (Phase 2 canary)", () => {
  it("computes the canary gate once before the branch (default OFF → inline)", () => {
    expect(DISP).toMatch(
      /anthropicEngineEnabled:\s*shouldUseAnthropicEngine\(ctx\.tenant_id\),/,
    );
    expect(DISP).toMatch(
      /const useAnthropicEngine =\s*isShadowRun \? false : liveFunnel!\.useAnthropicEngine;/,
    );
    expect(DISP).toMatch(
      /if \(providerForRun === "anthropic" && !useAnthropicEngine\) \{/,
    );
    expect(DISP).toMatch(/\} else if \(useAnthropicEngine\) \{/);
  });

  it("instantiates the engine via pickEngine(providerForRun) + drives engine.run(spec) through the budget monitor", () => {
    const body = anthropicEngineBranchBody();
    expect(body).toMatch(/const anthropicEngine = pickEngine\(providerForRun\)/);
    expect(body).toMatch(
      /withBudgetMonitor\(anthropicEngine\.run\(anthropicSpec\)/,
    );
    expect(body).toMatch(/shouldAbortForBudget/);
    expect(body).toMatch(/systemPrompt: sdkSystemPrompt,/);
    expect(body).toMatch(/model: ctx\.agent\.metadata_praxis\.model,/);
    expect(body).not.toMatch(/applyOpenAiAddendum/);
  });

  it("routes tools through the SAME makeDispatchTool funnel with a REAL onEvent", () => {
    const body = anthropicEngineBranchBody();
    expect(body).toMatch(
      /const anthropicEngineDispatchTool = makeDispatchTool\(\{/,
    );
    expect(body).toMatch(/dispatchTool: anthropicEngineDispatchTool/);
    expect(body).toMatch(/evaluateToolCallPolicy/);
    expect(body).toMatch(/isAgentKilled/);
    expect(body).toMatch(/shouldDenyPmOperatorDb/);
    expect(body).toMatch(/resolved_tool_names: resolvedToolNames/);
    expect(body).toMatch(/makeOnEventHandler\(\{/);
    expect(body).not.toMatch(/onEvent: \(\) => \{\}/);
  });

  it("consumes the rich Design-C events to reconstruct the inline side-effects", () => {
    const body = anthropicEngineBranchBody();
    expect(body).toMatch(/case "assistant_text"/);
    expect(body).toMatch(/maybeEmitPlan\(/);
    expect(body).toMatch(/parseCitations\(residualText\)/);
    expect(body).toMatch(/case "assistant_turn"/);
    expect(body).toMatch(/tool_name: "assistant_turn"/);
    expect(body).toMatch(/case "tool_use"/);
    expect(body).toMatch(/previewToolInput\(\s*String\(ev\.name/);
    expect(body).not.toMatch(/input_preview: ev\.input/);
    expect(body).toMatch(/case "tool_result"/);
    expect(body).toMatch(/pairToolResultToTrace\(toolCalls, ev\.tool_use_id\)/);
    expect(body).toMatch(/case "tool_start"/);
    expect(body).toMatch(/deriveToolTarget\(ev\.input\)/);
    expect(body).toMatch(/case "terminal"/);
    expect(body).toMatch(/sdkCostUsd = ev\.costUsd/);
    expect(body).toMatch(/if \(!midStreamAborted\)/);
    expect(body).toMatch(/capturedSdkSessionId = ev\.resume\.sessionId/);
    expect(body).toMatch(/sdkStructuredOutput = ev\.structuredOutput/);
  });

  it("applies the iter-top killedRef short-circuit (kill parity)", () => {
    const body = anthropicEngineBranchBody();
    expect(body).toMatch(/if \(killedRef\.value\)/);
    expect(body).toMatch(
      /const code = stopped \? "run_cancelled" : "kill_switch";/,
    );
    expect(body).toMatch(/throw new Error\(code\)/);
  });
});
