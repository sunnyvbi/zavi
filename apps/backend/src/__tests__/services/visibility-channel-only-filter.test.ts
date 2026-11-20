import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "system_config") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: { blob: { disabled_agent_slugs: [] } }, error: null }),
        };
        return chain;
      }
      const tchain = {
        select: () => tchain,
        eq: () => tchain,
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(res),
      };
      return tchain;
    },
  }),
}));

const CHANNEL_ONLY = new Set(["sms", "email_marketing"]);
const ALL = ["growth-lead", "sms", "email_marketing", "engineer"];

vi.mock("@/services/agents/registry", () => ({
  listDefaultDisabledSlugs: vi.fn(() => []),
  listAlwaysOnSlugs: vi.fn(() => []),
  getAgentDefaultState: vi.fn(() => "enabled"),
  listAgents: vi.fn(() => ALL.map((slug) => ({ slug }))),
  isChannelOnlyAgent: vi.fn((slug: string) => CHANNEL_ONLY.has(slug)),
  getAgentShapeConstraints: vi.fn(() => null),
}));

import {
  filterTenantVisibleAgents,
  getVisibleAgentSlugs,
} from "@/services/agents/visibility";

const TENANT = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("filterTenantVisibleAgents — channel_only", () => {
  it("drops channel_only agents from the list", async () => {
    const r = await filterTenantVisibleAgents(
      ALL.map((slug) => ({ slug })),
      TENANT,
    );

    expect(r.map((a) => a.slug)).toEqual(["growth-lead", "engineer"]);
  });

  it("drops them even when NO kill switch is set (the early-return path)", async () => {
    const r = await filterTenantVisibleAgents([{ slug: "sms" }], TENANT);

    expect(r).toEqual([]);
  });

  it("keeps ordinary agents untouched", async () => {
    const r = await filterTenantVisibleAgents(
      [{ slug: "growth-lead" }, { slug: "engineer" }],
      TENANT,
    );

    expect(r.map((a) => a.slug)).toEqual(["growth-lead", "engineer"]);
  });

  it("still lets a channel recipe RUN one — getVisibleAgentSlugs is unchanged", async () => {
    const visible = await getVisibleAgentSlugs(TENANT);

    expect(visible.has("sms")).toBe(true);
    expect(visible.has("email_marketing")).toBe(true);
  });
});
