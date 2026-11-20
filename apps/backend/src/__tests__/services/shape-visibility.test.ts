
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shapeMismatchHidesAgent,
  hasShapeConstraints,
} from "@/services/agents/shape-visibility";

let flagOn = false;
let globalHide: string[] = [];
let override: { override_state: string; source: string } | null = null;
let tenantShapeRow: string | null = null;
const tenantsEqCalls: Array<[string, unknown]> = [];
const tablesQueried: string[] = [];

const mockClient = {
  from: vi.fn((table: string) => {
    tablesQueried.push(table);
    if (table === "system_config") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: {
            blob: {
              disabled_agent_slugs: globalHide,
              ...(flagOn ? { shape_based_visibility: true } : {}),
            },
          },
          error: null,
        }),
      };
    }
    if (table === "tenant_agent_kill_switch") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: override, error: null }),
      };
    }
    if (table === "tenants") {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((col: string, val: unknown) => {
          tenantsEqCalls.push([col, val]);
          return {
            maybeSingle: vi
              .fn()
              .mockResolvedValue({ data: { company_shape: tenantShapeRow }, error: null }),
          };
        }),
        maybeSingle: vi
          .fn()
          .mockResolvedValue({ data: { company_shape: tenantShapeRow }, error: null }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  }),
};

vi.mock("@/services/supabase", () => ({
  serviceClient: () => mockClient,
}));

let shapeConstraints: Record<
  string,
  { recommended_for_shapes?: string[]; hidden_for_shapes?: string[] } | null
> = {};
let defaultState: Record<string, "enabled" | "disabled" | "always_on"> = {};

vi.mock("@/services/agents/registry", () => ({
  getAgentDefaultState: (slug: string) => defaultState[slug] ?? "enabled",
  getAgentShapeConstraints: (slug: string) => shapeConstraints[slug] ?? null,
  listAgents: () => [],
  listAlwaysOnSlugs: () => [],
  listDefaultDisabledSlugs: () => [],
  isChannelOnlyAgent: () => false,
}));

import {
  getEffectiveVisibility,
  isShapeBasedVisibilityEnabled,
  getTenantCompanyShape,
} from "@/services/agents/visibility";

beforeEach(() => {
  flagOn = false;
  globalHide = [];
  override = null;
  tenantShapeRow = null;
  tenantsEqCalls.length = 0;
  tablesQueried.length = 0;
  shapeConstraints = {};
  defaultState = {};
  mockClient.from.mockClear();
});

describe("shapeMismatchHidesAgent (pure)", () => {
  const mktOnly = { recommended_for_shapes: ["marketplace"] };

  it("recommended allow-list MISS hides (saas not in [marketplace])", () => {
    expect(shapeMismatchHidesAgent("saas", mktOnly)).toBe(true);
  });
  it("recommended allow-list HIT shows (marketplace in [marketplace])", () => {
    expect(shapeMismatchHidesAgent("marketplace", mktOnly)).toBe(false);
  });
  it("null (unknown) shape NEVER hides — fail-open", () => {
    expect(shapeMismatchHidesAgent(null, mktOnly)).toBe(false);
  });
  it("no constraints NEVER hides — general agent untouched", () => {
    expect(shapeMismatchHidesAgent("saas", null)).toBe(false);
    expect(shapeMismatchHidesAgent("saas", {})).toBe(false);
    expect(shapeMismatchHidesAgent("saas", { recommended_for_shapes: [] })).toBe(false);
  });
  it("hidden_for_shapes deny-list hides", () => {
    expect(shapeMismatchHidesAgent("fintech", { hidden_for_shapes: ["fintech"] })).toBe(true);
    expect(shapeMismatchHidesAgent("saas", { hidden_for_shapes: ["fintech"] })).toBe(false);
  });
  it("deny wins even if also in recommended", () => {
    expect(
      shapeMismatchHidesAgent("saas", {
        recommended_for_shapes: ["saas"],
        hidden_for_shapes: ["saas"],
      }),
    ).toBe(true);
  });
  it("is case/whitespace tolerant on declared shapes", () => {
    expect(shapeMismatchHidesAgent("marketplace", { recommended_for_shapes: [" Marketplace "] })).toBe(
      false,
    );
  });
});

describe("hasShapeConstraints", () => {
  it("true only when a non-empty array is present", () => {
    expect(hasShapeConstraints(null)).toBe(false);
    expect(hasShapeConstraints({})).toBe(false);
    expect(hasShapeConstraints({ recommended_for_shapes: [] })).toBe(false);
    expect(hasShapeConstraints({ recommended_for_shapes: ["marketplace"] })).toBe(true);
    expect(hasShapeConstraints({ hidden_for_shapes: ["saas"] })).toBe(true);
  });
});

describe("isShapeBasedVisibilityEnabled — DEFAULT OFF", () => {
  it("absent key → false", async () => {
    flagOn = false;
    expect(await isShapeBasedVisibilityEnabled()).toBe(false);
  });
  it("explicit true → true", async () => {
    flagOn = true;
    expect(await isShapeBasedVisibilityEnabled()).toBe(true);
  });
});

describe("getTenantCompanyShape", () => {
  it("returns a validated shape", async () => {
    tenantShapeRow = "saas";
    expect(await getTenantCompanyShape("t1")).toBe("saas");
  });
  it("null column → null", async () => {
    tenantShapeRow = null;
    expect(await getTenantCompanyShape("t1")).toBeNull();
  });
  it("unrecognized value → null (fail-open)", async () => {
    tenantShapeRow = "banana";
    expect(await getTenantCompanyShape("t1")).toBeNull();
  });
  it("empty tenantId → null without a read", async () => {
    expect(await getTenantCompanyShape("")).toBeNull();
  });
});

describe("getEffectiveVisibility — Move E2 integration", () => {
  const SLUG = "supply-demand-balancer";
  beforeEach(() => {
    defaultState[SLUG] = "enabled";
    shapeConstraints[SLUG] = { recommended_for_shapes: ["marketplace"] };
  });

  it("flag OFF → VISIBLE for a saas tenant (byte-identical; no tenants read)", async () => {
    flagOn = false;
    tenantShapeRow = "saas";
    const eff = await getEffectiveVisibility("tenant-saas", SLUG);
    expect(eff).toEqual({ visible: true, reason: "default_enabled" });
    expect(tablesQueried).not.toContain("tenants");
  });

  it("flag ON + saas tenant → HIDDEN (shape_mismatch_hide)", async () => {
    flagOn = true;
    tenantShapeRow = "saas";
    const eff = await getEffectiveVisibility("tenant-saas", SLUG);
    expect(eff).toEqual({ visible: false, reason: "shape_mismatch_hide" });
  });

  it("flag ON + marketplace tenant → VISIBLE", async () => {
    flagOn = true;
    tenantShapeRow = "marketplace";
    const eff = await getEffectiveVisibility("tenant-mkt", SLUG);
    expect(eff).toEqual({ visible: true, reason: "default_enabled" });
  });

  it("flag ON + unknown-shape tenant → VISIBLE (fail-open)", async () => {
    flagOn = true;
    tenantShapeRow = null;
    const eff = await getEffectiveVisibility("tenant-unknown", SLUG);
    expect(eff).toEqual({ visible: true, reason: "default_enabled" });
  });

  it("flag ON + general agent (no constraints) → VISIBLE, no tenants read", async () => {
    flagOn = true;
    tenantShapeRow = "saas";
    shapeConstraints["chief-of-staff"] = null;
    defaultState["chief-of-staff"] = "enabled";
    const eff = await getEffectiveVisibility("tenant-saas", "chief-of-staff");
    expect(eff).toEqual({ visible: true, reason: "default_enabled" });
    expect(tablesQueried).not.toContain("tenants");
  });

  it("flag ON: tenant `visible` override BEATS shape-hide (operator opt-in)", async () => {
    flagOn = true;
    tenantShapeRow = "saas";
    override = { override_state: "visible", source: "tenant" };
    const eff = await getEffectiveVisibility("tenant-saas", SLUG);
    expect(eff).toEqual({ visible: true, reason: "tenant_visible_override" });
  });

  it("no cross-tenant leak: the shape read is scoped to the caller's tenant id", async () => {
    flagOn = true;
    tenantShapeRow = "saas";
    await getEffectiveVisibility("tenant-XYZ", SLUG);
    expect(tenantsEqCalls).toEqual([["id", "tenant-XYZ"]]);
  });
});
