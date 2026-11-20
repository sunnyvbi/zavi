import { describe, it, expect } from "vitest";
import {
  buildMongoPipeline,
  buildPostgresRevenueSelect,
  buildMysqlRevenueSelect,
  buildMysqlDailyQuery,
  isUtcZone,
  resolveMysqlTzMode,
} from "../daily";
import type { BookingMetricConfig } from "../config";

function cfg(over: Partial<BookingMetricConfig> = {}): BookingMetricConfig {
  return {
    tenant_id: "t1",
    engine: "mongodb",
    booking_source: "orders",
    date_field: "createdAt",
    status_field: "status",
    completed_statuses: ["completed"],
    revenue_field: "amount",
    refund_field: null,
    refund_basis: "none",
    currency: "USD",
    reporting_timezone: "UTC",
    amount_unit: "dollars",
    state: "confirmed",
    confirmed_by: "u1",
    confirmed_at: new Date().toISOString(),
    ...over,
  };
}

const SINCE = new Date("2026-07-01T00:00:00Z");
const UNTIL = new Date("2026-07-08T00:00:00Z");

function centsDivideStage(pipeline: Record<string, unknown>[]) {
  return pipeline.find(
    (s) =>
      "$addFields" in s &&
      JSON.stringify((s as { $addFields: unknown }).$addFields).includes('"$divide":["$revenue",100]'),
  );
}

describe("buildMongoPipeline — native cents", () => {
  it("divides the summed revenue by 100 when amount_unit=cents", () => {
    const p = buildMongoPipeline(cfg({ amount_unit: "cents", revenue_field: "amountCents" }), SINCE, UNTIL);
    expect(centsDivideStage(p)).toBeDefined();
  });

  it("does NOT divide when amount_unit=dollars", () => {
    const p = buildMongoPipeline(cfg({ amount_unit: "dollars" }), SINCE, UNTIL);
    expect(centsDivideStage(p)).toBeUndefined();
  });

  it("does NOT divide for a count-only mapping even if amount_unit=cents", () => {
    const p = buildMongoPipeline(cfg({ amount_unit: "cents", revenue_field: null }), SINCE, UNTIL);
    expect(centsDivideStage(p)).toBeUndefined();
    const group = p.find((s) => "$group" in s) as { $group: Record<string, unknown> };
    expect(group.$group.revenue).toBeUndefined();
  });

  it("cents divide sits AFTER $group so it scales the aggregate, not per row", () => {
    const p = buildMongoPipeline(cfg({ amount_unit: "cents" }), SINCE, UNTIL);
    const groupIdx = p.findIndex((s) => "$group" in s);
    const divIdx = p.findIndex((s) => s === centsDivideStage(p));
    expect(divIdx).toBeGreaterThan(groupIdx);
  });
});

describe("buildPostgresRevenueSelect — native cents", () => {
  it("divides the summed revenue by 100.0 when amount_unit=cents", () => {
    const sel = buildPostgresRevenueSelect(cfg({ amount_unit: "cents", revenue_field: "amount_cents" }));
    expect(sel).toContain("/ 100.0");
    expect(sel).toContain("SUM(COALESCE(amount_cents,0))");
  });

  it("does NOT divide when amount_unit=dollars", () => {
    const sel = buildPostgresRevenueSelect(cfg({ amount_unit: "dollars" }));
    expect(sel).not.toContain("/ 100.0");
  });

  it("still nets refunds before the cents scale", () => {
    const sel = buildPostgresRevenueSelect(
      cfg({ amount_unit: "cents", revenue_field: "amount", refund_field: "refund", refund_basis: "booking_created_net" }),
    );
    expect(sel).toContain("- COALESCE(refund,0)");
    expect(sel).toContain("/ 100.0");
  });

  it("returns NULL revenue for a count-only mapping", () => {
    const sel = buildPostgresRevenueSelect(cfg({ revenue_field: null }));
    expect(sel).toBe("NULL::float8 AS revenue");
  });
});

describe("buildMysqlRevenueSelect — native cents", () => {
  it("divides the summed revenue by 100.0 when amount_unit=cents", () => {
    const sel = buildMysqlRevenueSelect(cfg({ amount_unit: "cents", revenue_field: "amount_cents" }));
    expect(sel).toContain("/ 100.0");
    expect(sel).toContain("SUM(COALESCE(`amount_cents`,0))");
  });

  it("does NOT divide when amount_unit=dollars", () => {
    const sel = buildMysqlRevenueSelect(cfg({ amount_unit: "dollars" }));
    expect(sel).not.toContain("/ 100.0");
  });

  it("nets refunds BEFORE the cents scale", () => {
    const sel = buildMysqlRevenueSelect(
      cfg({ amount_unit: "cents", revenue_field: "amount", refund_field: "refund", refund_basis: "booking_created_net" }),
    );
    expect(sel).toContain("- COALESCE(`refund`,0)");
    expect(sel).toContain("/ 100.0");
    expect(sel.indexOf("refund")).toBeLessThan(sel.indexOf("/ 100.0"));
  });

  it("returns NULL revenue for a count-only mapping", () => {
    const sel = buildMysqlRevenueSelect(cfg({ revenue_field: null }));
    expect(sel).toBe("NULL AS revenue");
  });
});

describe("buildMysqlDailyQuery — injection safety + params", () => {
  const S = "2026-07-01";
  const U = "2026-07-08";

  it("backtick-quotes every identifier and never interpolates raw values", () => {
    const { sql } = buildMysqlDailyQuery(cfg({ engine: "mysql" }), "named", S, U);
    expect(sql).toContain("FROM `orders`");
    expect(sql).toContain("`createdAt`");
    expect(sql).toContain("`status` IN (?)");
    expect(sql).not.toContain("2026-07-01");
    expect(sql).not.toContain("completed");
  });

  it("throws on a malicious identifier instead of interpolating it", () => {
    expect(() =>
      buildMysqlDailyQuery(cfg({ engine: "mysql", booking_source: "orders; DROP TABLE users" }), "utc", S, U),
    ).toThrow(/bad SQL identifier/i);
    expect(() =>
      buildMysqlDailyQuery(cfg({ engine: "mysql", revenue_field: "amount`,(SELECT 1)" }), "utc", S, U),
    ).toThrow(/bad SQL identifier/i);
  });

  it("named tz mode binds the zone FIRST, then the date bounds, then statuses", () => {
    const { sql, params } = buildMysqlDailyQuery(
      cfg({ engine: "mysql", reporting_timezone: "America/Los_Angeles" }),
      "named",
      S,
      U,
    );
    expect(sql).toContain("CONVERT_TZ(`createdAt`, '+00:00', ?)");
    expect(params).toEqual(["America/Los_Angeles", `${S} 00:00:00`, `${U} 00:00:00`, "completed"]);
  });

  it("utc fallback mode drops CONVERT_TZ and binds no tz param", () => {
    const { sql, params } = buildMysqlDailyQuery(
      cfg({ engine: "mysql", reporting_timezone: "America/Los_Angeles" }),
      "utc",
      S,
      U,
    );
    expect(sql).not.toContain("CONVERT_TZ");
    expect(sql).toContain("DATE_FORMAT(`createdAt`, '%Y-%m-%d')");
    expect(params).toEqual([`${S} 00:00:00`, `${U} 00:00:00`, "completed"]);
  });

  it("applies the cents /100.0 scale in the MySQL select", () => {
    const { sql } = buildMysqlDailyQuery(
      cfg({ engine: "mysql", amount_unit: "cents", revenue_field: "amount_cents" }),
      "utc",
      S,
      U,
    );
    expect(sql).toContain("/ 100.0");
  });

  it("carries no optimizer-hint comment (MySQL executes comment content; the session bounds time)", () => {
    const { sql } = buildMysqlDailyQuery(cfg({ engine: "mysql" }), "utc", S, U);
    expect(sql).not.toMatch(/\/\*/);
  });

  it("groups/orders by POSITION not the `day` alias (avoids MySQL alias-vs-column collision)", () => {
    const { sql } = buildMysqlDailyQuery(cfg({ engine: "mysql" }), "named", S, U);
    expect(sql).toMatch(/GROUP BY 1/);
    expect(sql).toMatch(/ORDER BY 1/);
    expect(sql).not.toMatch(/GROUP BY day/);
  });

  it("count-only mapping omits the status IN clause when no statuses", () => {
    const { sql, params } = buildMysqlDailyQuery(
      cfg({ engine: "mysql", status_field: null, completed_statuses: [], revenue_field: null }),
      "utc",
      S,
      U,
    );
    expect(sql).not.toContain(" IN (");
    expect(sql).toContain("NULL AS revenue");
    expect(params).toEqual([`${S} 00:00:00`, `${U} 00:00:00`]);
  });
});

function negClampStage(pipeline: Record<string, unknown>[]) {
  return pipeline.find(
    (s) =>
      "$addFields" in s &&
      JSON.stringify((s as { $addFields: unknown }).$addFields).includes('"$max":["$revenue",0]'),
  );
}

describe("net>gross clamp — negative revenue day is never surfaced (Finding #1)", () => {
  const netCfg = (over: Partial<BookingMetricConfig> = {}) =>
    cfg({ refund_field: "refundAmount", refund_basis: "booking_created_net", ...over });

  it("Mongo: refund-net pipeline appends a $max clamp so a negative day floors at 0", () => {
    const p = buildMongoPipeline(netCfg(), SINCE, UNTIL);
    expect(negClampStage(p)).toBeDefined();
  });

  it("Mongo: the clamp sits AFTER the $group (clamps the day aggregate, not per row)", () => {
    const p = buildMongoPipeline(netCfg(), SINCE, UNTIL);
    const groupIdx = p.findIndex((s) => "$group" in s);
    const clampIdx = p.findIndex((s) => s === negClampStage(p));
    expect(clampIdx).toBeGreaterThan(groupIdx);
  });

  it("Mongo: cents + refund-net clamps AFTER the /100 divide (max(revenue/100, 0))", () => {
    const p = buildMongoPipeline(netCfg({ amount_unit: "cents", revenue_field: "amountCents" }), SINCE, UNTIL);
    const divIdx = p.findIndex((s) => s === centsDivideStage(p));
    const clampIdx = p.findIndex((s) => s === negClampStage(p));
    expect(divIdx).toBeGreaterThan(-1);
    expect(clampIdx).toBeGreaterThan(divIdx);
  });

  it("Mongo: ALSO clamps a plain no-refund mapping (invariant: per-day revenue is never <0; a signed revenue field could still net negative — codex)", () => {
    const p = buildMongoPipeline(cfg({ refund_field: null, refund_basis: "none" }), SINCE, UNTIL);
    expect(negClampStage(p)).toBeDefined();
  });

  it("Mongo: NO clamp for a count-only mapping (there is no revenue field to floor)", () => {
    const p = buildMongoPipeline(cfg({ revenue_field: null }), SINCE, UNTIL);
    expect(negClampStage(p)).toBeUndefined();
  });

  it("Postgres: refund-net select wraps the day aggregate in GREATEST(..., 0)", () => {
    const sel = buildPostgresRevenueSelect(netCfg({ revenue_field: "amount", refund_field: "refund" }));
    expect(sel).toContain("GREATEST(");
    expect(sel).toContain("- COALESCE(refund,0)");
    expect(sel.indexOf("GREATEST(")).toBeLessThan(sel.indexOf("- COALESCE(refund,0)"));
  });

  it("Postgres: ALSO clamps a plain no-refund mapping (a signed revenue field can still net negative — codex)", () => {
    expect(buildPostgresRevenueSelect(cfg({ refund_field: null, refund_basis: "none" }))).toContain("GREATEST(");
  });

  it("Postgres: count-only mapping is still exactly 'NULL::float8 AS revenue' (no clamp on null revenue)", () => {
    expect(buildPostgresRevenueSelect(cfg({ revenue_field: null }))).toBe("NULL::float8 AS revenue");
  });

  it("Postgres: cents + refund-net keeps /100.0 AND the GREATEST clamp", () => {
    const sel = buildPostgresRevenueSelect(
      netCfg({ amount_unit: "cents", revenue_field: "amount", refund_field: "refund" }),
    );
    expect(sel).toContain("/ 100.0");
    expect(sel).toContain("GREATEST(");
  });

  it("MySQL: refund-net select wraps the day aggregate in GREATEST(..., 0)", () => {
    const sel = buildMysqlRevenueSelect(netCfg({ revenue_field: "amount", refund_field: "refund" }));
    expect(sel).toContain("GREATEST(");
    expect(sel).toContain("- COALESCE(`refund`,0)");
  });

  it("MySQL: ALSO clamps a plain no-refund mapping (a signed revenue field can still net negative — codex)", () => {
    expect(buildMysqlRevenueSelect(cfg({ refund_field: null, refund_basis: "none" }))).toContain("GREATEST(");
  });

  it("MySQL: count-only mapping is still exactly 'NULL AS revenue' (no clamp on null revenue)", () => {
    expect(buildMysqlRevenueSelect(cfg({ revenue_field: null, refund_field: "refund", refund_basis: "booking_created_net" }))).toBe(
      "NULL AS revenue",
    );
  });

  it("clamp semantics: GREATEST(negativeDaySum, 0) === 0 (documents the floor)", () => {
    const daySumNegative = 40 - 250;
    expect(Math.max(daySumNegative, 0)).toBe(0);
    const daySumPositive = 5000 - 120;
    expect(Math.max(daySumPositive, 0)).toBe(daySumPositive);
  });
});

describe("isUtcZone", () => {
  it("treats canonical UTC spellings as UTC", () => {
    for (const z of ["", "UTC", "Etc/UTC", "+00:00", "Z"]) {
      expect(isUtcZone(z)).toBe(true);
    }
  });
  it("treats any real offset zone as NON-UTC", () => {
    for (const z of ["America/Los_Angeles", "Europe/London", "Asia/Kolkata"]) {
      expect(isUtcZone(z)).toBe(false);
    }
  });
});

describe("resolveMysqlTzMode — the money-adjacent tz gate", () => {
  type ProbeConn = Parameters<typeof resolveMysqlTzMode>[0];
  const fakeConn = (probeResult: unknown, throws = false) => {
    const obj = {
      calls: 0,
      q: (async () => {
        obj.calls += 1;
        if (throws) throw new Error("probe boom");
        return [{ c: probeResult }];
      }) as ProbeConn,
    };
    return obj;
  };
  const asConn = (c: ReturnType<typeof fakeConn>) => c.q;

  it("UTC zone resolves to 'utc' WITHOUT probing the server", async () => {
    const conn = fakeConn(null);
    const r = await resolveMysqlTzMode(asConn(conn), "UTC");
    expect(r).toBe("utc");
    expect(conn.calls).toBe(0);
  });

  it("named zone with tz tables loaded (probe non-null) resolves to 'named'", async () => {
    const conn = fakeConn("2020-06-01 05:00:00");
    const r = await resolveMysqlTzMode(asConn(conn), "America/Los_Angeles");
    expect(r).toBe("named");
    expect(conn.calls).toBe(1);
  });

  it("named zone WITHOUT tz tables (probe NULL) GATES to 'unsupported' — never UTC", async () => {
    const conn = fakeConn(null);
    const r = await resolveMysqlTzMode(asConn(conn), "America/Los_Angeles");
    expect(r).toBe("unsupported");
  });

  it("probe error on a non-UTC zone GATES to 'unsupported'", async () => {
    const conn = fakeConn(null, true);
    const r = await resolveMysqlTzMode(asConn(conn), "Europe/London");
    expect(r).toBe("unsupported");
  });
});
