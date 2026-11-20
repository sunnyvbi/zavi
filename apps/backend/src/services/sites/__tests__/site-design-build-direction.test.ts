import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Update = { values: Record<string, unknown>; filters: Array<[string, string, unknown]> };
const updates: Update[] = [];
let answer: (u: Update) => Record<string, unknown> | null = () => null;

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: () => {
    throw new Error("not used");
  },
  tenantClient: () => ({
    from: () => ({
      update: (values: Record<string, unknown>) => {
        const u: Update = { values, filters: [] };
        const chain = {
          eq: (c: string, v: unknown) => (u.filters.push(["eq", c, v]), chain),
          is: (c: string, v: unknown) => (u.filters.push(["is", c, v]), chain),
          select: () => chain,
          maybeSingle: async () => {
            updates.push(u);
            return { data: answer(u), error: null };
          },
        };
        return chain;
      },
    }),
  }),
}));

import { freezeBuildDirection, type SiteDesignRow } from "../site-design-store";
import { designDirections, fallbackDesignBrief, withCompleteLook } from "../design-directions";

const T = "11111111-1111-4111-8111-111111111111";
const SITE = "33333333-3333-4333-8333-333333333333";
const IDEA = "A dog grooming van that books appointments across town.";
const BRIEF = withCompleteLook(fallbackDesignBrief({ idea: IDEA }), IDEA);

function row(over: Partial<SiteDesignRow> = {}): SiteDesignRow {
  return {
    site_id: SITE,
    tenant_id: T,
    conductor_run_id: "run-1",
    brief: BRIEF,
    directions: designDirections(BRIEF),
    theme_mode: "theme_css",
    chosen_direction: "brand",
    chosen_at: null,
    applied_direction: "brand",
    build_direction: null,
    sealed_at: null,
    journey_fix_claimed_at: null,
    journey_fix_conductor_run_id: null,
    fidelity: null,
    updated_at: null,
    ...over,
  };
}

const asDb = (r: SiteDesignRow) => JSON.parse(JSON.stringify(r)) as Record<string, unknown>;

beforeEach(() => {
  updates.length = 0;
  answer = () => null;
});

describe("freezeBuildDirection", () => {
  it("fixes the structure to the current pick, once, and only while the pick is still that one", async () => {
    const reads = [row({ chosen_direction: "brand" })];
    answer = (u) => asDb(row({ build_direction: u.values.build_direction as string }));
    const out = await freezeBuildDirection(T, SITE, { get: async () => reads[0]! });
    expect(out?.build_direction).toBe("brand");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filters).toEqual(
      expect.arrayContaining([
        ["eq", "site_id", SITE],
        ["eq", "chosen_direction", "brand"],
        ["is", "build_direction", null],
      ]),
    );
  });

  it("a structure already fixed is kept (a fix pass, a retry): no write", async () => {
    const out = await freezeBuildDirection(T, SITE, { get: async () => row({ build_direction: "studio", chosen_direction: "brand" }) });
    expect(out?.build_direction).toBe("studio");
    expect(updates).toHaveLength(0);
  });

  it("a pick racing the write is retried against the new pick", async () => {
    const dirs = designDirections(BRIEF);
    const picks = ["brand", dirs[1]!.id];
    let reads = 0;
    answer = (u) => (u.filters.some(([, c, v]) => c === "chosen_direction" && v === picks[1]) ? asDb(row({ chosen_direction: picks[1], build_direction: picks[1] })) : null);
    const out = await freezeBuildDirection(T, SITE, { get: async () => row({ chosen_direction: picks[Math.min(reads++, 1)]! }) });
    expect(out?.build_direction).toBe(picks[1]);
    expect(updates).toHaveLength(2);
  });

  it("no row: nothing to fix", async () => {
    expect(await freezeBuildDirection(T, SITE, { get: async () => null })).toBeNull();
    expect(updates).toHaveLength(0);
  });
});

describe("20261021100000_site_design_build_direction.sql", () => {
  const sql = readFileSync(join(__dirname, "../../../../../../supabase/migrations/20261021100000_site_design_build_direction.sql"), "utf-8");
  it("only adds the two nullable columns, with the direction id shape check", () => {
    expect(sql).toMatch(/add column if not exists build_direction text/);
    expect(sql).toMatch(/build_direction is null or build_direction ~ '\^\[a-z\]\[a-z0-9-\]\{1,30\}\$'/);
    expect(sql).toMatch(/add column if not exists build_direction_at timestamptz/);
    expect(sql).not.toMatch(/drop |not null|grant /i);
  });
});
