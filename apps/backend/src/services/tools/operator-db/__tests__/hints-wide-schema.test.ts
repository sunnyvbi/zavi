import { describe, it, expect, vi } from "vitest";
import { prioritizeAndCap } from "../discovery/util";
import { digest, REFINE_DIGEST_MAX_CHARS, heuristicHints } from "../discovery/hints";
import type { OperatorDbCatalog, EntityHints } from "../types";

const t = (name: string, rowEstimate: number | null = null, cols: string[] = ["id"]) => ({
  name,
  rowEstimate,
  columns: cols.map((c) => ({ name: c, type: "text", nullable: false })),
});

describe("prioritizeAndCap — size-aware", () => {
  it("keeps the BIG table when the cap is tight and names are meaningless", () => {
    const names = ["zz_a", "zz_b", "fact_txn", "zz_c"];
    const est = new Map([["zz_a", 3], ["zz_b", 11], ["fact_txn", 1_600_000], ["zz_c", 0]]);
    expect(prioritizeAndCap(names, 1, est)).toEqual(["fact_txn"]);
  });

  it("priority rank still outranks size — a small users table beats a huge log", () => {
    const est = new Map([["users", 12], ["zz_events", 90_000_000]]);
    expect(prioritizeAndCap(["zz_events", "users"], 2, est)[0]).toBe("users");
  });

  it("tables with a known estimate outrank tables with none", () => {
    const est = new Map<string, number | null>([["known", 5], ["unknown", null]]);
    expect(prioritizeAndCap(["unknown", "known"], 2, est)).toEqual(["known", "unknown"]);
  });

  it("WITHOUT estimates the ordering is exactly what it was before", () => {
    const names = ["zebra", "users", "alpha", "listings"];
    expect(prioritizeAndCap(names, 10)).toEqual(prioritizeAndCap(names, 10, new Map()));
    expect(prioritizeAndCap(names, 10)).toEqual(["users", "listings", "alpha", "zebra"]);
  });

  it("is deterministic with estimates present", () => {
    const names = ["a", "b", "c"];
    const est = new Map([["a", 5], ["b", 5], ["c", 9]]);
    expect(prioritizeAndCap(names, 3, est)).toEqual(prioritizeAndCap(names, 3, est));
    expect(prioritizeAndCap(names, 3, est)).toEqual(["c", "a", "b"]);
  });
});

describe("refine digest", () => {
  it("is far wider than the 6000 chars that showed Haiku 1.1% of a schema", () => {
    expect(REFINE_DIGEST_MAX_CHARS).toBeGreaterThanOrEqual(50_000);
  });

  it("emits the LARGEST tables first, so truncation drops the least important", () => {
    const cat = { tables: [t("small", 5), t("huge", 9_000_000), t("mid", 400)] } as OperatorDbCatalog;
    expect(digest(cat).split("\n").map((l) => l.split("(")[0])).toEqual(["huge", "mid", "small"]);
  });

  it("stays within budget, truncates on LINE boundaries, and says what it dropped", () => {
    const many = Array.from({ length: 4000 }, (_, i) =>
      t(`tbl_${i}`, 4000 - i, ["id", "created_at", "some_reasonably_long_column_name", "another_one"]),
    );
    const out = digest({ tables: many } as OperatorDbCatalog);
    expect(out.length).toBeLessThanOrEqual(REFINE_DIGEST_MAX_CHARS);
    expect(out).toMatch(/-- \d+ smaller table\(s\) omitted for length/);
    for (const line of out.split("\n")) {
      if (line.startsWith("--")) continue;
      expect(line).toMatch(/^\S+\(.*\)$/);
    }
    expect(out).toContain("tbl_0(");
    expect(out).not.toContain("tbl_3999(");
  });

  it("does not append an omission marker when everything fits", () => {
    expect(digest({ tables: [t("users", 1)] } as OperatorDbCatalog)).toBe("users(id)");
  });
});

describe("heuristicHints on legacy names", () => {
  it("still resolves nothing — which is why the tool must SAY so", () => {
    const cat = {
      tables: [t("tbl_cust_mstr", 10), t("rsv_hdr", 20), t("veh_inv", 30), t("fin_pstg", 40)],
    } as OperatorDbCatalog;
    const h = heuristicHints(cat);
    for (const role of ["users", "listings", "transactions", "bookings"]) {
      expect(h[role as keyof EntityHints]).toBeUndefined();
    }
  });

  it("resolves cleanly on conventional names (no regression)", () => {
    const cat = { tables: [t("users", 1), t("listings", 2), t("bookings", 3)] } as OperatorDbCatalog;
    const h = heuristicHints(cat);
    expect(h.users?.table).toBe("users");
    expect(h.listings?.table).toBe("listings");
    expect(h.bookings?.table).toBe("bookings");
  });
});

const state: { hints: EntityHints } = { hints: {} };
vi.mock("../catalog", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getCatalog: async () => ({
      dialect: "mysql",
      catalog: { tables: [{ name: "rsv_hdr", columns: [], rowEstimate: 5 }] },
      hints: state.hints,
      catalog_hash: "h",
      coverage: { tables_total: 1, tables_indexed: 1, skipped_unsafe_names: 0, deadline_hit: false, listing_truncated: false },
      discovery_error: null,
      updated_at: null,
    }),
    getDeclaredDialect: async () => "mysql",
    renderCatalogIndex: () => [{ name: "rsv_hdr", rows: 5 }],
    renderCatalogDigest: () => "rsv_hdr(...)",
  };
});
vi.mock("@/services/data-gateway", () => ({ loadDbAccess: async () => ({ policy: {} }), visibleCatalog: (c: unknown) => c, withAttachedDriver: async () => ({}) }));
vi.mock("../discovery/retry", () => ({ maybeRediscoverCatalog: async (_t: string, r: unknown) => r }));

const ctx = { tenant_id: "t1" } as never;

describe("operator_db_catalog — entity map state", () => {
  it("reports none_inferred and routes the agent to the generic read path", async () => {
    state.hints = { _confidence: {} };
    const { operatorDbCatalogTool } = await import("../tools");
    const res = (await operatorDbCatalogTool.execute(ctx, {})) as {
      data: { entity_map?: unknown; entity_map_note?: string; note?: string };
    };
    expect(res.data.entity_map).toBe("none_inferred");
    expect(res.data.entity_map_note).toMatch(/MAP is missing, NOT the data/);
    expect(res.data.entity_map_note).toMatch(/Do not retry the per-entity tools/);
    expect(res.data.entity_map_note).toMatch(/operator_db_codeact/);
  });

  it("lists the resolved roles when inference DID work", async () => {
    state.hints = { users: { table: "users", id_field: "id" }, _confidence: { users: 0.8 } };
    const { operatorDbCatalogTool } = await import("../tools");
    const res = (await operatorDbCatalogTool.execute(ctx, {})) as { data: { entity_map?: unknown } };
    expect(res.data.entity_map).toEqual(["users"]);
  });

  it("a blank table name does NOT count as resolved", async () => {
    state.hints = { users: { table: "", id_field: "" } };
    const { operatorDbCatalogTool } = await import("../tools");
    const res = (await operatorDbCatalogTool.execute(ctx, {})) as { data: { entity_map?: unknown } };
    expect(res.data.entity_map).toBe("none_inferred");
  });

  it("labels row counts as estimates so they are never quoted as totals", async () => {
    state.hints = {};
    const { operatorDbCatalogTool } = await import("../tools");
    const res = (await operatorDbCatalogTool.execute(ctx, {})) as { data: { note?: string } };
    expect(res.data.note).toMatch(/ENGINE ESTIMATES, not exact counts/);
  });
});
