
import { describe, it, expect } from "vitest";
import { APP_SETTINGS, isSettingKey } from "../registry";

describe("mobile_signup_enabled registry def", () => {
  const def = APP_SETTINGS.mobile_signup_enabled;

  it("is registered as a known boolean setting", () => {
    expect(isSettingKey("mobile_signup_enabled")).toBe(true);
    expect(def.type).toBe("boolean");
  });

  it("is GLOBAL — the pre-auth read has no tenant to scope by", () => {
    expect(def.scope).toBe("global");
  });

  it("DEFAULTS to true — shipping the key must not disable signup", () => {
    expect(def.defaultValue).toBe(true);
  });

  it("description states it is a client-side gate, not a security control", () => {
    expect(def.description).toMatch(/isSignupEnabled/);
    expect(def.description).toMatch(/not a security control/i);
  });
});
