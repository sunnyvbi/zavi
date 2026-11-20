import { describe, it, expect } from "vitest";
import { readStaffModelOverride } from "../staff-model-override";

describe("readStaffModelOverride", () => {
  it("re-derives model + upstream from the key; ignores anything else in payload", () => {
    expect(readStaffModelOverride({ staff_model: { key: "qwen", model_id: "evil/x", upstream: "Evil" } }))
      .toEqual({ kind: "openrouter", key: "qwen", model_id: "qwen/qwen3.8-27b", upstream: "DeepInfra", label: "Qwen3.8 27B" });
  });
  it("returns the Claude variant for opus-high", () => {
    expect(readStaffModelOverride({ staff_model: { key: "opus-high" } })).toMatchObject({ kind: "claude", model_id: "claude-opus-5-5", effort: "high" });
  });
  it("null for missing / unknown / claude / non-object payload", () => {
    expect(readStaffModelOverride(undefined)).toBeNull();
    expect(readStaffModelOverride({})).toBeNull();
    expect(readStaffModelOverride({ staff_model: { key: "llama" } })).toBeNull();
    expect(readStaffModelOverride({ staff_model: { key: "claude" } })).toBeNull();
    expect(readStaffModelOverride("x")).toBeNull();
  });
});
