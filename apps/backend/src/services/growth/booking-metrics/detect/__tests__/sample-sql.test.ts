import { describe, it, expect } from "vitest";
import { buildSketch, collectSketches } from "../sample-sql";

describe("buildSketch (pure sketch-building)", () => {
  it("populates numeric_stats from a pg numeric column returned as STRINGS", () => {
    const s = buildSketch(
      "orders",
      1000,
      [
        { name: "id", type: "integer" },
        { name: "total_amount", type: "numeric" },
      ],
      [
        { id: 1, total_amount: "89.00" },
        { id: 2, total_amount: "150.50" },
        { id: 3, total_amount: "0" },
        { id: 4, total_amount: "42.00" },
      ],
    );
    const rev = s.fields.find((f) => f.path === "total_amount");
    expect(rev?.types).toContain("number");
    expect(rev?.numeric_stats).toEqual({ min: 0, max: 150.5, nonzero_frac: 0.75 });
    expect(s.collection).toBe("orders");
    expect(s.approx_count).toBe(1000);
  });

  it("treats low-cardinality string columns as status_candidates with distribution", () => {
    const s = buildSketch(
      "bookings",
      50,
      [{ name: "status", type: "text" }],
      [
        { status: "completed" },
        { status: "completed" },
        { status: "cancelled" },
        { status: "pending" },
      ],
    );
    const sc = s.status_candidates.find((c) => c.path === "status");
    expect(sc).toBeDefined();
    expect(sc?.values[0]).toEqual({ value: "completed", count: 2 });
    expect(sc?.values.map((v) => v.value).sort()).toEqual(["cancelled", "completed", "pending"]);
  });

  it("does NOT treat a numeric column (pg string values) as a status candidate", () => {
    const s = buildSketch(
      "orders",
      10,
      [{ name: "price", type: "numeric" }],
      [{ price: "89.00" }, { price: "150.50" }],
    );
    expect(s.status_candidates.find((c) => c.path === "price")).toBeUndefined();
  });

  it("labels a date/timestamp column as a date field and redacts the example to YYYY-MM-DD", () => {
    const d = new Date("2026-07-04T12:34:56Z");
    const s = buildSketch(
      "trips",
      5,
      [{ name: "created_at", type: "timestamp with time zone" }],
      [{ created_at: d }],
    );
    const f = s.fields.find((x) => x.path === "created_at");
    expect(f?.types).toContain("date");
    expect(f?.examples).toEqual(["2026-07-04"]);
  });

  it("summarizes object/array (JSON) values instead of dumping them", () => {
    const s = buildSketch(
      "orders",
      1,
      [{ name: "meta", type: "jsonb" }],
      [{ meta: { a: 1, b: 2 } }],
    );
    const f = s.fields.find((x) => x.path === "meta");
    expect(String(f?.examples[0])).toMatch(/^\{obj:/);
  });

  it("drops columns whose names aren't bare identifiers (unusable downstream)", () => {
    const s = buildSketch(
      "orders",
      1,
      [
        { name: "total", type: "numeric" },
        { name: "weird col", type: "text" },
        { name: 'has"quote', type: "text" },
      ],
      [{ total: "10", "weird col": "x", 'has"quote': "y" }],
    );
    expect(s.fields.map((f) => f.path)).toEqual(["total"]);
  });

  it("does NOT misclassify interval/point columns as numeric (anchored regex)", () => {
    const s = buildSketch(
      "events",
      1,
      [
        { name: "duration", type: "interval" },
        { name: "loc", type: "point" },
        { name: "amt", type: "integer" },
      ],
      [{ duration: "1 day", loc: "(1,2)", amt: 5 }],
    );
    expect(s.fields.find((f) => f.path === "duration")?.types).not.toContain("number");
    expect(s.fields.find((f) => f.path === "loc")?.types).not.toContain("number");
    expect(s.fields.find((f) => f.path === "amt")?.types).toContain("number");
  });

  it("produces a CollectionSketch-shaped object with the expected keys", () => {
    const s = buildSketch(
      "orders",
      1200,
      [
        { name: "total", type: "numeric" },
        { name: "status", type: "text" },
      ],
      [
        { total: "89.00", status: "completed" },
        { total: "0", status: "cancelled" },
      ],
    );
    expect(Object.keys(s).sort()).toEqual(["approx_count", "collection", "fields", "status_candidates"]);
    expect(s.collection).toBe("orders");
    expect(s.approx_count).toBe(1200);
    expect(Array.isArray(s.fields)).toBe(true);
    expect(Array.isArray(s.status_candidates)).toBe(true);
    const total = s.fields.find((f) => f.path === "total");
    expect(Object.keys(total ?? {}).sort()).toEqual(["examples", "numeric_stats", "path", "types"]);
    expect(total?.numeric_stats).toEqual({ min: 0, max: 89, nonzero_frac: 0.5 });
  });

  it("caps examples per field and ranks signal-bearing fields first", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      noise: `x${i}`,
      total: String(i + 1),
    }));
    const s = buildSketch(
      "sales",
      10,
      [
        { name: "noise", type: "text" },
        { name: "total", type: "numeric" },
      ],
      rows,
    );
    expect(s.fields[0].path).toBe("total");
    expect(s.fields.find((f) => f.path === "total")?.examples.length).toBeLessThanOrEqual(4);
  });
});

function fakeQueryable(opts: { sample: Record<string, Array<Record<string, unknown>>>; onSample?: (sql: string) => void }) {
  return {
    async query(sql: string) {
      opts.onSample?.(sql);
      const m = sql.match(/FROM "([a-zA-Z0-9_]+)"|FROM `([a-zA-Z0-9_]+)`/);
      const t = m?.[1] ?? m?.[2] ?? "";
      return { rows: opts.sample[t] ?? [] };
    },
  };
}
const table = (name: string, rowEstimate: number, columns: Array<{ name: string; type: string }> = []) => ({
  name,
  rowEstimate,
  columns: columns.map((c) => ({ ...c, nullable: true })),
});

describe("collectSketches (visible catalog + mocked session)", () => {
  it("shortlists txn-named tables first and samples only the visible columns, no schema prefix", async () => {
    const sampled: string[] = [];
    const q = fakeQueryable({
      sample: {
        orders: [
          { id: "1", total: "49.99", status: "paid", placed_at: new Date("2026-01-02T00:00:00Z") },
          { id: "2", total: "0", status: "refunded", placed_at: new Date("2026-01-03T00:00:00Z") },
        ],
      },
      onSample: (sql) => sampled.push(sql),
    });
    const catalog = {
      tables: [
        table("users", 5000, [{ name: "id", type: "bigint" }]),
        table("orders", 1200, [
          { name: "id", type: "bigint" },
          { name: "total", type: "numeric" },
          { name: "status", type: "text" },
          { name: "placed_at", type: "timestamptz" },
        ]),
        table("audit_log", 999999, [{ name: "id", type: "bigint" }]),
      ],
    };
    const { sketches, skipped } = await collectSketches(q, catalog, "postgres");
    const orders = sketches.find((s) => s.collection === "orders");
    expect(orders?.fields.map((f) => f.path).sort()).toEqual(["id", "placed_at", "status", "total"]);
    expect(sampled[0]).toBe('SELECT "id", "total", "status", "placed_at" FROM "orders" ORDER BY random() LIMIT 60');
    expect(sampled.some((s) => /SELECT \*/.test(s) || /public/.test(s))).toBe(false);
    expect(skipped).toEqual(expect.arrayContaining(["users: no rows", "audit_log: no rows"]));
  });

  it("skips unsafe table names — they are never interpolated into a sample query", async () => {
    const sampled: string[] = [];
    const q = fakeQueryable({ sample: { bookings: [{ id: 1 }] }, onSample: (sql) => sampled.push(sql) });
    const catalog = { tables: [table("orders; DROP TABLE users; --", 10, [{ name: "id", type: "int" }]), table("bookings", 20, [{ name: "id", type: "int" }])] };
    const { sketches } = await collectSketches(q, catalog, "postgres");
    expect(sketches.map((s) => s.collection)).toEqual(["bookings"]);
    expect(sampled.some((s) => s.includes("DROP TABLE"))).toBe(false);
  });

  it("falls back to a plain LIMIT sample when the random sample throws (timeout)", async () => {
    let calls = 0;
    const q = {
      async query(sql: string) {
        if (/ORDER BY random\(\)/.test(sql)) {
          calls++;
          throw new Error("canceling statement due to statement timeout");
        }
        return { rows: [{ id: 7 }] };
      },
    };
    const { sketches } = await collectSketches(q, { tables: [table("trips", 3, [{ name: "id", type: "int" }])] }, "postgres");
    expect(calls).toBe(1);
    expect(sketches.find((s) => s.collection === "trips")?.fields[0].path).toBe("id");
  });

  it("a refused sample is an explicit skip reason, not a silent drop", async () => {
    const q = {
      async query() {
        throw Object.assign(new Error("Refused by a data-access rule: trips is not a table Zavi may read."), { code: "data_access_refused" });
      },
    };
    const { sketches, skipped } = await collectSketches(q, { tables: [table("trips", 3, [{ name: "id", type: "int" }])] }, "mysql");
    expect(sketches).toEqual([]);
    expect(skipped[0]).toMatch(/^trips: refused/);
  });
});
