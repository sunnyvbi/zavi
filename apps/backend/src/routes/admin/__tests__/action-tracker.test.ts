
import { describe, it, expect } from "vitest";
import { shapeActionTracker, CATALOG, type RpcCountRow } from "../action-tracker";

function row(p: Partial<RpcCountRow> & Pick<RpcCountRow, "level" | "grp">): RpcCountRow {
  return { action: null, dim: null, total: 0, d30: 0, d7: 0, d1: 0, tenants: 0, ...p };
}

describe("shapeActionTracker", () => {
  it("empty RPC result → every catalog group at zero, dense zero daily series", () => {
    const out = shapeActionTracker({ tenants_in_scope: 0, counts: null, daily: null }, 7, "2026-09-21");
    expect(out.groups.map((g) => g.key)).toEqual(CATALOG.map((g) => g.key));
    expect(out.groups.every((g) => g.total === 0 && g.actions.every((a) => a.total === 0))).toBe(true);
    expect(out.daily).toHaveLength(7);
    expect(out.daily[0].day).toBe("2026-09-15");
    expect(out.daily[6].day).toBe("2026-09-21");
    expect(out.daily.every((d) => d.total === 0)).toBe(true);
  });

  it("places group, action and dimension rows; coerces bigint strings", () => {
    const out = shapeActionTracker(
      {
        tenants_in_scope: "12",
        counts: [
          row({ level: "group", grp: "media", total: "9", d30: "5", d7: "2", d1: "1", tenants: "3" }),
          row({ level: "action", grp: "media", action: "media.image", total: "7", tenants: "3" }),
          row({ level: "action", grp: "media", action: "media.video", total: "2", tenants: "1" }),
        ],
        daily: [],
      },
      7,
      "2026-09-21",
    );
    expect(out.tenants_in_scope).toBe(12);
    const media = out.groups.find((g) => g.key === "media")!;
    expect(media).toMatchObject({ total: 9, d30: 5, d7: 2, d1: 1, tenants: 3 });
    expect(media.actions.map((a) => [a.key, a.total])).toEqual([
      ["media.image", 7],
      ["media.video", 2],
    ]);
  });

  it("labels channel breakdowns by registry name and sorts them by total", () => {
    const out = shapeActionTracker(
      {
        tenants_in_scope: 1,
        counts: [
          row({ level: "action", grp: "channels", action: "channel.run", total: 5 }),
          row({ level: "dim", grp: "channels", action: "channel.run", dim: "seo", total: 1 }),
          row({ level: "dim", grp: "channels", action: "channel.run", dim: "meta_ads", total: 4 }),
        ],
        daily: [],
      },
      7,
      "2026-09-21",
    );
    const run = out.groups.find((g) => g.key === "channels")!.actions[0];
    expect(run.breakdown_label).toBe("channels");
    const images = out.groups.find((g) => g.key === "media")!.actions.find((x) => x.key === "media.image")!;
    expect(images.breakdown_label).toBe("kinds");
    expect(run.breakdown.map((b) => [b.key, b.label, b.total])).toEqual([
      ["meta_ads", "Meta Ads", 4],
      ["seo", "SEO", 1],
    ]);
  });

  it("a one-row breakdown reads singular", () => {
    const out = shapeActionTracker(
      {
        tenants_in_scope: 1,
        counts: [row({ level: "dim", grp: "founder", action: "founder.acted", dim: "seo", total: 2 })],
        daily: [],
      },
      7,
      "2026-09-21",
    );
    const acted = out.groups.find((g) => g.key === "founder")!.actions.find((x) => x.key === "founder.acted")!;
    expect(acted.breakdown_label).toBe("channel");
  });

  it("an action the catalog doesn't know lands in an Other group instead of vanishing", () => {
    const out = shapeActionTracker(
      {
        tenants_in_scope: 1,
        counts: [row({ level: "action", grp: "brand_new", action: "brand_new.thing", total: 3, d7: 1, tenants: 2 })],
        daily: [{ day: "2026-09-21", grp: "brand_new", n: 3 }],
      },
      7,
      "2026-09-21",
    );
    const other = out.groups.find((g) => g.key === "other")!;
    expect(other.actions.map((a) => a.key)).toEqual(["brand_new.thing"]);
    expect(other).toMatchObject({ total: 3, d7: 1, tenants: 2 });
    expect(out.daily[6]).toEqual({ day: "2026-09-21", total: 3, groups: { other: 3 } });
  });

  it("an unknown action inside a KNOWN group is counted once, under that group", () => {
    const grp = CATALOG[0].key;
    const out = shapeActionTracker(
      {
        tenants_in_scope: 1,
        counts: [
          row({ level: "group", grp, total: 10, d7: 4, tenants: 2 }),
          row({ level: "action", grp, action: `${grp}.brand_new`, total: 3, d7: 1, tenants: 2 }),
        ],
        daily: [{ day: "2026-09-21", grp, n: 10 }],
      },
      7,
      "2026-09-21",
    );
    expect(out.groups.find((g) => g.key === "other")).toBeUndefined();
    const g = out.groups.find((x) => x.key === grp)!;
    expect(g.total).toBe(10);
    expect(g.actions.map((a) => a.key)).toContain(`${grp}.brand_new`);
    expect(out.daily[6]).toEqual({ day: "2026-09-21", total: 10, groups: { [grp]: 10 } });
  });

  it("daily: sums per group per day and zero-fills gaps", () => {
    const out = shapeActionTracker(
      {
        tenants_in_scope: 1,
        counts: [],
        daily: [
          { day: "2026-09-19", grp: "media", n: "2" },
          { day: "2026-09-19", grp: "chat", n: 5 },
          { day: "2026-09-21T00:00:00+00:00", grp: "media", n: 1 },
        ],
      },
      3,
      "2026-09-21",
    );
    expect(out.daily).toEqual([
      { day: "2026-09-19", total: 7, groups: { media: 2, chat: 5 } },
      { day: "2026-09-20", total: 0, groups: {} },
      { day: "2026-09-21", total: 1, groups: { media: 1 } },
    ]);
  });
});
