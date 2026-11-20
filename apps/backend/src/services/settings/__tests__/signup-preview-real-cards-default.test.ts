
import { describe, it, expect } from "vitest";
import { APP_SETTINGS, isSettingKey } from "../registry";

describe("signup_preview_real_cards registry def", () => {
  const def = APP_SETTINGS.signup_preview_real_cards;

  it("is a known global boolean setting", () => {
    expect(isSettingKey("signup_preview_real_cards")).toBe(true);
    expect(def.type).toBe("boolean");
    expect(def.scope).toBe("global");
  });

  it("defaults to true: first-round cards ship with the emails that announce them", () => {
    expect(def.defaultValue).toBe(true);
  });
});
