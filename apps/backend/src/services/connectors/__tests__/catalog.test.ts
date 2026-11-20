import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  filterVisible: vi.fn(),
}));

vi.mock("@/services/agents/visibility", () => ({
  filterTenantVisibleAgents: mocks.filterVisible,
}));

import {
  CONNECTOR_DESCRIPTORS,
  CONNECTOR_SLUGS,
  SHAPE_PRIORITY,
  COMPANY_SHAPES,
  classifyShape,
  buildAgentsUnlockedMap,
  type ConnectorSlug,
} from "../catalog";

beforeEach(() => {
  mocks.filterVisible.mockImplementation(async (agents: unknown[]) => agents);
});

describe("classifyShape", () => {
  it("classifies marketplace copy", () => {
    expect(classifyShape("We run a two-sided P2P marketplace for cars.")).toBe(
      "marketplace",
    );
  });
  it("classifies saas copy", () => {
    expect(classifyShape("B2B SaaS, $79/seat MRR subscription.")).toBe("saas");
  });
  it("classifies fintech copy", () => {
    expect(classifyShape("We process payments and payouts for lenders.")).toBe(
      "fintech",
    );
  });
  it("falls back to other on empty / unknown", () => {
    expect(classifyShape("")).toBe("other");
    expect(classifyShape("we make widgets")).toBe("other");
  });
  it("is word-boundaried (no false 'saas' inside another word)", () => {
    expect(classifyShape("our saasquatch mascot is great")).toBe("other");
  });
});

describe("catalog integrity", () => {
  it("every catalog descriptor has rationale for every shape", () => {
    for (const d of CONNECTOR_DESCRIPTORS) {
      for (const shape of COMPANY_SHAPES) {
        expect(d.rationale_by_shape[shape]?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("every SHAPE_PRIORITY row covers exactly the connectable catalog slugs", () => {
    const catalogSet = new Set<string>(CONNECTOR_SLUGS);
    for (const shape of COMPANY_SHAPES) {
      const row = SHAPE_PRIORITY[shape];
      expect(new Set(row)).toEqual(catalogSet);
      expect(row.length).toBe(catalogSet.size);
    }
  });

  it("every priority slug has a descriptor", () => {
    const slugs = new Set(CONNECTOR_DESCRIPTORS.map((d) => d.slug));
    for (const shape of COMPANY_SHAPES) {
      for (const slug of SHAPE_PRIORITY[shape]) {
        expect(slugs.has(slug)).toBe(true);
      }
    }
  });
});

describe("buildAgentsUnlockedMap (dynamic, real registry)", () => {
  it("derives github unlocks from agents with github__ tools (incl. engineer)", async () => {
    const map = await buildAgentsUnlockedMap("tenant-x");
    expect(map.github).toContain("engineer");
  });

  it("derives slack unlocks dynamically", async () => {
    const map = await buildAgentsUnlockedMap("tenant-x");
    expect(map.slack).toContain("chief-of-staff");
    expect(map.slack).toContain("support-lead");
    expect(map.slack.length).toBeGreaterThan(3);
  });

  it("derives operator_db unlocks (data-grounded agents)", async () => {
    const map = await buildAgentsUnlockedMap("tenant-x");
    expect(map.operator_db).toContain("dispute-response");
  });

  it("derives ad connectors → performance-marketer", async () => {
    const map = await buildAgentsUnlockedMap("tenant-x");
    expect(map.meta_ads).toContain("performance-marketer");
    expect(map.google_ads).toContain("performance-marketer");
  });

  it("excludes the operator front-door router from every unlock list", async () => {
    const map = await buildAgentsUnlockedMap("tenant-x");
    for (const slug of CONNECTOR_SLUGS) {
      expect(map[slug]).not.toContain("operator");
    }
  });

  it("returns an entry for every catalog connector, sorted, no dupes", async () => {
    const map = await buildAgentsUnlockedMap("tenant-x");
    for (const slug of CONNECTOR_SLUGS) {
      const list = map[slug];
      expect(Array.isArray(list)).toBe(true);
      const sorted = [...list].sort();
      expect(list).toEqual(sorted);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("respects tenant visibility filter (hidden agents drop out of unlocks)", async () => {
    mocks.filterVisible.mockImplementation(async (agents: { slug: string }[]) =>
      agents.filter((a) => a.slug !== "engineer"),
    );
    const map = await buildAgentsUnlockedMap("tenant-x");
    expect(map.github).not.toContain("engineer");
    expect(map.github.length).toBeGreaterThan(0);
    for (const slug of ["growth-lead", "advisor", "pm"]) {
      expect(map.github).toContain(slug);
    }
  });

  it("fails open to the full fleet when the visibility read throws", async () => {
    mocks.filterVisible.mockRejectedValue(new Error("supabase down"));
    const map = await buildAgentsUnlockedMap("tenant-x");
    expect(map.slack.length).toBeGreaterThan(0);
    expect(map.github).toContain("engineer");
  });
});
