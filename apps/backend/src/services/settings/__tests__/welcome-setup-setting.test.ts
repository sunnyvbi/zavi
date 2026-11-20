import { describe, it, expect } from "vitest";
import { APP_SETTINGS } from "../registry";

describe("welcome_setup_enabled", () => {
  it("is a per-tenant boolean that ships ON (default-ON rule, kill switch)", () => {
    const def = APP_SETTINGS.welcome_setup_enabled;
    expect(def.type).toBe("boolean");
    expect(def.scope).toBe("per-tenant");
    expect(def.defaultValue).toBe(true);
  });
});
