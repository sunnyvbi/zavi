
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }),
    }),
  }),
}));

vi.mock("@/services/routines/inject", () => ({
  synthesizeApprovedRoutineTools: vi.fn(async () => []),
}));

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

import {
  discoverToolsForTenant,
  listToolsForTenant,
  _clearToolCacheForTests,
} from "../discovery";

const TENANT = "aaaaaaaa-0000-0000-0000-000000000001";
const MAPPED = "growth-lead";
const UNMAPPED = "engineer";

describe("discovery — skill__load injection (dual-engine single source)", () => {
  beforeEach(() => _clearToolCacheForTests());

  it("splices skill__load for an agent with ≥1 mapped skill", async () => {
    const r = await discoverToolsForTenant(TENANT, [], MAPPED);
    const tool = r.tools.find((t) => t.name === "skill__load");
    expect(tool).toBeTruthy();
    expect(tool?.server_id).toBe("skill");
  });

  it("does NOT splice skill__load for an unmapped agent", async () => {
    const r = await discoverToolsForTenant(TENANT, [], UNMAPPED);
    expect(r.tools.find((t) => t.name === "skill__load")).toBeUndefined();
  });

  it("does NOT splice skill__load when agent_slug is omitted (legacy callers)", async () => {
    const r = await discoverToolsForTenant(TENANT, []);
    expect(r.tools.find((t) => t.name === "skill__load")).toBeUndefined();
  });

  it("splices skill__load for the SAME mapped agent regardless of tenant (static, no tenant data)", async () => {
    const r1 = await discoverToolsForTenant(TENANT, [], MAPPED);
    _clearToolCacheForTests();
    const r2 = await discoverToolsForTenant(
      "bbbbbbbb-0000-0000-0000-000000000002",
      [],
      MAPPED,
    );
    expect(r1.tools.find((t) => t.name === "skill__load")).toBeTruthy();
    expect(r2.tools.find((t) => t.name === "skill__load")).toBeTruthy();
  });

  it("does NOT splice skill__load when opts.suppressSkillTool is true (no-load control arm)", async () => {
    const r = await discoverToolsForTenant(TENANT, [], MAPPED, {
      suppressSkillTool: true,
    });
    expect(r.tools.find((t) => t.name === "skill__load")).toBeUndefined();
  });

  it("DOES splice skill__load when opts.suppressSkillTool is false/omitted (load arm — byte-identical to today)", async () => {
    const rFalse = await discoverToolsForTenant(TENANT, [], MAPPED, {
      suppressSkillTool: false,
    });
    expect(rFalse.tools.find((t) => t.name === "skill__load")).toBeTruthy();
    _clearToolCacheForTests();
    const rOmitted = await discoverToolsForTenant(TENANT, [], MAPPED, {});
    expect(rOmitted.tools.find((t) => t.name === "skill__load")).toBeTruthy();
  });

  it("listToolsForTenant (SDK path) passes suppressSkillTool through to discovery", async () => {
    const suppressed = await listToolsForTenant(TENANT, [], MAPPED, {
      suppressSkillTool: true,
    });
    expect(suppressed.find((t) => t.name === "skill__load")).toBeUndefined();
    _clearToolCacheForTests();
    const normal = await listToolsForTenant(TENANT, [], MAPPED);
    expect(normal.find((t) => t.name === "skill__load")).toBeTruthy();
  });
});
