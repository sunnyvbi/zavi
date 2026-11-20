
import { describe, it, expect } from "vitest";
import { APP_SETTINGS, isSettingKey } from "../registry";

describe("competitor_intel_weekly_enabled registry def (default restored ON 2026-06-21)", () => {
  const def = APP_SETTINGS.competitor_intel_weekly_enabled;

  it("is registered as a known per-tenant boolean", () => {
    expect(isSettingKey("competitor_intel_weekly_enabled")).toBe(true);
    expect(def.type).toBe("boolean");
    expect(def.scope).toBe("per-tenant");
  });

  it("DEFAULTS to true — proactive analyst on by default (gated by autopilot + quiet-week suppression)", () => {
    expect(def.defaultValue).toBe(true);
  });

  it("description reflects the default-ON, quiet-week-suppressed posture", () => {
    expect(def.description).toMatch(/ON \(default\)/);
    expect(def.description).not.toMatch(/autopilot_enabled/);
    expect(def.description).toMatch(/material change/i);
  });
});
