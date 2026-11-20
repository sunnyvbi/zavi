import { describe, it, expect } from "vitest";
import { validateBuiltinLabel } from "../builtin-url";

describe("validateBuiltinLabel", () => {
  it("accepts a normal label", () => {
    expect(validateBuiltinLabel("design-marketplace")).toEqual({ ok: true, label: "design-marketplace" });
  });

  it("lowercases + trims", () => {
    expect(validateBuiltinLabel("  My-App2  ")).toEqual({ ok: true, label: "my-app2" });
  });

  it("rejects illegal characters, spaces, dots", () => {
    expect(validateBuiltinLabel("my app").ok).toBe(false);
    expect(validateBuiltinLabel("my_app").ok).toBe(false);
    expect(validateBuiltinLabel("my.app").ok).toBe(false);
    expect(validateBuiltinLabel("app!").ok).toBe(false);
  });

  it("rejects leading/trailing/double hyphens", () => {
    expect(validateBuiltinLabel("-app").ok).toBe(false);
    expect(validateBuiltinLabel("app-").ok).toBe(false);
    expect(validateBuiltinLabel("a--b").ok).toBe(false);
  });

  it("rejects too short / too long / empty", () => {
    expect(validateBuiltinLabel("ab").ok).toBe(false);
    expect(validateBuiltinLabel("a".repeat(64)).ok).toBe(false);
    expect(validateBuiltinLabel("").ok).toBe(false);
    expect(validateBuiltinLabel(123 as unknown).ok).toBe(false);
  });

  it("rejects reserved platform labels", () => {
    for (const r of ["www", "api", "app", "admin", "mail", "login", "billing", "zavi"]) {
      expect(validateBuiltinLabel(r).ok).toBe(false);
    }
  });
});

import { defaultBuiltinLabel, suffixedBuiltinLabel, slugifyBuiltinLabel } from "../builtin-url";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";

describe("defaultBuiltinLabel — the address Publish hands out without asking", () => {
  it("uses a clean tenant slug as-is", () => {
    expect(defaultBuiltinLabel("upcar-ai", TENANT)).toBe("upcar-ai");
  });

  it("slugifies a display name with spaces, punctuation and accents", () => {
    expect(defaultBuiltinLabel("  Café Élan & Sons!! ", TENANT)).toBe("cafe-elan-sons");
  });

  it("never hands out a reserved label: it gets the tenant suffix instead", () => {
    expect(defaultBuiltinLabel("app", TENANT)).toBe("app-73db45");
    expect(defaultBuiltinLabel("login", TENANT)).toBe("login-73db45");
  });

  it("pads a too-short or empty source with the tenant suffix", () => {
    expect(defaultBuiltinLabel("ab", TENANT)).toBe("ab-73db45");
    expect(defaultBuiltinLabel("", TENANT)).toBe("app-73db45");
    expect(defaultBuiltinLabel(null, TENANT)).toBe("app-73db45");
    expect(defaultBuiltinLabel("!!!", TENANT)).toBe("app-73db45");
  });

  it("caps a very long name and still validates", () => {
    const label = defaultBuiltinLabel("x".repeat(200) + " y", TENANT);
    expect(label.length).toBeLessThanOrEqual(63);
    expect(validateBuiltinLabel(label).ok).toBe(true);
  });

  it("every output validates, whatever the input", () => {
    for (const src of ["--a--", "A_B_C", "zavi", "www", "ñandú 42", "a".repeat(63), "-", "9"]) {
      expect(validateBuiltinLabel(defaultBuiltinLabel(src, TENANT))).toMatchObject({ ok: true });
    }
  });
});

describe("suffixedBuiltinLabel — the retry label after a label_taken race", () => {
  it("appends six hex chars of the tenant id", () => {
    expect(suffixedBuiltinLabel("upcar-ai", TENANT)).toBe("upcar-ai-73db45");
  });
  it("trims the base so the whole label fits in 63 chars", () => {
    const label = suffixedBuiltinLabel("b".repeat(80), TENANT);
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label.endsWith("-73db45")).toBe(true);
    expect(validateBuiltinLabel(label).ok).toBe(true);
  });
  it("slugify strips everything a hostname cannot carry", () => {
    expect(slugifyBuiltinLabel("Hello, World_2026")).toBe("hello-world-2026");
  });
});
