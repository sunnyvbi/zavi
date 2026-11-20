import { describe, it, expect, vi, beforeEach } from "vitest";

let globalBlob: { disabled_agent_slugs: string[] } | null = { disabled_agent_slugs: ["g-hidden"] };
let globalErr: unknown = null;
let tenantRows: { agent_slug: string; override_state?: string; source?: string }[] = [];
let tenantErr: unknown = null;

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "system_config") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: globalBlob ? { blob: globalBlob } : null, error: globalErr }),
        };
        return chain;
      }
      const filters: Array<[string, unknown]> = [];
      const result = () => ({
        data: tenantRows.filter((r) =>
          filters.every(([col, val]) =>
            col === "source" ? (r.source ?? "tenant") === val : true,
          ),
        ),
        error: tenantErr,
      });
      const tchain = {
        select: () => tchain,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return tchain;
        },
        then: (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res),
      };
      return tchain;
    },
  }),
}));

vi.mock("@/services/agents/registry", () => ({
  listDefaultDisabledSlugs: vi.fn(() => []),
  listAlwaysOnSlugs: vi.fn(() => []),
  getAgentDefaultState: vi.fn(() => "enabled"),
  listAgents: vi.fn(() => []),
  isChannelOnlyAgent: vi.fn(() => false),
}));

import {
  filterGlobalVisibleAgents,
  filterTenantVisibleAgents,
  getTenantDisabledSlugs,
  getGlobalDisabledSlugsStrict,
} from "../../services/agents/visibility";

const A = (slug: string) => ({ slug });

describe("visibility split API", () => {
  beforeEach(() => {
    globalBlob = { disabled_agent_slugs: ["g-hidden"] };
    globalErr = null;
    tenantRows = [];
    tenantErr = null;
  });

  it("global filter drops only global-disabled", async () => {
    const r = await filterGlobalVisibleAgents([A("g-hidden"), A("keep")]);
    expect(r.map((x) => x.slug)).toEqual(["keep"]);
  });

  it("tenant filter = global ∪ staff-hidden", async () => {
    tenantRows = [
      { agent_slug: "s-hidden", override_state: "hidden", source: "staff" },
    ];
    const r = await filterTenantVisibleAgents(
      [A("g-hidden"), A("s-hidden"), A("keep")],
      "11111111-1111-1111-1111-111111111111",
    );
    expect(r.map((x) => x.slug)).toEqual(["keep"]);
  });

  it("tenant-sourced hide row is IGNORED by the filter", async () => {
    tenantRows = [
      { agent_slug: "t-hidden", override_state: "hidden", source: "tenant" },
    ];
    const r = await filterTenantVisibleAgents(
      [A("t-hidden"), A("keep")],
      "11111111-1111-1111-1111-111111111111",
    );
    expect(r.map((x) => x.slug)).toEqual(["t-hidden", "keep"]);
  });

  it("falsy tenantId throws — no silent global-only", async () => {
    await expect(filterTenantVisibleAgents([A("x")], "")).rejects.toThrow(/tenantId/);
  });

  it("getTenantDisabledSlugs unions global + staff (tenant rows excluded)", async () => {
    tenantRows = [
      { agent_slug: "s-hidden", override_state: "hidden", source: "staff" },
      { agent_slug: "t-hidden", override_state: "hidden", source: "tenant" },
    ];
    const s = await getTenantDisabledSlugs("11111111-1111-1111-1111-111111111111");
    expect([...s].sort()).toEqual(["g-hidden", "s-hidden"]);
  });

  it("tenant read failure → fail-open GLOBAL-ONLY (not empty, not full-hide)", async () => {
    tenantErr = { message: "db blip" };
    const s = await getTenantDisabledSlugs("11111111-1111-1111-1111-111111111111");
    expect([...s]).toEqual(["g-hidden"]);
  });

  it("strict global read FAILS CLOSED (throws) on DB error", async () => {
    globalErr = { message: "pg down" };
    await expect(getGlobalDisabledSlugsStrict()).rejects.toThrow(/pg down/);
  });
});
