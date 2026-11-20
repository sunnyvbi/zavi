
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClient = {
  from: vi.fn(),
};
const mockMaybeSingle = vi.fn();

vi.mock("@/services/supabase", () => ({
  serviceClient: () => mockClient,
}));

const mockGetAgentDefaultState = vi.fn();
const mockListAgents = vi.fn();
const mockListAlwaysOnSlugs = vi.fn();
const mockListDefaultDisabledSlugs = vi.fn();

vi.mock("@/services/agents/registry", () => ({
  getAgentDefaultState: (...a: unknown[]) => mockGetAgentDefaultState(...a),
  listAgents: (...a: unknown[]) => mockListAgents(...a),
  listAlwaysOnSlugs: (...a: unknown[]) => mockListAlwaysOnSlugs(...a),
  listDefaultDisabledSlugs: (...a: unknown[]) => mockListDefaultDisabledSlugs(...a),
  isChannelOnlyAgent: () => false,
}));

import { getEffectiveVisibility } from "@/services/agents/visibility";

function setKillSwitchLookup(ov: { override_state: string; source: string } | null) {
  const filters: Array<[string, unknown]> = [];
  const matches = () =>
    ov !== null &&
    filters.every(([col, val]) => {
      if (col === "source") return ov.source === val;
      if (col === "override_state") return ov.override_state === val;
      return true;
    });
  type Builder = {
    select: () => Builder;
    eq: (col: string, val: unknown) => Builder;
    maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  };
  const builder: Builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn((_col: string, _val: unknown) => {
      filters.push([_col, _val]);
      return builder;
    }),
    maybeSingle: mockMaybeSingle.mockImplementation(async () => ({
      data: matches() ? ov : null,
      error: null,
    })),
  };
  mockClient.from.mockImplementation((table: string) => {
    if (table === "tenant_agent_kill_switch") return builder;
    if (table === "system_config") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { blob: { disabled_agent_slugs: globalHide } },
          error: null,
        }),
      };
    }
    return builder;
  });
}

let globalHide: string[] = [];

beforeEach(() => {
  mockClient.from.mockReset();
  mockMaybeSingle.mockReset();
  mockGetAgentDefaultState.mockReset();
  mockListAgents.mockReset();
  mockListAlwaysOnSlugs.mockReset();
  mockListDefaultDisabledSlugs.mockReset();
  globalHide = [];
  mockListAlwaysOnSlugs.mockReturnValue([]);
  mockListDefaultDisabledSlugs.mockReturnValue([]);
});

describe("getEffectiveVisibility — precedence", () => {
  it("always_on wins over everything (highest precedence)", async () => {
    mockGetAgentDefaultState.mockReturnValue("always_on");
    setKillSwitchLookup({ override_state: "hidden", source: "staff" });
    globalHide = ["engineer"];

    const eff = await getEffectiveVisibility("tenant-1", "engineer");
    expect(eff).toEqual({ visible: true, reason: "always_on" });
  });

  it("STAFF visible-override beats global_override_hide (codex CX-4 P1 fix)", async () => {
    mockGetAgentDefaultState.mockReturnValue("disabled");
    setKillSwitchLookup({ override_state: "visible", source: "staff" });
    globalHide = ["agent-coach"];

    const eff = await getEffectiveVisibility("tenant-1", "agent-coach");
    expect(eff).toEqual({ visible: true, reason: "tenant_visible_override" });
  });

  it("tenant visible-override can NO LONGER beat global_override_hide", async () => {
    mockGetAgentDefaultState.mockReturnValue("disabled");
    setKillSwitchLookup({ override_state: "visible", source: "tenant" });
    globalHide = ["agent-coach"];

    const eff = await getEffectiveVisibility("tenant-1", "agent-coach");
    expect(eff).toEqual({ visible: false, reason: "global_override_hide" });
  });

  it("tenant hidden-override (source=tenant) is IGNORED — stays visible", async () => {
    mockGetAgentDefaultState.mockReturnValue("enabled");
    setKillSwitchLookup({ override_state: "hidden", source: "tenant" });
    globalHide = [];

    const eff = await getEffectiveVisibility("tenant-1", "chief-of-staff");
    expect(eff).toEqual({ visible: true, reason: "default_enabled" });
  });

  it("staff_locked_hide distinguished from tenant_hidden_override in reason", async () => {
    mockGetAgentDefaultState.mockReturnValue("enabled");
    setKillSwitchLookup({ override_state: "hidden", source: "staff" });
    globalHide = [];

    const eff = await getEffectiveVisibility("tenant-1", "chief-of-staff");
    expect(eff).toEqual({ visible: false, reason: "staff_locked_hide" });
  });

  it("global_override_hide kicks in when no tenant override + agent default-enabled", async () => {
    mockGetAgentDefaultState.mockReturnValue("enabled");
    setKillSwitchLookup(null);
    globalHide = ["chief-of-staff"];

    const eff = await getEffectiveVisibility("tenant-1", "chief-of-staff");
    expect(eff).toEqual({ visible: false, reason: "global_override_hide" });
  });

  it("default_state 'disabled' NO LONGER hides — visible with no staff lever", async () => {
    mockGetAgentDefaultState.mockReturnValue("disabled");
    setKillSwitchLookup(null);
    globalHide = [];

    const eff = await getEffectiveVisibility("tenant-1", "agent-coach");
    expect(eff).toEqual({ visible: true, reason: "default_enabled" });
  });

  it("default_enabled is the visible-fallthrough case", async () => {
    mockGetAgentDefaultState.mockReturnValue("enabled");
    setKillSwitchLookup(null);
    globalHide = [];

    const eff = await getEffectiveVisibility("tenant-1", "chief-of-staff");
    expect(eff).toEqual({ visible: true, reason: "default_enabled" });
  });

  it("throws when tenantId missing", async () => {
    await expect(getEffectiveVisibility("", "x")).rejects.toThrow(/tenantId required/);
  });

  it("throws when slug missing", async () => {
    await expect(getEffectiveVisibility("tenant-1", "")).rejects.toThrow(/slug required/);
  });
});
