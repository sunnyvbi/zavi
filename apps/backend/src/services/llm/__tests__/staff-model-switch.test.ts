import { describe, it, expect } from "vitest";
import { resolveStaffModel, STAFF_MODEL_NAMES, isClaudeKey } from "../staff-model-switch";
import { MODEL_MANIFEST } from "@/services/eval/model-bench/manifest";

describe("staff-model-switch", () => {
  it("lists exactly the 16 confirmed names", () => {
    expect(STAFF_MODEL_NAMES).toEqual([
      "claude", "sonnet", "sonnet-high", "sonnet-xhigh", "opus", "opus-high", "opus-xhigh",
      "openai", "gpt-6-sol", "gpt-5.6-luna", "gemini",
      "mistral", "deepseek", "qwen", "kimi", "glm",
    ]);
  });
  it("maps Claude variants to the Claude path with fixed effort", () => {
    expect(resolveStaffModel("opus")).toEqual({ kind: "claude", key: "opus", model_id: "claude-opus-5-5", effort: "medium", label: "Opus (medium)" });
    expect(resolveStaffModel("sonnet-xhigh")).toMatchObject({ kind: "claude", model_id: "claude-sonnet-5-5", effort: "xhigh" });
  });
  it("maps short names to the pinned bench entries", () => {
    expect(resolveStaffModel("openai")).toEqual({ kind: "openrouter", key: "openai", model_id: "openai/gpt-5.5", upstream: "OpenAI", label: "GPT-5.5" });
    expect(resolveStaffModel("gemini")?.model_id).toBe("google/gemini-3.1-pro-preview");
    expect(resolveStaffModel("qwen")).toMatchObject({ model_id: "qwen/qwen3.8-27b", upstream: "DeepInfra" });
    expect(MODEL_MANIFEST.get("qwen")?.upstream).toBe("Darkbloom");
    expect(resolveStaffModel("glm")).toMatchObject({ model_id: "z-ai/glm-5.3", upstream: "DeepInfra" });
  });
  it("is case-insensitive and trims", () => {
    expect(resolveStaffModel("  QWEN ")?.key).toBe("qwen");
  });
  it("returns null for unknown names and for claude (no switch)", () => {
    expect(resolveStaffModel("llama")).toBeNull();
    expect(resolveStaffModel("")).toBeNull();
    expect(resolveStaffModel("claude")).toBeNull();
    expect(isClaudeKey("Claude")).toBe(true);
  });
  it("guard: every openrouter name resolves to a pinned shared_loop manifest entry with retention", () => {
    const orNames = STAFF_MODEL_NAMES.filter((n) => n !== "claude" && resolveStaffModel(n)?.kind !== "claude");
    expect(orNames.length).toBe(9);
    for (const n of orNames) {
      const m = resolveStaffModel(n);
      expect(m, n).not.toBeNull();
      if (m?.kind !== "openrouter") throw new Error(`${n} not openrouter`);
      const entry = [...MODEL_MANIFEST.values()].find((e) => e.model_id === m.model_id);
      expect(entry, n).toBeDefined();
      expect(entry!.route).toBe("shared_loop");
      expect(m.upstream).toBeTruthy();
      expect(entry!.upstream).toBeTruthy();
      expect(entry!.retention.trim().length).toBeGreaterThan(0);
    }
  });
});
