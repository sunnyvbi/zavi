
import { describe, it, expect } from "vitest";
import {
  METRIC_REGISTRY,
  classifyGoalMetricKey,
  type MetricDef,
} from "../metric-registry";
import { classifyMetricMode } from "@/services/autopilot/goal-metric-vocab";

const DIRECTIONS = ["up", "down", "context"] as const;
const UNITS = ["count", "usd", "ratio"] as const;
const WINDOW_KINDS = ["rolling_7d", "day", "calendar_week", "point"] as const;
const SOURCES = ["operator_db", "meta_ads", "google_ads", "stripe", "native_funnel"] as const;

describe("METRIC_REGISTRY shape", () => {
  it("contains exactly the registered metrics", () => {
    expect(Object.keys(METRIC_REGISTRY).sort()).toEqual([
      "ads_cpa_7d",
      "ads_spend_7d",
      "google_ads_cpa_7d",
      "google_ads_spend_7d",
      "stripe_mrr",
      "weekly_bookings",
      "weekly_signups",
    ]);
  });

  it("every metric's source is in RELEVANT_CONNECTOR_SLUGS — i.e. REACHABLE", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "..", "workers", "functions", "metric-sweep.ts"),
      "utf-8",
    );
    const m = src.match(/RELEVANT_CONNECTOR_SLUGS = \[([^\]]*)\]/);
    expect(m, "RELEVANT_CONNECTOR_SLUGS not found").not.toBeNull();
    const gated = new Set([...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
    const unreachable = Object.values(METRIC_REGISTRY)
      .filter((d) => !gated.has(d.source))
      .map((d) => `${d.key} (source: ${d.source})`);
    expect(unreachable, "these metrics can never be measured").toEqual([]);
  });

  it("every metric has a collector in metric-sweep", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "..", "workers", "functions", "metric-sweep.ts"),
      "utf-8",
    );
    for (const key of Object.keys(METRIC_REGISTRY)) {
      expect(src, `no measureOne case for ${key}`).toContain(`case "${key}"`);
    }
  });

  it("every def is valid and self-keyed", () => {
    for (const [key, def] of Object.entries(METRIC_REGISTRY)) {
      expect(def.key, `${key}.key must equal its record key`).toBe(key);
      expect(def.label.length, `${key}.label non-empty`).toBeGreaterThan(0);
      expect(DIRECTIONS).toContain(def.direction);
      expect(UNITS).toContain(def.unit);
      expect(WINDOW_KINDS).toContain(def.window_kind);
      expect(SOURCES).toContain(def.source);
    }
  });

  it("pins the exact contract attributes for each metric", () => {
    const expectAttrs = (
      key: string,
      direction: MetricDef["direction"],
      unit: MetricDef["unit"],
      window_kind: MetricDef["window_kind"],
      source: MetricDef["source"],
    ) => {
      const def = METRIC_REGISTRY[key];
      expect(def, `${key} must exist`).toBeDefined();
      expect({ direction: def.direction, unit: def.unit, window_kind: def.window_kind, source: def.source }).toEqual(
        { direction, unit, window_kind, source },
      );
    };
    expectAttrs("weekly_signups", "up", "count", "rolling_7d", "operator_db");
    expectAttrs("weekly_bookings", "up", "count", "rolling_7d", "operator_db");
    expectAttrs("ads_spend_7d", "context", "usd", "rolling_7d", "meta_ads");
    expectAttrs("ads_cpa_7d", "down", "usd", "rolling_7d", "meta_ads");
    expectAttrs("stripe_mrr", "up", "usd", "point", "stripe");
  });
});

describe("classifyGoalMetricKey", () => {
  const cases: Array<[string, string | null]> = [
    ["signups", "weekly_signups"],
    ["weekly sign-ups", "weekly_signups"],
    ["new users", "weekly_signups"],
    ["registrations", "weekly_signups"],
    ["bookings", "weekly_bookings"],
    ["trips per week", "weekly_bookings"],
    ["reservations", "weekly_bookings"],
    ["orders", null],
    ["mrr", "stripe_mrr"],
    ["MRR", "stripe_mrr"],
    ["monthly revenue", null],
    ["GMV", null],
    ["Sign_Ups", "weekly_signups"],
    ["book-ings", "weekly_bookings"],
    ["cac", null],
    ["conversion rate", null],
    ["activation_rate", null],
    ["Activation rate", null],
    ["signup conversion %", null],
    ["activations", null],
    ["nps", null],
    ["hhhhh", null],
    ["", null],
  ];

  it.each(cases)("%j -> %j", (input, expected) => {
    expect(classifyGoalMetricKey(input)).toBe(expected);
  });

  it("stays in lockstep with classifyMetricMode for mapped families", () => {
    for (const metric of ["signups", "bookings", "mrr", "arr"]) {
      expect(classifyGoalMetricKey(metric)).not.toBeNull();
      expect(classifyMetricMode(metric)).toBe("auto");
    }
  });
});
