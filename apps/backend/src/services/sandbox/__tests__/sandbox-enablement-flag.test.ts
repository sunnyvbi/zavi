
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  settingValue: [] as unknown,
  getSettingCalls: 0,
}));

vi.mock("@/services/settings", () => ({
  getSetting: vi.fn(async (_key: string, _tenant_id?: string | null) => {
    H.getSettingCalls += 1;
    return H.settingValue;
  }),
}));

import { resolveEffectiveRequiresSandbox } from "../sandbox-enablement-flag";

const agent = (slug: string, requires_sandbox: boolean) => ({
  slug,
  metadata_praxis: { requires_sandbox },
});

beforeEach(() => {
  H.settingValue = [];
  H.getSettingCalls = 0;
});

describe("resolveEffectiveRequiresSandbox", () => {
  it("frontmatter true → true WITHOUT reading the flag (engineer path byte-identical)", async () => {
    const r = await resolveEffectiveRequiresSandbox(agent("engineer", true), "t-1");
    expect(r).toBe(true);
    expect(H.getSettingCalls).toBe(0);
  });

  it("frontmatter false + flag unset (default []) → false (default-unchanged)", async () => {
    H.settingValue = [];
    const r = await resolveEffectiveRequiresSandbox(agent("operator", false), "t-1");
    expect(r).toBe(false);
  });

  it("frontmatter false + tenant allowlists THIS (non-gated) agent → true", async () => {
    H.settingValue = ["pm"];
    const r = await resolveEffectiveRequiresSandbox(agent("pm", false), "t-1");
    expect(r).toBe(true);
  });

  it("frontmatter false + tenant allowlists a DIFFERENT agent → false", async () => {
    H.settingValue = ["research"];
    const r = await resolveEffectiveRequiresSandbox(agent("pm", false), "t-1");
    expect(r).toBe(false);
  });

  it("DENYLIST: a gated agent (operator) is NEVER flag-promoted, even if allowlisted, WITHOUT reading the flag", async () => {
    H.settingValue = ["operator"];
    const r = await resolveEffectiveRequiresSandbox(agent("operator", false), "t-1");
    expect(r).toBe(false);
    expect(H.getSettingCalls).toBe(0);
  });

  it("no tenant context → false WITHOUT reading the flag (cannot consult per-tenant)", async () => {
    H.settingValue = ["operator"];
    const r = await resolveEffectiveRequiresSandbox(agent("operator", false), null);
    expect(r).toBe(false);
    expect(H.getSettingCalls).toBe(0);
  });

  it("WILDCARD ['*'] (fleet-wide default) → every non-denylisted non-engineer agent is lazy-eligible", async () => {
    H.settingValue = ["*"];
    for (const slug of ["pm", "qa", "research", "support-lead", "growth-lead"]) {
      const r = await resolveEffectiveRequiresSandbox(agent(slug, false), "t-1");
      expect(r).toBe(true);
    }
  });

  it("WILDCARD ['*'] does NOT promote a DENYLISTED agent (operator) — denylist beats the wildcard, no flag read", async () => {
    H.settingValue = ["*"];
    const r = await resolveEffectiveRequiresSandbox(agent("operator", false), "t-1");
    expect(r).toBe(false);
    expect(H.getSettingCalls).toBe(0);
  });

  it("WILDCARD ['*'] leaves engineer's eager frontmatter path untouched (true without a flag read)", async () => {
    H.settingValue = ["*"];
    const r = await resolveEffectiveRequiresSandbox(agent("engineer", true), "t-1");
    expect(r).toBe(true);
    expect(H.getSettingCalls).toBe(0);
  });

  it("'*' mixed into a list (e.g. ['research','*']) still promotes any non-denylisted agent", async () => {
    H.settingValue = ["research", "*"];
    const r = await resolveEffectiveRequiresSandbox(agent("pm", false), "t-1");
    expect(r).toBe(true);
  });

  it("OPT-OUT: per-tenant override of [] → nobody lazy-eligible (a tenant can opt out of the wildcard)", async () => {
    H.settingValue = [];
    const r = await resolveEffectiveRequiresSandbox(agent("pm", false), "t-1");
    expect(r).toBe(false);
  });

  it("malformed flag value (not an array) → false (fail-closed)", async () => {
    H.settingValue = { pm: true } as unknown;
    const r = await resolveEffectiveRequiresSandbox(agent("pm", false), "t-1");
    expect(r).toBe(false);
  });

  it("flag read throws → false (fail-closed to frontmatter)", async () => {
    const settings = await import("@/services/settings");
    (settings.getSetting as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db down"),
    );
    const r = await resolveEffectiveRequiresSandbox(agent("pm", false), "t-1");
    expect(r).toBe(false);
  });
});
