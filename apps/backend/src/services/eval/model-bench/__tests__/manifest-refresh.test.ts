import { describe, expect, it } from "vitest";
import {
  AGENT_DECLARED,
  CLAUDE_SHARED_LOOP_KEY,
  MODEL_MANIFEST,
  anthropicToOpenRouterSlug,
  pickJudges,
  resolveModel,
  resolveSharedLoopModelId,
} from "../manifest";

describe("manifest refresh", () => {
  it("maps Anthropic ids to OpenRouter slugs", () => {
    expect(anthropicToOpenRouterSlug("claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4.6");
    expect(anthropicToOpenRouterSlug("claude-opus-4-7")).toBe("anthropic/claude-opus-4.7");
    expect(anthropicToOpenRouterSlug("claude-haiku-4-5-20251001")).toBe("anthropic/claude-haiku-4.5");
    expect(() => anthropicToOpenRouterSlug("gpt-5.5")).toThrow();
  });

  it("the shared Claude row follows the agent's own Claude model", () => {
    const shared = resolveModel(CLAUDE_SHARED_LOOP_KEY);
    expect(shared.model_id).toBe(AGENT_DECLARED);
    expect(shared.upstream).toBe("Anthropic");
    expect(resolveSharedLoopModelId(AGENT_DECLARED, "claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4.6");
    expect(resolveSharedLoopModelId("openai/gpt-5.5", "claude-sonnet-4-6")).toBe("openai/gpt-5.5");
  });

  it("every shared-loop entry is pinned to an upstream", () => {
    for (const e of MODEL_MANIFEST.values()) {
      if (e.route === "shared_loop") expect(e.upstream, e.key).toBeTruthy();
    }
  });

  it("a GPT-5.5 run gets two judges from families outside the comparison", () => {
    const j = pickJudges(["openai", "anthropic"]);
    expect(j.status).toBe("ok");
    if (j.status === "ok") {
      const fams = j.judges.map((x) => x.family);
      expect(fams).not.toContain("openai");
      expect(fams).not.toContain("anthropic");
      expect(new Set(fams).size).toBe(2);
    }
  });
});

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FLEET_CLAUDE_MODELS, probeModelIds } from "../manifest";

describe("agent-declared Claude row: self-test + drift guard", () => {
  it("probes every fleet Claude model, never the sentinel", () => {
    const ids = probeModelIds(resolveModel(CLAUDE_SHARED_LOOP_KEY));
    expect(ids).not.toContain(AGENT_DECLARED);
    expect(ids).toEqual(FLEET_CLAUDE_MODELS.map(anthropicToOpenRouterSlug));
    expect(probeModelIds(resolveModel("gpt-5.5"))).toEqual(["openai/gpt-5.5"]);
  });

  it("FLEET_CLAUDE_MODELS covers every Claude id an agent.md declares", () => {
    const dir = join(__dirname, "../../../../agents");
    const declared = new Set<string>();
    for (const slug of readdirSync(dir)) {
      const f = join(dir, slug, "agent.md");
      if (!existsSync(f)) continue;
      for (const m of readFileSync(f, "utf8").match(/claude-(?:opus|sonnet|haiku)-[0-9][0-9a-z-]*/g) ?? []) declared.add(m);
    }
    expect(declared.size).toBeGreaterThan(0);
    for (const id of declared) expect(FLEET_CLAUDE_MODELS, id).toContain(id);
  });
});

describe("bench runs ignore engine variants", () => {
  it("runGenericOnce resolves DEFAULT_VARIANT for a bench ctx", () => {
    const src = readFileSync(join(__dirname, "../../../agents/generic-dispatcher.ts"), "utf8");
    expect(src).toMatch(/isBench\s*\?\s*Promise\.resolve\(DEFAULT_VARIANT\)\s*:\s*labVariantOverride\(ctx\)[\s\S]*?:\s*\(async \(\) => resolveRunVariant\(/);
    expect(src.indexOf("const isBench = ")).toBeLessThan(src.indexOf("Promise.resolve(DEFAULT_VARIANT)"));
  });
});

import { isReusableCache } from "../bench";

describe("agent-declared rows: cache follows the agent's concrete model", () => {
  const model = resolveModel(CLAUDE_SHARED_LOOP_KEY);
  const fixture = { task_id: "t1", fixture_version: 1 } as never;
  const rows = [1, 2, 3].map((trial) => ({
    task_id: "t1", trial, outcome: "completed", harness_sha: "h", model_id: "claude-sonnet-4-6",
    upstream: "Anthropic", fixture_version: 1,
  })) as never;
  const want = { trials: 3, harness_sha: "h", model, fixture };

  it("reuses only when the agent still resolves to the model the rows ran", () => {
    expect(isReusableCache(rows, { ...want, concrete_model_id: "claude-sonnet-4-6" })).toBe(true);
    expect(isReusableCache(rows, { ...want, concrete_model_id: "claude-haiku-4-5-20251001" })).toBe(false);
  });

  it("never reuses when the concrete model is unknown", () => {
    expect(isReusableCache(rows, { ...want, concrete_model_id: null })).toBe(false);
    expect(isReusableCache(rows, want)).toBe(false);
  });

  it("probes Haiku too (a tenant fork may select it)", () => {
    expect(probeModelIds(model)).toContain("anthropic/claude-haiku-4.5");
  });
});
