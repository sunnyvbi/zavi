import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { alertSpy } = vi.hoisted(() => ({ alertSpy: vi.fn(async () => {}) }));
vi.mock("@/services/logging/alert", () => ({ alert: alertSpy }));

import { estimateCostUsd } from "@/services/anthropic";
import {
  engineerCostV2FromValues,
  loadEngineerCostV2Config,
  agentDefaultEffort,
  sdkOptionsForModel,
  sdkRunModelFor,
} from "@/services/agents/engineer-cost-v2";
import {
  modelRefusalError,
  nextRefusalState,
  parseModelRefusal,
} from "@/services/agents/sdk-refusal";
import { synthesizeErrorBody } from "@/services/agents/error-body";
import { APP_SETTINGS } from "@/services/settings/registry";

const M = 1_000_000;

describe("estimateCostUsd: engineer cost v2 models", () => {
  it("prices Opus 5.5 at $4 in / $20 out, cache write $5, cache read $0.20", () => {
    expect(estimateCostUsd("claude-opus-5-5", { input_tokens: M, output_tokens: 0 }, { onUnpriced: "throw" })).toBe(4);
    expect(estimateCostUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: M }, { onUnpriced: "throw" })).toBe(20);
    expect(
      estimateCostUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: M }),
    ).toBe(5);
    expect(
      estimateCostUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: M }),
    ).toBe(0.2);
  });

  it("prices Sonnet 5 at $2 in / $10 out, cache write $2.50, cache read $0.20", () => {
    expect(estimateCostUsd("claude-sonnet-5", { input_tokens: M, output_tokens: M }, { onUnpriced: "throw" })).toBe(12);
    expect(
      estimateCostUsd("claude-sonnet-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: M,
        cache_read_input_tokens: M,
      }),
    ).toBe(2.7);
  });

  it("the probe's measured Opus 5.5 call reprices to the SDK's own figure", () => {
    const est = estimateCostUsd("claude-opus-5-5", {
      input_tokens: 6,
      output_tokens: 164,
      cache_read_input_tokens: 156413,
      cache_creation_input_tokens: 78427,
    });
    expect(Math.abs(est - 0.426722) / 0.426722).toBeLessThan(0.02);
  });

  it("prices 1h cache writes at 2x input when the API reports the split", () => {
    const oneHourOnly = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: M,
      cache_creation: { ephemeral_1h_input_tokens: M, ephemeral_5m_input_tokens: 0 },
    };
    expect(estimateCostUsd("claude-opus-5-5", oneHourOnly)).toBe(8);
    expect(estimateCostUsd("claude-sonnet-5", oneHourOnly)).toBe(4);
    expect(estimateCostUsd("claude-opus-4-7", oneHourOnly)).toBe(10);
  });

  it("prices a mixed 1h / 5m split bucket by bucket", () => {
    const mixed = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: M,
      cache_creation: { ephemeral_1h_input_tokens: M / 2, ephemeral_5m_input_tokens: M / 2 },
    };
    expect(estimateCostUsd("claude-opus-5-5", mixed)).toBe(6.5);
    expect(estimateCostUsd("claude-opus-4-7", mixed)).toBe(8.125);
  });

  it("with no split (absent or null), every write is priced at the 5m rate as before", () => {
    const flat = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: M };
    expect(estimateCostUsd("claude-opus-5-5", flat)).toBe(5);
    expect(estimateCostUsd("claude-opus-5-5", { ...flat, cache_creation: null })).toBe(5);
    expect(estimateCostUsd("claude-opus-4-7", flat)).toBe(6.25);
  });

  it("keeps the three older models on the 1.25x / 0.1x multipliers (unchanged)", () => {
    const u = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: M, cache_read_input_tokens: M };
    expect(estimateCostUsd("claude-opus-4-7", u)).toBe(6.75);
    expect(estimateCostUsd("claude-sonnet-4-6", u)).toBe(4.05);
    expect(estimateCostUsd("claude-haiku-4-5-20251001", u)).toBe(1.35);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe("engineer_cost_v2 config (app settings)", () => {
  it("unset => ON with effort high", () => {
    expect(engineerCostV2FromValues(undefined, undefined)).toEqual({ enabled: true, deepEffort: "high" });
  });
  it("explicit false turns it off; any other value keeps it on", () => {
    expect(engineerCostV2FromValues(false, undefined).enabled).toBe(false);
    expect(engineerCostV2FromValues("false", undefined).enabled).toBe(false);
    expect(engineerCostV2FromValues(true, undefined).enabled).toBe(true);
    expect(engineerCostV2FromValues(0, undefined).enabled).toBe(true);
  });
  it("engineer_deep_effort accepts only the SDK levels", () => {
    expect(engineerCostV2FromValues(true, "medium").deepEffort).toBe("medium");
    expect(engineerCostV2FromValues(true, "xhigh").deepEffort).toBe("xhigh");
    expect(engineerCostV2FromValues(true, "ultra").deepEffort).toBe("high");
    expect(engineerCostV2FromValues(true, 3).deepEffort).toBe("high");
  });
  it("reads both keys through the injected getter", async () => {
    const vals: Record<string, unknown> = { engineer_cost_v2: false, engineer_deep_effort: "max" };
    expect(await loadEngineerCostV2Config(async (k) => vals[k])).toEqual({ enabled: false, deepEffort: "max" });
  });
  it("a read error falls back to the defaults", async () => {
    const boom = async () => {
      throw new Error("boom");
    };
    expect(await loadEngineerCostV2Config(boom)).toEqual({ enabled: true, deepEffort: "high" });
  });
  it("both knobs are registered as global app settings with the right defaults", () => {
    expect(APP_SETTINGS.engineer_cost_v2).toMatchObject({ type: "boolean", scope: "global", defaultValue: true });
    expect(APP_SETTINGS.engineer_deep_effort).toMatchObject({
      type: "string",
      scope: "global",
      defaultValue: "high",
      options: ["low", "medium", "high", "xhigh", "max"],
    });
  });
});

describe("sdkOptionsForModel", () => {
  const on = { enabled: true, deepEffort: "medium" as const };
  it("adds the configured effort for engineer on Opus 5.5", () => {
    const r = sdkOptionsForModel({ agentSlug: "engineer", model: "claude-opus-5-5", variantOptions: {}, costV2: on });
    expect(r.options).toEqual({ effort: "medium" });
  });
  it("every other Opus 5.5 run gets high effort (the model defaults to medium); other models get none", () => {
    const off = { enabled: false, deepEffort: "max" as const };
    expect(sdkOptionsForModel({ agentSlug: "engineer", model: "claude-opus-5-5", variantOptions: {}, costV2: off }).options).toEqual({ effort: "high" });
    expect(sdkOptionsForModel({ agentSlug: "operator", model: "claude-opus-5-5", variantOptions: {}, costV2: null }).options).toEqual({ effort: "high" });
    expect(sdkOptionsForModel({ agentSlug: "engineer", model: "claude-sonnet-5-5", variantOptions: {}, costV2: on }).options).toEqual({});
  });
  it("a variant's own effort wins", () => {
    const r = sdkOptionsForModel({ agentSlug: "engineer", model: "claude-opus-5-5", variantOptions: { effort: "low" }, costV2: on });
    expect(r.options.effort).toBe("low");
  });
  it("operator runs at xhigh on Sonnet 5.5 by default; a variant effort still wins; Opus keeps high", () => {
    expect(sdkOptionsForModel({ agentSlug: "operator", model: "claude-sonnet-5-5", variantOptions: {}, costV2: null }).options).toEqual({ effort: "xhigh" });
    expect(sdkOptionsForModel({ agentSlug: "operator", model: "claude-sonnet-5-5", variantOptions: { effort: "low" }, costV2: null }).options).toEqual({ effort: "low" });
    expect(sdkOptionsForModel({ agentSlug: "operator", model: "claude-opus-5-5", variantOptions: {}, costV2: null }).options).toEqual({ effort: "high" });
  });
  it("no other agent gets a default effort on Sonnet (unchanged)", () => {
    for (const slug of ["pm", "engineer", "cgo", "support-lead", "research", "meta_ads"]) {
      expect(sdkOptionsForModel({ agentSlug: slug, model: "claude-sonnet-5-5", variantOptions: {}, costV2: null }).options).toEqual({});
      expect(agentDefaultEffort(slug, "claude-sonnet-5-5")).toBeUndefined();
    }
    expect(agentDefaultEffort("operator", "claude-sonnet-5-5")).toBe("xhigh");
    expect(agentDefaultEffort("operator", "claude-opus-5-5")).toBeUndefined();
    expect(agentDefaultEffort("operator", "claude-haiku-4-5-20251001")).toBeUndefined();
  });

  it("cgo runs at xhigh on Opus 5.5 (both run paths read this); a variant effort still wins; other models keep their default", () => {
    expect(agentDefaultEffort("cgo", "claude-opus-5-5")).toBe("xhigh");
    expect(sdkOptionsForModel({ agentSlug: "cgo", model: "claude-opus-5-5", variantOptions: {}, costV2: null }).options).toEqual({ effort: "xhigh" });
    expect(sdkOptionsForModel({ agentSlug: "cgo", model: "claude-opus-5-5", variantOptions: { effort: "low" }, costV2: null }).options).toEqual({ effort: "low" });
    expect(agentDefaultEffort("cgo", "claude-sonnet-5-5")).toBeUndefined();
    expect(sdkOptionsForModel({ agentSlug: "cgo", model: "claude-sonnet-5-5", variantOptions: {}, costV2: null }).options).toEqual({});
    expect(sdkOptionsForModel({ agentSlug: "pm", model: "claude-opus-5-5", variantOptions: {}, costV2: null }).options).toEqual({ effort: "high" });
  });
  it("strips thinking disabled / enabled on Opus 5.5 and reports it; keeps adaptive", () => {
    for (const t of [{ type: "disabled" }, { type: "enabled", budgetTokens: 4000 }]) {
      const r = sdkOptionsForModel({ agentSlug: "pm", model: "claude-opus-5-5", variantOptions: { thinking: t }, costV2: null });
      expect(r.options.thinking).toBeUndefined();
      expect(r.strippedThinking).toBe(t.type);
    }
    const a = sdkOptionsForModel({ agentSlug: "pm", model: "claude-opus-5-5", variantOptions: { thinking: { type: "adaptive" } }, costV2: null });
    expect(a.options.thinking).toEqual({ type: "adaptive" });
    expect(a.strippedThinking).toBeNull();
  });
  it("strips thinking disabled / enabled on Sonnet 5.5 too; keeps adaptive", () => {
    for (const t of [{ type: "disabled" }, { type: "enabled", budgetTokens: 4000 }]) {
      const r = sdkOptionsForModel({ agentSlug: "engineer", model: "claude-sonnet-5-5", variantOptions: { thinking: t }, costV2: null });
      expect(r.options.thinking).toBeUndefined();
      expect(r.strippedThinking).toBe(t.type);
    }
    const a = sdkOptionsForModel({ agentSlug: "engineer", model: "claude-sonnet-5-5", variantOptions: { thinking: { type: "adaptive" } }, costV2: null });
    expect(a.options.thinking).toEqual({ type: "adaptive" });
  });
  it("strips only thinking enabled on a thread still sticky on Sonnet 5", () => {
    const e = sdkOptionsForModel({ agentSlug: "engineer", model: "claude-sonnet-5", variantOptions: { thinking: { type: "enabled", budgetTokens: 4000 } }, costV2: null });
    expect(e.options.thinking).toBeUndefined();
    expect(e.strippedThinking).toBe("enabled");
    const d = sdkOptionsForModel({ agentSlug: "engineer", model: "claude-sonnet-5", variantOptions: { thinking: { type: "disabled" } }, costV2: null });
    expect(d.options.thinking).toEqual({ type: "disabled" });
  });
  it("leaves thinking alone on older models", () => {
    const r = sdkOptionsForModel({ agentSlug: "pm", model: "claude-opus-4-7", variantOptions: { thinking: { type: "disabled" } }, costV2: null });
    expect(r.options.thinking).toEqual({ type: "disabled" });
  });
});

describe("sdkRunModelFor (query model and budget-gate pricing model)", () => {
  it("a variant model wins over the agent model; otherwise the agent model", () => {
    expect(sdkRunModelFor("claude-sonnet-5", "claude-opus-5-5")).toBe("claude-sonnet-5");
    expect(sdkRunModelFor(undefined, "claude-opus-5-5")).toBe("claude-opus-5-5");
  });
  it("the inline mid-run budget gate prices turns with the SDK run model", () => {
    const src = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf-8");
    expect(src).toMatch(/midStreamAccruedUsd \+= estimateCostUsd\(sdkRunModel, turnUsage\)/);
    expect(src).toMatch(/const sdkRunModel = sdkRunModelFor\(variant\.config\.model,/);
  });
});

describe("model refusal fails loud", () => {
  it("an assistant frame with stop_reason refusal records the category", () => {
    const s = nextRefusalState(null, {
      type: "assistant",
      message: { stop_reason: "refusal", stop_details: { category: "cyber" } },
    });
    expect(s).toEqual({ category: "cyber" });
  });
  it("a result refusal keeps an earlier category; a fallback retry clears it", () => {
    let s = nextRefusalState(null, { type: "system", subtype: "model_refusal_no_fallback", api_refusal_category: "bio" });
    s = nextRefusalState(s, { type: "result", subtype: "success", stop_reason: "refusal" });
    expect(s).toEqual({ category: "bio" });
    expect(nextRefusalState(s, { type: "system", subtype: "model_refusal_fallback" })).toBeNull();
  });
  it("only a session-scope (or unscoped) fallback clears a refusal; a local one does not", () => {
    const refused = { category: "cyber" };
    expect(nextRefusalState(refused, { type: "system", subtype: "model_refusal_fallback", scope: "local" })).toEqual(refused);
    expect(nextRefusalState(refused, { type: "system", subtype: "model_refusal_fallback", scope: "session" })).toBeNull();
    expect(nextRefusalState(refused, { type: "system", subtype: "model_refusal_fallback" })).toBeNull();
  });
  it("ordinary messages change nothing", () => {
    expect(nextRefusalState(null, { type: "result", subtype: "success", stop_reason: "end_turn" })).toBeNull();
    expect(nextRefusalState(null, { type: "assistant", message: { stop_reason: null } })).toBeNull();
  });
  it("the thrown error renders as a clear user-visible line, never the generic hiccup", () => {
    const err = modelRefusalError({ category: "cyber" });
    expect(err.message).toBe("model_refusal: The model declined this request (cyber).");
    const body = synthesizeErrorBody(`dispatch_inner: ${err.message}\n    at foo (x.ts:1)`, "engineer");
    expect(body.markdown).toBe("The model declined this request (cyber).");
    expect(body.action_link).toBeNull();
    expect(parseModelRefusal(modelRefusalError({ category: null }).message)).toBe(
      "The model declined this request (policy).",
    );
  });
});
