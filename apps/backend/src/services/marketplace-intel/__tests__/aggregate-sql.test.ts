import { describe, expect, it, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  reads: [] as Array<{ dialect: string; sql: string[] }>,
  results: [] as unknown[][],
}));
vi.mock("@/services/tools/operator-db/codeact-sql", async (orig) => {
  const real = await orig<typeof import("@/services/tools/operator-db/codeact-sql")>();
  return {
    ...real,
    runCodeActReads: async (session: { dialect: string; tables?: string[] }, sql: string[]) => {
      const dialect = session.dialect as "postgres" | "mysql";
      const assertReads: (sql: string[], d: "postgres" | "mysql") => void = real.assertReadOnlyReads;
      assertReads(sql, dialect);
      const { guardSql, effectivePolicy } = await import("@zavi/shared/db-guard");
      const policy = effectivePolicy(
        { auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] },
        { tables: (session.tables ?? []).map((name) => ({ name, columns: [] })) },
        dialect,
      );
      for (const q of sql) {
        const g = guardSql(q, { policy, dialect });
        if (!g.ok) throw new Error(`gateway guard refused generated SQL: ${g.reason}\n${q}`);
      }
      m.reads.push({ dialect, sql });
      return m.results.shift() ?? sql.map(() => read([]));
    },
  };
});

const sess = (dialect: "postgres" | "mysql") =>
  ({ dialect, tables: ["orders", "listings", "accounts"] }) as never;

function read(rows: Record<string, unknown>[], truncated = false) {
  return { index: 0, row_count: rows.length, row_count_exact: !truncated, truncated, rows };
}

import { computeSqlRollup, dateHealthSql, geoWeekSql, locationCountsSql, quoteIdent, SQL_MAX_LOCATIONS, supplySql, totalsSupplySql, totalsWeekSql } from "../aggregate-sql";
import type { RegionMapping } from "../aggregate";
import { assertReadOnlyStatement } from "@/services/tools/operator-db/codeact-sql";
import type { LocationSource, MarketplaceIntelConfig, SupplySource } from "../contract";

const cfg = (
  dialect: "postgres" | "mysql",
  location_source: LocationSource = "order",
  supply_source: SupplySource = "listings",
  listed_at_field: string | null = null,
): MarketplaceIntelConfig => ({
  tenant_id: "t",
  dialect,
  location_source,
  supply_source,
  bookings: {
    table: "orders",
    created_at_field: "createdAt",
    geo_field: location_source === "order" ? "ship_city" : null,
    listing_ref_field: location_source === "listing" ? "listing_id" : null,
    seller_ref_field: supply_source === "sellers_on_orders" ? "seller_id" : null,
    buyer_ref_field: location_source === "user" ? "buyer_id" : null,
    gmv_proxy_field: null,
  },
  listings:
    location_source === "listing" || supply_source === "listings"
      ? { table: "listings", id_field: "id", geo_field: location_source === "none" ? null : "city", listed_at_field }
      : null,
  location_table: location_source === "user" ? { table: "accounts", id_field: "id", geo_field: "suburb" } : null,
  category: { source: "none_on_trips", note: "" },
  intent_events: { search: null, view: null, contact: null },
  provenance: { source: "self_serve_confirmed", validated: true },
});

beforeEach(() => {
  m.reads = [];
  m.results = [];
});

describe("quoteIdent", () => {
  it("quotes one identifier and doubles embedded quotes (no breakout)", () => {
    expect(quoteIdent("postgres", 'a"; DROP TABLE x; --')).toBe('"a""; DROP TABLE x; --"');
    expect(quoteIdent("mysql", "a`b")).toBe("`a``b`");
    expect(quoteIdent("postgres", "address.state")).toBe('"address.state"');
  });
  it("rejects empty and NUL", () => {
    expect(() => quoteIdent("postgres", "")).toThrow();
    expect(() => quoteIdent("mysql", "a\0b")).toThrow();
  });
});

const hex = (v: string) => Buffer.from(v, "utf8").toString("hex");
const MAPPING: RegionMapping = [
  { raw: "Lagos", key: "lagos" },
  { raw: "lagos ", key: "lagos" },
  { raw: "O'Brien; DROP TABLE x", key: "o'brien; drop table x" },
];

describe("generated SQL", () => {
  const LOCATIONS: LocationSource[] = ["order", "listing", "user", "none"];
  const SUPPLIES: SupplySource[] = ["listings", "sellers_on_orders", "none"];
  for (const dialect of ["postgres", "mysql"] as const) {
    it(`${dialect}: every location x supply combination passes the read-only statement guard`, () => {
      for (const location of LOCATIONS) {
        for (const supply of SUPPLIES) {
          for (const listedAt of [null, "created_at"]) {
            const c = cfg(dialect, location, supply, listedAt);
            expect(() => assertReadOnlyStatement(locationCountsSql(dialect, c, 13))).not.toThrow();
            expect(() => assertReadOnlyStatement(geoWeekSql(dialect, c, 13, MAPPING))).not.toThrow();
            expect(() => assertReadOnlyStatement(dateHealthSql(dialect, "orders", "createdAt"))).not.toThrow();
            for (const totals of [totalsWeekSql(dialect, c, 13), totalsSupplySql(dialect, c, 13)]) {
              if (totals) expect(() => assertReadOnlyStatement(totals)).not.toThrow();
            }
            const sup = supplySql(dialect, c, 13, MAPPING);
            if (supply === "none") expect(sup).toBeNull();
            else expect(() => assertReadOnlyStatement(sup as string)).not.toThrow();
          }
        }
      }
    });
  }

  it("postgres buckets weeks in UTC regardless of the customer DB timezone", () => {
    expect(geoWeekSql("postgres", cfg("postgres"), 13, MAPPING)).toContain(`AT TIME ZONE 'UTC'`);
  });

  it("reads dates stored as Unix seconds or milliseconds, not only date types", () => {
    for (const dialect of ["postgres", "mysql"] as const) {
      const sql = geoWeekSql(dialect, cfg(dialect), 13, MAPPING);
      expect(sql).toContain("[0-9]{13}$");
      expect(sql).toContain("[0-9]{10}$");
    }
    const health = dateHealthSql("mysql", "orders", "createdAt");
    expect(health).toContain("AS unreadable");
    expect(health).toContain("LIMIT 10000");
  });

  it("location on a listing joins the confirmed listings table as ONE row per id, ids compared as text", () => {
    const sql = geoWeekSql("postgres", cfg("postgres", "listing"), 13, MAPPING);
    expect(sql).toContain(
      `LEFT JOIN (SELECT CAST(j."id" AS text) AS jid, MIN(CAST(j."city" AS text)) AS geo FROM "listings" j GROUP BY 1) l ON l.jid = CAST(b."listing_id" AS text)`,
    );
  });

  it("location on the customer joins the confirmed customers table as one row per id on the buyer id", () => {
    const sql = geoWeekSql("mysql", cfg("mysql", "user", "sellers_on_orders"), 13, MAPPING);
    expect(sql).toContain(
      "LEFT JOIN (SELECT CAST(j.`id` AS CHAR) AS jid, MIN(CONVERT(CAST(j.`suburb` AS CHAR) USING utf8mb4) COLLATE utf8mb4_bin) AS geo FROM `accounts` j GROUP BY 1) u ON u.jid = CAST(b.`buyer_id` AS CHAR)",
    );
  });

  it("with sellers as supply the weekly count is sellers, even when the order's location comes through its listing", () => {
    const base = geoWeekSql("postgres", cfg("postgres", "listing", "sellers_on_orders"), 13, MAPPING);
    expect(base).toContain(`CAST(b."seller_id" AS text) AS active_ref`);
    expect(base).not.toContain(`CAST(b."listing_id" AS text) AS active_ref`);
  });

  it("the first read ranks orders and listings together and keeps only the busiest locations", () => {
    const sql = locationCountsSql("postgres", cfg("postgres", "order", "listings"), 13);
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain(`LIMIT ${SQL_MAX_LOCATIONS}`);
  });

  it("marketplace-wide supply is counted by the database, never grouped by region", () => {
    const sellers = cfg("postgres", "order", "sellers_on_orders");
    expect(totalsSupplySql("postgres", sellers, 13)).toContain("COUNT(DISTINCT o.seller_ref)");
    expect(totalsWeekSql("postgres", sellers, 13)).toContain("COUNT(DISTINCT o.active_ref)");
    expect(totalsWeekSql("postgres", sellers, 13)).not.toContain("__other__");
    expect(totalsSupplySql("postgres", cfg("postgres", "order", "listings"), 13)).toContain("COUNT(*)");
    expect(totalsWeekSql("postgres", cfg("postgres", "order", "none"), 13)).toBeNull();
  });

  it("the window has both ends, so a future-dated row is not a recent order", () => {
    for (const dialect of ["postgres", "mysql"] as const) {
      const sql = geoWeekSql(dialect, cfg(dialect, "order", "listings", "created_at"), 13, MAPPING);
      expect(sql.match(/>=/g)?.length).toBeGreaterThanOrEqual(1);
      expect(sql).toContain("<=");
      expect(supplySql(dialect, cfg(dialect, "order", "listings", "created_at"), 13, MAPPING)).toContain("<=");
    }
  });

  it("the second read groups by region key in the database, raw locations as hex literals", () => {
    for (const dialect of ["postgres", "mysql"] as const) {
      const c = cfg(dialect, "order", "listings");
      for (const sql of [geoWeekSql(dialect, c, 13, MAPPING), supplySql(dialect, c, 13, MAPPING) as string]) {
        expect(sql).toContain(hex("lagos "));
        expect(sql).toContain(hex("O'Brien; DROP TABLE x"));
        expect(sql).not.toContain("O'Brien");
        expect(sql).toContain(`'__no_location__'`);
        expect(sql).toContain(`ELSE '__other__' END`);
      }
    }
    expect(geoWeekSql("mysql", cfg("mysql"), 13, MAPPING)).toContain(`CONVERT(X'${hex("Lagos")}' USING utf8mb4) COLLATE utf8mb4_bin`);
  });

  it("no location puts every order in one region", () => {
    expect(geoWeekSql("postgres", cfg("postgres", "none", "none"), 13, [])).toContain(hex("All locations"));
  });

  it("supply: listings created in the window when the listing date is set; distinct sellers when supply is sellers", () => {
    const listed = supplySql("postgres", cfg("postgres", "listing", "listings", "created_at"), 13, MAPPING) as string;
    expect(listed).toContain(`CAST(l."created_at" AS text)`);
    expect(listed).toContain("WHERE");
    const sellers = supplySql("postgres", cfg("postgres", "user", "sellers_on_orders"), 13, MAPPING) as string;
    expect(sellers).toContain("COUNT(DISTINCT o.seller_ref)");
  });
});

describe("computeSqlRollup", () => {
  const healthy = [read([{ present: 10, unreadable: 0 }])];

  it("maps the first read's locations to regions and sends them into the second read (clearly-US data groups by state)", async () => {
    m.results = [
      healthy,
      [read([{ geo: "Los Angeles", n: 12 }, { geo: "Texas", n: 7 }, { geo: "CA", n: 40 }, { geo: "TX", n: 10 }, { geo: "Denver", n: 3 }])],
      [
        read([
          { geo: "CA", iso_week_year: 2026, iso_week: 36, bookings_n: "12", active_supply_n: 9 },
          { geo: "TX", iso_week_year: 2026, iso_week: 36, bookings_n: 7, active_supply_n: 5 },
        ]),
        read([
          { geo: "CA", status: "__all__", count: "40" },
          { geo: "TX", status: "__all__", count: 10 },
        ]),
        read([{ n: 47 }]),
      ],
    ];
    const { cells, supply } = await computeSqlRollup("postgres", sess("postgres"), cfg("postgres"));
    expect(m.reads.map((r) => r.sql.length)).toEqual([1, 1, 3]);
    expect(m.reads[2].sql[0]).toContain(`THEN convert_from(decode('${hex("CA")}', 'hex'), 'UTF8')`);
    expect(cells.map((c) => [c.state, c.bookings_n, c.active_supply_n])).toEqual(
      expect.arrayContaining([["CA", 12, 9], ["TX", 7, 5]]),
    );
    const ca = supply.find((s) => s.state === "CA");
    expect([ca?.total_listings, ca?.completed_listings]).toEqual([40, 40]);
    expect(supply.find((s) => s.geo_label === "__marketplace_total__")?.total_listings).toBe(47);
  });

  it("two-letter codes alone stay as written, never guessed into US states", async () => {
    m.results = [
      healthy,
      [read([{ geo: "Berlin, DE", n: 52 }, { geo: "Toronto, CA", n: 17 }])],
      [
        read([
          { geo: "berlin, de", iso_week_year: 2026, iso_week: 36, bookings_n: 12, active_supply_n: 9 },
          { geo: "toronto, ca", iso_week_year: 2026, iso_week: 36, bookings_n: 7, active_supply_n: 5 },
        ]),
        read([
          { geo: "berlin, de", status: "__all__", count: 40 },
          { geo: "toronto, ca", status: "__all__", count: 10 },
        ]),
        read([{ n: 50 }]),
      ],
    ];
    const { cells, supply } = await computeSqlRollup("mysql", sess("mysql"), cfg("mysql"));
    expect(cells.map((c) => [c.state, c.geo_label])).toEqual(
      expect.arrayContaining([[null, "Berlin, DE"], [null, "Toronto, CA"]]),
    );
    expect(supply.find((s) => s.geo_label === "Berlin, DE")?.total_listings).toBe(40);
  });

  it("a setup that measures no supply sends only the orders read", async () => {
    m.results = [
      healthy,
      [read([{ geo: "All locations", n: 9 }])],
      [read([{ geo: "all locations", iso_week_year: 2026, iso_week: 36, bookings_n: 9, active_supply_n: 0 }])],
    ];
    const { cells, supply } = await computeSqlRollup("postgres", sess("postgres"), cfg("postgres", "none", "none"));
    expect(m.reads[2].sql).toHaveLength(1);
    expect(supply).toEqual([]);
    expect(cells[0]).toMatchObject({ geo_label: "All locations", bookings_n: 9 });
  });

  it("checks the listing date too when supply counts listings created in the window", async () => {
    m.results = [[read([{ present: 10, unreadable: 0 }]), read([{ present: 10, unreadable: 0 }])]];
    await computeSqlRollup("postgres", sess("postgres"), cfg("postgres", "order", "listings", "created_at"));
    expect(m.reads[0].sql).toHaveLength(2);
    expect(m.reads[0].sql[1]).toContain(`"created_at"`);
  });

  it("fails with a date error instead of reporting no orders when most dates cannot be read", async () => {
    m.results = [[read([{ present: "10", unreadable: "5" }])]];
    await expect(computeSqlRollup("mysql", sess("mysql"), cfg("mysql"))).rejects.toThrow(/order date field are not a readable date/);
    expect(m.reads).toHaveLength(1);
  });

  it("refuses to write partial numbers when a read hit the row cap", async () => {
    m.results = [healthy, [read([{ geo: "Lagos", n: 3 }])], [read([], true), read([]), read([])]];
    await expect(computeSqlRollup("mysql", sess("mysql"), cfg("mysql"))).rejects.toThrow(/row cap/);
  });
});
