
import { describe, it, expect } from "vitest";
import { APP_SETTINGS, CONSENT_KEYS_PER_TENANT_ONLY, isSettingKey } from "../registry";
import { coerceSettingValue } from "../index";

describe("memory_recall_floor registry def", () => {
  const def = APP_SETTINGS.memory_recall_floor;

  it("is a per-tenant number, 0..1, default 0 (ships effectively-off)", () => {
    expect(def.type).toBe("number");
    expect(def.scope).toBe("per-tenant");
    expect(def.defaultValue).toBe(0);
    expect(def.min).toBe(0);
    expect(def.max).toBe(1);
  });

  it("coerces a valid in-range float", () => {
    expect(coerceSettingValue(def, "0.35")).toBe(0.35);
    expect(coerceSettingValue(def, 0.5)).toBe(0.5);
  });

  it("rejects out-of-bounds values (so a fat-finger can't starve recall)", () => {
    expect(() => coerceSettingValue(def, 1.5)).toThrow(/<= 1/);
    expect(() => coerceSettingValue(def, -0.1)).toThrow(/>= 0/);
  });

  it("rejects non-numeric", () => {
    expect(() => coerceSettingValue(def, "high")).toThrow(/expected number/);
  });
});

describe("memory_index_kind registry def", () => {
  const def = APP_SETTINGS.memory_index_kind;

  it("is a per-tenant string defaulting to 'none' (exact scan at merge)", () => {
    expect(def.type).toBe("string");
    expect(def.scope).toBe("per-tenant");
    expect(def.defaultValue).toBe("none");
  });

  it("coerces string values through", () => {
    expect(coerceSettingValue(def, "hnsw")).toBe("hnsw");
  });
});

describe("registry key recognition", () => {
  it("both new keys are recognized", () => {
    expect(isSettingKey("memory_recall_floor")).toBe(true);
    expect(isSettingKey("memory_index_kind")).toBe(true);
  });
});

describe("GAP #4 step 3+4 flags — default-ON fleet-wide 2026-06-30, consent preserved", () => {
  for (const key of ["memory_skill_distill_enabled", "memory_heartbeat_enabled"] as const) {
    const def = APP_SETTINGS[key];

    it(`${key} is a per-tenant boolean defaulting to true`, () => {
      expect(def.type).toBe("boolean");
      expect(def.scope).toBe("per-tenant");
      expect(def.defaultValue).toBe(true);
    });

    it(`${key} stays in CONSENT_KEYS_PER_TENANT_ONLY (consent isolation preserved)`, () => {
      expect(CONSENT_KEYS_PER_TENANT_ONLY.has(key)).toBe(true);
    });
  }
});
