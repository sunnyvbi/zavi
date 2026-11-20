import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SiteDesignRow } from "../site-design-store";

const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  updates: [] as Array<{ tenant: string; patch: Record<string, unknown>; filters: Array<[string, string, unknown]> }>,
  failUpdate: false,
}));

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      expect(table).toBe("site_design_briefs");
      const entry = { tenant, patch: {} as Record<string, unknown>, filters: [] as Array<[string, string, unknown]> };
      const b = {
        update: (patch: Record<string, unknown>) => ((entry.patch = patch), db.updates.push(entry), b),
        eq: (c: string, v: unknown) => (entry.filters.push(["eq", c, v]), b),
        is: (c: string, v: unknown) => (entry.filters.push(["is", c, v]), b),
        select: async () => {
          if (db.failUpdate) return { data: null, error: { message: "boom" } };
          const r = db.row;
          const match =
            !!r &&
            entry.filters.every(([op, c, v]) => (op === "eq" ? r[c] === v : r[c] === v));
          if (!match) return { data: [], error: null };
          Object.assign(r!, entry.patch);
          return { data: [{ site_id: r!.site_id }], error: null };
        },
      };
      return b;
    },
  }),
}));

vi.mock("../site-design-store", () => ({
  siteDesignStore: () => ({
    get: async () => (db.row ? ({ ...db.row } as unknown as SiteDesignRow) : null),
  }),
}));

import {
  autoPickRecommendedLook,
  LOOK_AUTO_START_MS,
  lookAutoStartAt,
  lookAutoStartDue,
  lookParkedAt,
  recommendedLookId,
} from "../look-wait";

const SITE = "site-1";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    site_id: SITE,
    tenant_id: "t1",
    theme_mode: "theme_css",
    directions: [
      { id: "bold", recommended: false },
      { id: "warm-brand", recommended: true },
      { id: "calm", recommended: false },
    ],
    chosen_direction: "brand",
    chosen_by: "seed",
    chosen_at: null,
    sealed_at: null,
    ...over,
  };
}

beforeEach(() => {
  db.row = null;
  db.updates.length = 0;
  db.failUpdate = false;
});

describe("look auto start timing", () => {
  it("starts 60 seconds after the wait was stamped, and never without a stamp", () => {
    expect(LOOK_AUTO_START_MS).toBe(60_000);
    expect(lookAutoStartAt("2026-10-30T10:00:00.000Z")).toBe("2026-10-30T10:01:00.000Z");
    expect(lookAutoStartAt(null)).toBeNull();
    expect(lookAutoStartAt("not a date")).toBeNull();
    const parked = "2026-10-30T10:00:00.000Z";
    expect(lookAutoStartDue(parked, Date.parse("2026-10-30T10:00:59.999Z"))).toBe(false);
    expect(lookAutoStartDue(parked, Date.parse("2026-10-30T10:01:00.000Z"))).toBe(true);
    expect(lookAutoStartDue(null, Date.parse("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("reads the stamp only off a first pending node that is parked on the look", () => {
    const stamp = "2026-10-30T10:00:00.000Z";
    expect(lookParkedAt([{ status: "done", payload: {} }, { status: "pending", payload: { await_look: true, await_look_parked_at: stamp } }])).toBe(stamp);
    expect(lookParkedAt([{ status: "pending", payload: { await_look_parked_at: stamp } }])).toBeNull();
    expect(lookParkedAt([{ status: "pending", payload: { await_look: true } }])).toBeNull();
    expect(lookParkedAt([{ status: "pending", payload: { await_look: true, await_look_parked_at: "garbage" } }])).toBeNull();
    expect(lookParkedAt(null)).toBeNull();
  });

  it("the recommended look is the one flagged recommended, else the brand look", () => {
    expect(recommendedLookId({ directions: row().directions as SiteDesignRow["directions"] })).toBe("warm-brand");
    expect(recommendedLookId({ directions: [{ id: "bold" }] as unknown as SiteDesignRow["directions"] })).toBe("brand");
  });
});

describe("autoPickRecommendedLook", () => {
  it("saves the recommended look with no user, only while nothing is picked or sealed", async () => {
    db.row = row();
    expect(await autoPickRecommendedLook({ tenant_id: "t1", site_id: SITE })).toBe(true);
    expect(db.row.chosen_direction).toBe("warm-brand");
    expect(db.row.chosen_by).toBeNull();
    expect(typeof db.row.chosen_at).toBe("string");
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]!.tenant).toBe("t1");
    expect(db.updates[0]!.filters).toEqual([
      ["eq", "site_id", SITE],
      ["is", "chosen_at", null],
      ["is", "sealed_at", null],
    ]);
  });

  it("a founder pick that lands between the read and the write is never overwritten", async () => {
    db.row = row();
    const realGet = db.row;
    const founderPick = { chosen_direction: "calm", chosen_by: "founder-1", chosen_at: "2026-10-30T10:00:59.000Z" };
    const original = db.updates.push.bind(db.updates);
    db.updates.push = (...items) => {
      Object.assign(realGet, founderPick);
      return original(...items);
    };
    expect(await autoPickRecommendedLook({ tenant_id: "t1", site_id: SITE })).toBe(false);
    expect(db.row).toMatchObject(founderPick);
    db.updates.push = original;
  });

  it("does not write when the founder already picked, the look is sealed, or there is only one website", async () => {
    db.row = row({ chosen_at: "2026-10-30T10:00:10.000Z", chosen_direction: "bold" });
    expect(await autoPickRecommendedLook({ tenant_id: "t1", site_id: SITE })).toBe(false);
    db.row = row({ sealed_at: "2026-10-30T10:00:10.000Z" });
    expect(await autoPickRecommendedLook({ tenant_id: "t1", site_id: SITE })).toBe(false);
    db.row = row({ directions: [{ id: "brand", recommended: true }] });
    expect(await autoPickRecommendedLook({ tenant_id: "t1", site_id: SITE })).toBe(false);
    expect(db.updates).toHaveLength(0);
  });

  it("a write error throws so the conductor keeps the build parked", async () => {
    db.row = row();
    db.failUpdate = true;
    await expect(autoPickRecommendedLook({ tenant_id: "t1", site_id: SITE })).rejects.toThrow(/auto look pick failed/);
  });
});
