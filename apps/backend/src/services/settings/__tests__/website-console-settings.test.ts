
import { describe, it, expect } from "vitest";
import { APP_SETTINGS, isSettingKey, CONSENT_KEYS_PER_TENANT_ONLY } from "../registry";
import { coerceSettingValue } from "../index";

describe("website console settings registry defs", () => {
  it("stores manually edited app-card details per tenant", () => {
    expect(isSettingKey("website_app_details")).toBe(true);
    const def = APP_SETTINGS.website_app_details;
    expect(def.type).toBe("json");
    expect(def.scope).toBe("per-tenant");
    expect(def.defaultValue).toEqual({ name: null, description: null });
  });

  it("website_app_visibility is a per-tenant string with a public/private/unlisted option set defaulting to public", () => {
    expect(isSettingKey("website_app_visibility")).toBe(true);
    const def = APP_SETTINGS.website_app_visibility;
    expect(def.type).toBe("string");
    expect(def.scope).toBe("per-tenant");
    expect(def.defaultValue).toBe("public");
    expect(def.options).toEqual(["public", "private", "unlisted"]);
  });

  it("website_platform_badge_hidden is a per-tenant boolean defaulting to false (badge shown)", () => {
    expect(isSettingKey("website_platform_badge_hidden")).toBe(true);
    const def = APP_SETTINGS.website_platform_badge_hidden;
    expect(def.type).toBe("boolean");
    expect(def.scope).toBe("per-tenant");
    expect(def.defaultValue).toBe(false);
  });

  it("neither key is a consent-class key (they grant no cross-tenant authority)", () => {
    expect(CONSENT_KEYS_PER_TENANT_ONLY.has("website_app_visibility")).toBe(false);
    expect(CONSENT_KEYS_PER_TENANT_ONLY.has("website_platform_badge_hidden")).toBe(false);
    expect(CONSENT_KEYS_PER_TENANT_ONLY.has("website_app_details")).toBe(false);
  });

  it("coerces the badge boolean from string form (route may forward query/body strings)", () => {
    const def = APP_SETTINGS.website_platform_badge_hidden;
    expect(coerceSettingValue(def, "true")).toBe(true);
    expect(coerceSettingValue(def, false)).toBe(false);
  });
});
