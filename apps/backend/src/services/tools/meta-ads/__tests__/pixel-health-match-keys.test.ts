
import { describe, it, expect } from "vitest";
import { projectMatchKeys, orderByEvidence, confusableNames, aggregateEventCounts } from "../pixel_health";

describe("projectMatchKeys", () => {
  it("keeps known key names with their counts", () => {
    const out = projectMatchKeys([
      { value: "em", count: 1200 },
      { value: "ph", count: 340 },
      { value: "fbp", count: 4102 },
    ]);
    expect(out.present).toEqual([
      { key: "em", count: 1200 },
      { key: "ph", count: 340 },
      { key: "fbp", count: 4102 },
    ]);
    expect(out.unrecognised).toBe(0);
  });

  it("reads the nested { data: [...] } shape the stats edge also returns", () => {
    const out = projectMatchKeys([
      { data: [{ value: "external_id", count: 7 }, { value: "ct", count: 9 }] },
    ]);
    expect(out.present).toEqual([
      { key: "external_id", count: 7 },
      { key: "ct", count: 9 },
    ]);
  });

  it("treats a missing or non-numeric count as zero rather than dropping the key", () => {
    const out = projectMatchKeys([{ value: "em" }, { value: "ph", count: "many" as never }]);
    expect(out.present).toEqual([{ key: "em", count: 0 }, { key: "ph", count: 0 }]);
  });

  it("NEVER echoes an unrecognised value — it counts it and drops the content", () => {
    const out = projectMatchKeys([
      { value: "em", count: 5 },
      { value: "someone@example.com", count: 1 },
      { value: { em: "a8f5f167e2…", ph: "+15551234567" } as never, count: 1 },
      { value: "+15551234567", count: 1 },
    ]);
    expect(out.present).toEqual([{ key: "em", count: 5 }]);
    expect(out.unrecognised).toBe(3);

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("15551234567");
    expect(serialized).not.toContain("a8f5f167e2");
  });

  it("survives an empty or absent aggregation without throwing", () => {
    expect(projectMatchKeys([])).toEqual({ present: [], unrecognised: 0 });
    expect(projectMatchKeys(undefined as never)).toEqual({ present: [], unrecognised: 0 });
  });
});

describe("orderByEvidence / confusableNames", () => {
  const live = { pixel_id: "7411390000000001", name: "Main", total_events_in_window: 2411, server_events_in_window: 600, last_fired_age_days: 0 };
  const decoy = { pixel_id: "7412019000000002", name: "7411390000000001", total_events_in_window: 0, server_events_in_window: 0, last_fired_age_days: null };
  const stale = { pixel_id: "7413110000000003", name: "Old", total_events_in_window: 0, server_events_in_window: 0, last_fired_age_days: 40 };

  it("puts the pixel that is firing first, so a cut list keeps the informative row", () => {
    const out = orderByEvidence([decoy, stale, live].map((p) => ({ ...p })));
    expect(out[0].pixel_id).toBe("7411390000000001");
  });

  it("breaks a tie on server events, then on recency", () => {
    const a = { pixel_id: "a", name: null, total_events_in_window: 10, server_events_in_window: 0, last_fired_age_days: 1 };
    const b = { pixel_id: "b", name: null, total_events_in_window: 10, server_events_in_window: 5, last_fired_age_days: 9 };
    expect(orderByEvidence([a, b]).map((p) => p.pixel_id)).toEqual(["b", "a"]);
    const c = { pixel_id: "c", name: null, total_events_in_window: 0, server_events_in_window: 0, last_fired_age_days: 2 };
    const d = { pixel_id: "d", name: null, total_events_in_window: 0, server_events_in_window: 0, last_fired_age_days: null };
    expect(orderByEvidence([d, c]).map((p) => p.pixel_id)).toEqual(["c", "d"]);
  });

  it("names a pixel whose name is another pixel's id", () => {
    const out = confusableNames([live, decoy, stale]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("7412019000000002");
    expect(out[0]).toContain("7411390000000001");
  });

  it("says nothing when names are ordinary", () => {
    expect(confusableNames([live, stale])).toEqual([]);
  });
});

describe("aggregateEventCounts", () => {
  it("collapses hourly rows into one total per event", () => {
    const rows = [
      { start_time: "h1", data: [{ value: "PageView", count: 10 }, { value: "Purchase", count: 1 }] },
      { start_time: "h2", data: [{ value: "PageView", count: 5 }] },
      { start_time: "h3", data: [{ value: "Purchase", count: 2 }] },
    ] as never[];
    expect(aggregateEventCounts(rows)).toEqual({ PageView: 15, Purchase: 3 });
  });

  it("reads the flat value/count shape too", () => {
    expect(aggregateEventCounts([{ value: "Lead", count: 4 }] as never[])).toEqual({ Lead: 4 });
  });

  it("reads a value map", () => {
    expect(aggregateEventCounts([{ value: { PageView: 2, Lead: 1 } }] as never[])).toEqual({ PageView: 2, Lead: 1 });
  });

  it("keeps an absent event ABSENT, so 'Purchase never fired' stays checkable", () => {
    const out = aggregateEventCounts([{ value: "PageView", count: 9 }] as never[]);
    expect(out.Purchase).toBeUndefined();
    expect(Object.keys(out)).toEqual(["PageView"]);
  });

  it("is small enough that three pixels fit the budget", () => {
    const hourly = Array.from({ length: 720 }, () => ({ data: [{ value: "PageView", count: 3 }, { value: "Purchase", count: 1 }] })) as never[];
    const raw = JSON.stringify(hourly);
    const agg = JSON.stringify(aggregateEventCounts(hourly));
    expect(raw.length).toBeGreaterThan(8 * 1024);
    expect(agg.length).toBeLessThan(120);
  });
});

it("projectMatchKeys sums hourly rows instead of listing one entry per hour", () => {
  const hourly = Array.from({ length: 720 }, () => ({
    data: [{ value: "em", count: 3 }, { value: "ph", count: 2 }],
  })) as never[];
  const out = projectMatchKeys(hourly);
  expect(out.present).toEqual([{ key: "em", count: 2160 }, { key: "ph", count: 1440 }]);
  expect(JSON.stringify(out).length).toBeLessThan(120);
});
