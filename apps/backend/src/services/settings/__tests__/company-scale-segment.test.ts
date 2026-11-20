
import { describe, it, expect } from "vitest";
import { APP_SETTINGS, CONSENT_KEYS_PER_TENANT_ONLY, isSettingKey } from "../registry";
import { coerceSettingValue } from "../index";

describe("company_scale_segment registry def (2026-05-31, slice U2-scale-step)", () => {
  const def = APP_SETTINGS.company_scale_segment;

  it("is registered as a known setting key", () => {
    expect(isSettingKey("company_scale_segment")).toBe(true);
  });

  it("is a per-tenant string", () => {
    expect(def.type).toBe("string");
    expect(def.scope).toBe("per-tenant");
  });

  it("DEFAULTS to '' (unset) -- fresh-build + un-segmented tenants get generic framing, never a mis-segment", () => {
    expect(def.defaultValue).toBe("");
  });

  it("coerces the four valid segments through unchanged (registry doesn't enum-validate; the activate route enum-checks)", () => {
    expect(coerceSettingValue(def, "pre_revenue")).toBe("pre_revenue");
    expect(coerceSettingValue(def, "early")).toBe("early");
    expect(coerceSettingValue(def, "scaling")).toBe("scaling");
    expect(coerceSettingValue(def, "mature")).toBe("mature");
  });

  it("rejects non-string raw values at the registry boundary", () => {
    expect(() => coerceSettingValue(def, 1)).toThrow(/expected string/);
    expect(() => coerceSettingValue(def, true)).toThrow(/expected string/);
    expect(() => coerceSettingValue(def, null)).toThrow(/expected string/);
  });

  it("is NOT a consent-class key (operator self-report, not a privacy/data-sharing grant)", () => {
    expect(CONSENT_KEYS_PER_TENANT_ONLY.has("company_scale_segment")).toBe(false);
  });

  it("description names the four segments + that it's has-product-only", () => {
    expect(def.description).toMatch(/pre_revenue/);
    expect(def.description).toMatch(/early/);
    expect(def.description).toMatch(/scaling/);
    expect(def.description).toMatch(/mature/);
    expect(def.description).toMatch(/has-product/);
  });
});
