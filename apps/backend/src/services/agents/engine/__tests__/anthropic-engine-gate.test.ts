
import { describe, it, expect } from "vitest";

import { shouldUseAnthropicEngine } from "../anthropic-engine-gate";

const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER = "e0fe9ea8-0000-0000-0000-000000000000";

describe("shouldUseAnthropicEngine — default OFF", () => {
  it("returns false with an empty env (no flag, no allowlist) → legacy inline path", () => {
    expect(shouldUseAnthropicEngine(TENANT, {})).toBe(false);
  });

  it("returns false when the master flag is explicitly off-shaped", () => {
    for (const off of ["off", "0", "false", "no", ""]) {
      expect(
        shouldUseAnthropicEngine(TENANT, { PRAXIS_ANTHROPIC_ENGINE: off }),
      ).toBe(false);
    }
  });

  it("returns false for a tenant NOT in the env CSV allowlist", () => {
    expect(
      shouldUseAnthropicEngine(OTHER, {
        PRAXIS_ANTHROPIC_ENGINE_TENANTS: TENANT,
      }),
    ).toBe(false);
  });
});

describe("shouldUseAnthropicEngine — canary ON for an allowlisted tenant", () => {
  it("returns true when the tenant is in the env CSV allowlist", () => {
    expect(
      shouldUseAnthropicEngine(TENANT, {
        PRAXIS_ANTHROPIC_ENGINE_TENANTS: TENANT,
      }),
    ).toBe(true);
  });

  it("matches a tenant in a multi-entry, whitespace-padded CSV", () => {
    expect(
      shouldUseAnthropicEngine(TENANT, {
        PRAXIS_ANTHROPIC_ENGINE_TENANTS: ` ${OTHER} , ${TENANT} `,
      }),
    ).toBe(true);
  });

  it("returns true when the tenant is in the DB-sourced config allowlist", () => {
    expect(shouldUseAnthropicEngine(TENANT, {}, [OTHER, TENANT])).toBe(true);
  });

  it("returns false when the tenant is absent from the config allowlist", () => {
    expect(shouldUseAnthropicEngine(TENANT, {}, [OTHER])).toBe(false);
  });
});

describe("shouldUseAnthropicEngine — fleet-wide master ON", () => {
  it("flips EVERY tenant on for an on-shaped master flag", () => {
    for (const on of ["on", "1", "true", "all", "yes"]) {
      expect(
        shouldUseAnthropicEngine(OTHER, { PRAXIS_ANTHROPIC_ENGINE: on }),
      ).toBe(true);
    }
  });

  it("master ON wins even for a tenant not on any allowlist", () => {
    expect(
      shouldUseAnthropicEngine("any-random-tenant", {
        PRAXIS_ANTHROPIC_ENGINE: "all",
      }),
    ).toBe(true);
  });
});

describe("shouldUseAnthropicEngine — fail-closed on malformed input", () => {
  it("returns false for an empty / missing tenant id", () => {
    expect(shouldUseAnthropicEngine("", { PRAXIS_ANTHROPIC_ENGINE: "on" })).toBe(
      false,
    );
    expect(
      shouldUseAnthropicEngine(undefined as unknown as string, {}),
    ).toBe(false);
  });

  it("ignores non-string entries in the config allowlist (no accidental match)", () => {
    expect(
      shouldUseAnthropicEngine(TENANT, {}, [
        123,
        null,
        { tenant_id: TENANT },
        ["nested"],
      ] as unknown[]),
    ).toBe(false);
  });

  it("treats a non-array configAllowlist as absent (no throw, OFF)", () => {
    expect(
      shouldUseAnthropicEngine(
        TENANT,
        {},
        { foo: "bar" } as unknown as readonly unknown[],
      ),
    ).toBe(false);
  });

  it("a garbage master-flag value is OFF (not truthy-by-accident)", () => {
    expect(
      shouldUseAnthropicEngine(TENANT, { PRAXIS_ANTHROPIC_ENGINE: "maybe" }),
    ).toBe(false);
  });
});
