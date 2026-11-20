import { describe, it, expect, vi, beforeEach } from "vitest";

const state: { blob: Record<string, unknown> | null; error: unknown } = {
  blob: {},
  error: null,
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            state.error
              ? { data: null, error: state.error }
              : { data: state.blob === null ? null : { blob: state.blob }, error: null },
        }),
      }),
    }),
  }),
}));

import { isPmOperatorDbEnabled, shouldDenyPmOperatorDb } from "../operator-db-flag";

beforeEach(() => {
  state.blob = {};
  state.error = null;
});

describe("isPmOperatorDbEnabled — default ON unless explicitly false", () => {
  it("absent key → ON (the new default)", async () => {
    state.blob = {};
    expect(await isPmOperatorDbEnabled()).toBe(true);
  });

  it("explicit true → ON", async () => {
    state.blob = { pm_operator_db_enabled: true };
    expect(await isPmOperatorDbEnabled()).toBe(true);
  });

  it("explicit false → OFF (kill switch)", async () => {
    state.blob = { pm_operator_db_enabled: false };
    expect(await isPmOperatorDbEnabled()).toBe(false);
  });

  it("other keys present, pm_operator_db_enabled absent → ON (default not clobbered)", async () => {
    state.blob = { pm_roadmap_enabled: true, disabled_agent_slugs: ["advisor"] };
    expect(await isPmOperatorDbEnabled()).toBe(true);
  });

  it("system_config read error → OFF (outage fails SAFE — never fail-open to PII)", async () => {
    state.error = { message: "pooler down" };
    expect(await isPmOperatorDbEnabled()).toBe(false);
  });

  it("no system_config row at all → ON (absent blob == default)", async () => {
    state.blob = null;
    expect(await isPmOperatorDbEnabled()).toBe(true);
  });
});

describe("shouldDenyPmOperatorDb — fail-closed deny predicate (E3 control)", () => {
  const opTool = "operator_db__query_user";
  const wrappedTool = "mcp__operatorServer__operator_db__query_user";

  it("pm + operator_db tool + flag undefined → DENY (dormant default)", () => {
    expect(shouldDenyPmOperatorDb({ agentSlug: "pm", toolName: opTool, flagEnabled: undefined })).toBe(true);
  });

  it("pm + operator_db tool + flag false → DENY", () => {
    expect(shouldDenyPmOperatorDb({ agentSlug: "pm", toolName: opTool, flagEnabled: false })).toBe(true);
  });

  it("pm + operator_db tool + flag true → ALLOW (not denied)", () => {
    expect(shouldDenyPmOperatorDb({ agentSlug: "pm", toolName: opTool, flagEnabled: true })).toBe(false);
  });

  it("pm + SDK-wrapped operator_db tool + flag off → DENY (matches wrapped form)", () => {
    expect(shouldDenyPmOperatorDb({ agentSlug: "pm", toolName: wrappedTool, flagEnabled: false })).toBe(true);
  });

  it("pm + NON-operator_db tool (memory__search) + flag off → ALLOW (unrelated tool unaffected)", () => {
    expect(shouldDenyPmOperatorDb({ agentSlug: "pm", toolName: "memory__search", flagEnabled: false })).toBe(false);
  });

  it("OTHER agent (operator) + operator_db + no pm flag → ALLOW (gate is pm-scoped, never blocks operator)", () => {
    expect(shouldDenyPmOperatorDb({ agentSlug: "operator", toolName: opTool, flagEnabled: undefined })).toBe(false);
  });

  it("pm + operator_db + truthy-but-not-true (string 'true') → DENY (only boolean true allows)", () => {
    expect(shouldDenyPmOperatorDb({ agentSlug: "pm", toolName: opTool, flagEnabled: "true" as unknown as boolean })).toBe(true);
  });
});
