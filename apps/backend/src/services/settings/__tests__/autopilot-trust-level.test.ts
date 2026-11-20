
import { describe, it, expect } from "vitest";
import { APP_SETTINGS, CONSENT_KEYS_PER_TENANT_ONLY, isSettingKey } from "../registry";

describe("autopilot_trust_level registry def (S5 trust ladder)", () => {
  const def = APP_SETTINGS.autopilot_trust_level;

  it("is registered as a known setting key", () => {
    expect(isSettingKey("autopilot_trust_level")).toBe(true);
  });

  it("is a per-tenant string with the L0/L1 closed option set (L2/L3 reserved — NOT listed)", () => {
    expect(def.type).toBe("string");
    expect(def.scope).toBe("per-tenant");
    expect(def.options).toEqual(["L0", "L1"]);
  });

  it("DEFAULTS to 'L0' — autonomy-sensitive load-bearing default", () => {
    expect(def.defaultValue).toBe("L0");
  });

  it("is a consent-class key — per-tenant only, no global fallback on read or write", () => {
    expect(CONSENT_KEYS_PER_TENANT_ONLY.has("autopilot_trust_level")).toBe(true);
  });
});
