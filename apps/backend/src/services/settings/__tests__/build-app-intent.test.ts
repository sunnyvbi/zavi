
import { describe, it, expect } from "vitest";
import { APP_SETTINGS, CONSENT_KEYS_PER_TENANT_ONLY, isSettingKey } from "../registry";
import { coerceSettingValue } from "../index";

describe("build_app_intent registry def (2026-05-30)", () => {
  const def = APP_SETTINGS.build_app_intent;

  it("is registered as a known setting key", () => {
    expect(isSettingKey("build_app_intent")).toBe(true);
  });

  it("is a per-tenant string", () => {
    expect(def.type).toBe("string");
    expect(def.scope).toBe("per-tenant");
  });

  it("DEFAULTS to 'existing' — load-bearing safe default so every pre-existing tenant auto-hides the BuildAppCard with zero migration", () => {
    expect(def.defaultValue).toBe("existing");
  });

  it("coerces a string through unchanged (registry doesn't enum-validate; the activate route + autopilot response coerce 'fresh' | 'existing')", () => {
    expect(coerceSettingValue(def, "fresh")).toBe("fresh");
    expect(coerceSettingValue(def, "existing")).toBe("existing");
  });

  it("rejects non-string raw values at the registry boundary", () => {
    expect(() => coerceSettingValue(def, 1)).toThrow(/expected string/);
    expect(() => coerceSettingValue(def, true)).toThrow(/expected string/);
    expect(() => coerceSettingValue(def, null)).toThrow(/expected string/);
  });

  it("is NOT a consent-class key (operator opt-in, not a privacy/data-sharing grant) — staff global writes are allowed", () => {
    expect(CONSENT_KEYS_PER_TENANT_ONLY.has("build_app_intent")).toBe(false);
  });

  it("description names both modes + the BuildAppCard gate (helps the staff settings UI explain it)", () => {
    expect(def.description).toMatch(/fresh/);
    expect(def.description).toMatch(/existing/);
    expect(def.description).toMatch(/BuildAppCard/);
  });
});
