import { describe, it, expect } from "vitest";
import { APP_SETTINGS } from "../registry";
import { PRICING } from "@/services/anthropic";

describe("llm_role_model_overrides default", () => {
  const def = APP_SETTINGS.llm_role_model_overrides;
  const overrides = def.defaultValue as Record<string, string>;

  it("is a per-tenant json setting", () => {
    expect(def.type).toBe("json");
    expect(def.scope).toBe("per-tenant");
  });

  it("routes synthMarkdown to Haiku by default", () => {
    expect(overrides.synthMarkdown).toBe("claude-haiku-4-5-20251001");
  });

  it("every default override value is a real PRICING key (own-key, not prototype)", () => {
    for (const model of Object.values(overrides)) {
      expect(Object.prototype.hasOwnProperty.call(PRICING, model)).toBe(true);
    }
  });
});
