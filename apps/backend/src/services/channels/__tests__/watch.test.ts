
import { describe, it, expect } from "vitest";
import {
  evaluateWatch,
  runWatchProbes,
  type MetricSnapshotRow,
  type WatchBlock,
} from "../watch";

const row = (
  key: string,
  value: number | null,
  window_end: string,
  status: "measured" | "unavailable" = "measured",
): MetricSnapshotRow => ({ metric_key: key, value, window_end, status });

const META: WatchBlock = {
  signals: [
    { key: "ads_spend_7d", compare: "pct_change", threshold: 15 },
    { key: "ads_cpa_7d", compare: "pct_change", threshold: 20 },
  ],
  trip: "any",
};

const LAST_RUN = new Date("2026-09-01T00:00:00Z");

describe("evaluateWatch — the baseline is anchored in time, not 'the previous row'", () => {
  it("compares against the last run, NOT yesterday", () => {
    const rows = [
      row("ads_spend_7d", 1000, "2026-08-25T00:00:00Z"),
      row("ads_spend_7d", 1010, "2026-08-31T00:00:00Z"),
      row("ads_spend_7d", 1020, "2026-09-03T00:00:00Z"),
      row("ads_spend_7d", 1300, "2026-09-04T00:00:00Z"),
    ];
    const v = evaluateWatch({ ...META, signals: [META.signals[0]] }, rows, LAST_RUN);
    const s = v.signals[0];
    expect(s.prev).toBe(1010);
    expect(s.now).toBe(1300);
    expect(Math.round(s.delta!)).toBe(29);
    expect(v.verdict).toBe("changed");
  });

  it("evaluates each key against its OWN rows, never across keys", () => {
    const rows = [
      row("ads_spend_7d", 1000, "2026-08-30T00:00:00Z"),
      row("ads_cpa_7d", 50, "2026-08-31T00:00:00Z"),
      row("ads_spend_7d", 1005, "2026-09-03T00:00:00Z"),
      row("ads_cpa_7d", 51, "2026-09-04T00:00:00Z"),
    ];
    const v = evaluateWatch(META, rows, LAST_RUN);
    const spend = v.signals.find((s) => s.key === "ads_spend_7d")!;
    const cpa = v.signals.find((s) => s.key === "ads_cpa_7d")!;
    expect([spend.prev, spend.now]).toEqual([1000, 1005]);
    expect([cpa.prev, cpa.now]).toEqual([50, 51]);
    expect(v.verdict).toBe("unchanged");
  });
});

describe("evaluateWatch — thresholds", () => {
  it("trips on `any` when one signal crosses", () => {
    const rows = [
      row("ads_spend_7d", 1000, "2026-08-30T00:00:00Z"),
      row("ads_spend_7d", 1010, "2026-09-04T00:00:00Z"),
      row("ads_cpa_7d", 50, "2026-08-30T00:00:00Z"),
      row("ads_cpa_7d", 70, "2026-09-04T00:00:00Z"),
    ];
    expect(evaluateWatch(META, rows, LAST_RUN).verdict).toBe("changed");
  });

  it("requires every evaluable signal on `all`", () => {
    const rows = [
      row("ads_spend_7d", 1000, "2026-08-30T00:00:00Z"),
      row("ads_spend_7d", 1010, "2026-09-04T00:00:00Z"),
      row("ads_cpa_7d", 50, "2026-08-30T00:00:00Z"),
      row("ads_cpa_7d", 70, "2026-09-04T00:00:00Z"),
    ];
    expect(evaluateWatch({ ...META, trip: "all" }, rows, LAST_RUN).verdict).toBe("unchanged");
  });

  it("trips on a DROP, not just a rise", () => {
    const rows = [
      row("ads_spend_7d", 1000, "2026-08-30T00:00:00Z"),
      row("ads_spend_7d", 400, "2026-09-04T00:00:00Z"),
    ];
    const v = evaluateWatch({ ...META, signals: [META.signals[0]] }, rows, LAST_RUN);
    expect(v.verdict).toBe("changed");
    expect(v.signals[0].delta).toBeLessThan(0);
  });
});

describe("evaluateWatch — the states that must not read as 'no change'", () => {
  it("first observation is unavailable, not unchanged", () => {
    const rows = [row("ads_spend_7d", 1000, "2026-09-04T00:00:00Z")];
    const v = evaluateWatch({ ...META, signals: [META.signals[0]] }, rows, LAST_RUN);
    expect(v.verdict).toBe("unavailable");
    expect(v.signals[0].reason).toBe("no_baseline");
  });

  it("a channel that never ran has no baseline", () => {
    const rows = [
      row("ads_spend_7d", 1000, "2026-08-30T00:00:00Z"),
      row("ads_spend_7d", 2000, "2026-09-04T00:00:00Z"),
    ];
    expect(evaluateWatch(META, rows, null).verdict).toBe("unavailable");
  });

  it("status='unavailable' is not a zero", () => {
    const rows = [
      row("ads_spend_7d", null, "2026-08-30T00:00:00Z", "unavailable"),
      row("ads_spend_7d", 1000, "2026-09-04T00:00:00Z"),
    ];
    const v = evaluateWatch({ ...META, signals: [META.signals[0]] }, rows, LAST_RUN);
    expect(v.verdict).toBe("unavailable");
    expect(v.signals[0].reason).toBe("unavailable");
  });

  it("a zero baseline does not divide by zero or trip on Infinity", () => {
    const rows = [
      row("ads_spend_7d", 0, "2026-08-30T00:00:00Z"),
      row("ads_spend_7d", 500, "2026-09-04T00:00:00Z"),
    ];
    const v = evaluateWatch({ ...META, signals: [META.signals[0]] }, rows, LAST_RUN);
    expect(v.signals[0].reason).toBe("zero_baseline");
    expect(v.signals[0].tripped).toBe(false);
    expect(v.verdict).toBe("unavailable");
  });

  it("`signals: []` is legal and renders nothing", () => {
    const v = evaluateWatch({ signals: [], trip: "any" }, [], LAST_RUN);
    expect(v.verdict).toBe("unavailable");
    expect(v.reason).toBe("no_signals_declared");
  });

  it("an unavailable signal cannot mask a real move in another", () => {
    const rows = [
      row("ads_spend_7d", null, "2026-08-30T00:00:00Z", "unavailable"),
      row("ads_spend_7d", null, "2026-09-04T00:00:00Z", "unavailable"),
      row("ads_cpa_7d", 50, "2026-08-30T00:00:00Z"),
      row("ads_cpa_7d", 80, "2026-09-04T00:00:00Z"),
    ];
    expect(evaluateWatch({ ...META, trip: "all" }, rows, LAST_RUN).verdict).toBe("changed");
  });
});

describe("the watch block survives the recipe delta merge", () => {
  it("meta_ads declares real signals and they reach loadChannelRecipe", async () => {
    const { loadChannelRecipe } = await import("../recipe");
    const watch = loadChannelRecipe("meta_ads").meta.watch;
    expect(watch).toBeDefined();
    expect(watch!.signals.map((s) => s.key).sort()).toEqual(["ads_cpa_7d", "ads_spend_7d"]);
    expect(watch!.trip).toBe("any");
  });

  it("every watched key exists in the metric registry", async () => {
    const { loadChannelRecipe, listRecipeSlugs } = await import("../recipe");
    const { METRIC_REGISTRY } = await import("@/services/analytics/metric-registry");
    const known = new Set(Object.keys(METRIC_REGISTRY));
    const bad: string[] = [];
    for (const slug of listRecipeSlugs()) {
      for (const s of loadChannelRecipe(slug).meta.watch?.signals ?? []) {
        if (!known.has(s.key)) bad.push(`${slug}: ${s.key}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("runWatchProbes — the per-tenant pass", () => {
  const NOW = new Date("2026-09-05T07:00:00Z");

  function deps(over: Partial<Parameters<typeof runWatchProbes>[0]> = {}) {
    const writes: Array<[string, string, unknown]> = [];
    const base = {
      channelStates: async () => [
        { channel_slug: "meta_ads", last_run_at: "2026-09-01T00:00:00Z" },
        { channel_slug: "seo", last_run_at: "2026-09-01T00:00:00Z" },
      ],
      snapshots: async () => [
        row("ads_spend_7d", 1000, "2026-08-30T00:00:00Z"),
        row("ads_spend_7d", 2000, "2026-09-04T00:00:00Z"),
      ],
      write: async (slug: string, at: string, delta: unknown) => {
        writes.push([slug, at, delta]);
      },
      watchFor: (slug: string) =>
        slug === "meta_ads"
          ? { signals: [{ key: "ads_spend_7d", compare: "pct_change" as const, threshold: 15 }], trip: "any" as const }
          : null,
    };
    return { deps: { ...base, ...over }, writes };
  }

  it("probes only channels that declare a watch block", async () => {
    const { deps: d, writes } = deps();
    const out = await runWatchProbes(d, NOW);
    expect(out).toEqual({ probed: 1, changed: 1, unavailable: 0 });
    expect(writes.map((w) => w[0])).toEqual(["meta_ads"]);
  });

  it("writes even when the verdict is unavailable", async () => {
    const { deps: d, writes } = deps({ snapshots: async () => [] });
    const out = await runWatchProbes(d, NOW);
    expect(out.unavailable).toBe(1);
    expect(writes).toHaveLength(1);
  });

  it("reads snapshots ONCE for all watched keys, not once per channel", async () => {
    let calls = 0;
    const { deps: d } = deps({
      channelStates: async () => [
        { channel_slug: "meta_ads", last_run_at: "2026-09-01T00:00:00Z" },
        { channel_slug: "google_ads", last_run_at: "2026-09-01T00:00:00Z" },
      ],
      watchFor: () => ({
        signals: [{ key: "ads_spend_7d", compare: "pct_change" as const, threshold: 15 }],
        trip: "any" as const,
      }),
      snapshots: async () => {
        calls += 1;
        return [
          row("ads_spend_7d", 1000, "2026-08-30T00:00:00Z"),
          row("ads_spend_7d", 1001, "2026-09-04T00:00:00Z"),
        ];
      },
    });
    await runWatchProbes(d, NOW);
    expect(calls).toBe(1);
  });

  it("does nothing when no channel is watched", async () => {
    const { deps: d, writes } = deps({ watchFor: () => null });
    expect(await runWatchProbes(d, NOW)).toEqual({ probed: 0, changed: 0, unavailable: 0 });
    expect(writes).toHaveLength(0);
  });
});

describe("evaluateWatch — one observation is not a comparison", () => {
  it("reports same_window instead of a confident 'No change'", () => {
    const rows = [row("ads_spend_7d", 1000, "2026-09-05T05:00:00Z")];
    const v = evaluateWatch(
      { signals: [{ key: "ads_spend_7d", compare: "pct_change", threshold: 15 }], trip: "any" },
      rows,
      new Date("2026-09-05T06:00:00Z"),
    );
    expect(v.signals[0].reason).toBe("same_window");
    expect(v.verdict).toBe("unavailable");
    expect(v.verdict).not.toBe("unchanged");
  });

  it("still reports a real unchanged when there ARE two observations", () => {
    const rows = [
      row("ads_spend_7d", 1000, "2026-09-04T05:00:00Z"),
      row("ads_spend_7d", 1001, "2026-09-05T05:00:00Z"),
    ];
    const v = evaluateWatch(
      { signals: [{ key: "ads_spend_7d", compare: "pct_change", threshold: 15 }], trip: "any" },
      rows,
      new Date("2026-09-04T18:00:00Z"),
    );
    expect(v.verdict).toBe("unchanged");
    expect(v.signals[0].reason).toBeUndefined();
  });

  it("carries the window ends so the UI can show the denominator", () => {
    const rows = [
      row("ads_spend_7d", 1000, "2026-09-04T05:00:00Z"),
      row("ads_spend_7d", 1300, "2026-09-05T05:00:00Z"),
    ];
    const v = evaluateWatch(
      { signals: [{ key: "ads_spend_7d", compare: "pct_change", threshold: 15 }], trip: "any" },
      rows,
      new Date("2026-09-04T18:00:00Z"),
    );
    expect(v.signals[0].prev_at).toBe("2026-09-04T05:00:00Z");
    expect(v.signals[0].now_at).toBe("2026-09-05T05:00:00Z");
  });
});
