
import type {
  CountRangeFilter,
  AggregateFilter,
  AggregateResult,
  ActiveSupplyWeekRow,
  FunnelWeekRow,
  GeoCategoryWeekRow,
  NewBookingsFilter,
  NewBookingsInWindowResult,
  NewUsersFilter,
  NewUsersInWindowResult,
  OperatorDbDriver,
  OperatorDbResult,
  SchemaMap,
} from "../types";
import { ExpectedToolError } from "@/services/tools/types";
import { withSql } from "../session-attach";

function ident(name: string): string {
  if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(name)) {
    throw new ExpectedToolError("operator_db_invalid_identifier", `Bad SQL identifier: ${String(name)}`);
  }
  return name;
}

export function postgresDriver(): OperatorDbDriver {
  return {
    async query_user(userId, cfg) {
      const m = cfg.users;
      const sql = `SELECT * FROM ${ident(m.table)} WHERE ${ident(m.id_field)} = $1 LIMIT 1`;
      return withSql(cfg, async (c) => {
        const r = await c.query(sql, [userId]);
        return { ok: true, data: r.rows[0] ?? null };
      });
    },

    async query_listing(listingId, cfg) {
      const m = cfg.listings;
      if (!m) {
        throw new ExpectedToolError("operator_db_no_listings_map", "schema_map.listings not declared for this tenant");
      }
      const sql = `SELECT * FROM ${ident(m.table)} WHERE ${ident(m.id_field)} = $1 LIMIT 1`;
      return withSql(cfg, async (c) => {
        const r = await c.query(sql, [listingId]);
        return { ok: true, data: r.rows[0] ?? null };
      });
    },

    async query_recent_transactions(userId, sinceUnix, cfg) {
      const m = cfg.transactions;
      if (!m) {
        throw new ExpectedToolError("operator_db_no_transactions_map", "schema_map.transactions not declared");
      }
      const sql = `SELECT * FROM ${ident(m.table)} WHERE user_id = $1 AND created_at >= to_timestamp($2) ORDER BY created_at DESC LIMIT 100`;
      return withSql(cfg, async (c) => {
        const r = await c.query(sql, [userId, sinceUnix]);
        return { ok: true, data: r.rows };
      });
    },

    async query_bookings_by_geo_category(
      filter: AggregateFilter,
      cfg: SchemaMap,
    ): Promise<OperatorDbResult<AggregateResult<GeoCategoryWeekRow>>> {
      const m = cfg.bookings;
      if (!m) {
        throw new ExpectedToolError(
          "schema_map_missing",
          "schema_map.bookings not declared for this tenant",
          { missing_tables: ["bookings"] },
        );
      }
      const tbl = ident(m.table);
      const geoCol = ident(m.geo_field);
      const catCol = ident(m.category_field);
      const tsCol = ident(m.created_at_field);
      const gmvExpr = m.gmv_proxy_field ? `COALESCE(SUM(${ident(m.gmv_proxy_field)}), 0)` : `0`;
      const sql = `
        WITH agg AS (
          SELECT
            ${geoCol} AS city,
            ${catCol} AS category,
            date_trunc('week', ${tsCol})::date AS week_start,
            COUNT(*)::int AS bookings_n,
            ${gmvExpr}::numeric AS gmv_proxy_n
          FROM ${tbl}
          WHERE ${tsCol} >= now() - make_interval(weeks => $1::int)
            AND ($2::text IS NULL OR ${geoCol} = $2::text)
            AND ($3::text IS NULL OR ${catCol} = $3::text)
          GROUP BY 1, 2, 3
        ),
        ranked AS (
          SELECT *, ROW_NUMBER() OVER (ORDER BY bookings_n DESC, week_start DESC, city, category) AS rn
          FROM agg
        )
        SELECT city, category, week_start, bookings_n, gmv_proxy_n,
               (SELECT COUNT(*) FROM agg) AS total_segments_seen
        FROM ranked
        WHERE rn <= $4::int
        ORDER BY bookings_n DESC, week_start DESC, city, category
      `;
      return withSql(cfg, async (c) => {
        const r = await c.query(sql, [
          filter.lookback_weeks,
          filter.focus_city ?? null,
          filter.focus_category ?? null,
          filter.top_n,
        ]);
        const rows: GeoCategoryWeekRow[] = r.rows.map((row) => ({
          city: row.city,
          category: row.category,
          week_start: typeof row.week_start === "string" ? row.week_start : row.week_start.toISOString().slice(0, 10),
          bookings_n: Number(row.bookings_n),
          gmv_proxy_n: Number(row.gmv_proxy_n),
        }));
        const total = r.rows.length > 0 ? Number(r.rows[0].total_segments_seen) : 0;
        return {
          ok: true,
          data: { rows, truncated: total > rows.length, total_segments_seen: total },
        };
      });
    },

    async query_active_supply_by_geo_category(
      filter: AggregateFilter,
      cfg: SchemaMap,
    ): Promise<OperatorDbResult<AggregateResult<ActiveSupplyWeekRow>>> {
      const m = cfg.bookings;
      if (!m) {
        throw new ExpectedToolError(
          "schema_map_missing",
          "schema_map.bookings required for active-supply aggregate",
          { missing_tables: ["bookings"] },
        );
      }
      if (!m.listing_ref_field) {
        throw new ExpectedToolError(
          "schema_map_missing",
          "schema_map.bookings.listing_ref_field required for active-supply aggregate",
          { missing_tables: ["bookings.listing_ref_field"] },
        );
      }
      const tbl = ident(m.table);
      const geoCol = ident(m.geo_field);
      const catCol = ident(m.category_field);
      const tsCol = ident(m.created_at_field);
      const refCol = ident(m.listing_ref_field);
      const sql = `
        WITH agg AS (
          SELECT
            ${geoCol} AS city,
            ${catCol} AS category,
            date_trunc('week', ${tsCol})::date AS week_start,
            COUNT(DISTINCT ${refCol})::int AS active_listings_n
          FROM ${tbl}
          WHERE ${tsCol} >= now() - make_interval(weeks => $1::int)
            AND ($2::text IS NULL OR ${geoCol} = $2::text)
            AND ($3::text IS NULL OR ${catCol} = $3::text)
          GROUP BY 1, 2, 3
        ),
        ranked AS (
          SELECT *, ROW_NUMBER() OVER (ORDER BY active_listings_n DESC, week_start DESC, city, category) AS rn
          FROM agg
        )
        SELECT city, category, week_start, active_listings_n,
               active_listings_n AS total_listings_n,
               NULL::numeric AS avg_days_since_last_booking,
               (SELECT COUNT(*) FROM agg) AS total_segments_seen
        FROM ranked
        WHERE rn <= $4::int
        ORDER BY active_listings_n DESC, week_start DESC, city, category
      `;
      return withSql(cfg, async (c) => {
        const r = await c.query(sql, [
          filter.lookback_weeks,
          filter.focus_city ?? null,
          filter.focus_category ?? null,
          filter.top_n,
        ]);
        const rows: ActiveSupplyWeekRow[] = r.rows.map((row) => ({
          city: row.city,
          category: row.category,
          week_start: typeof row.week_start === "string" ? row.week_start : row.week_start.toISOString().slice(0, 10),
          active_listings_n: Number(row.active_listings_n),
          total_listings_n: Number(row.total_listings_n),
          avg_days_since_last_booking: row.avg_days_since_last_booking == null ? null : Number(row.avg_days_since_last_booking),
        }));
        const total = r.rows.length > 0 ? Number(r.rows[0].total_segments_seen) : 0;
        return {
          ok: true,
          data: { rows, truncated: total > rows.length, total_segments_seen: total },
        };
      });
    },

    async query_funnel_by_geo_category(
      filter: AggregateFilter,
      cfg: SchemaMap,
    ): Promise<OperatorDbResult<AggregateResult<FunnelWeekRow>>> {
      const m = cfg.bookings;
      if (!m) {
        throw new ExpectedToolError(
          "schema_map_missing",
          "schema_map.bookings required for funnel aggregate (book_n is derived from bookings)",
          { missing_tables: ["bookings"] },
        );
      }
      const tbl = ident(m.table);
      const geoCol = ident(m.geo_field);
      const catCol = ident(m.category_field);
      const tsCol = ident(m.created_at_field);
      const sql = `
        WITH agg AS (
          SELECT
            ${geoCol} AS city,
            ${catCol} AS category,
            date_trunc('week', ${tsCol})::date AS week_start,
            COUNT(*)::int AS book_n
          FROM ${tbl}
          WHERE ${tsCol} >= now() - make_interval(weeks => $1::int)
            AND ($2::text IS NULL OR ${geoCol} = $2::text)
            AND ($3::text IS NULL OR ${catCol} = $3::text)
          GROUP BY 1, 2, 3
        ),
        ranked AS (
          SELECT *, ROW_NUMBER() OVER (ORDER BY book_n DESC, week_start DESC, city, category) AS rn
          FROM agg
        )
        SELECT city, category, week_start,
               NULL::int AS search_n,
               NULL::int AS view_n,
               NULL::int AS contact_n,
               book_n,
               (SELECT COUNT(*) FROM agg) AS total_segments_seen
        FROM ranked
        WHERE rn <= $4::int
        ORDER BY book_n DESC, week_start DESC, city, category
      `;
      return withSql(cfg, async (c) => {
        const r = await c.query(sql, [
          filter.lookback_weeks,
          filter.focus_city ?? null,
          filter.focus_category ?? null,
          filter.top_n,
        ]);
        const rows: FunnelWeekRow[] = r.rows.map((row) => ({
          city: row.city,
          category: row.category,
          week_start: typeof row.week_start === "string" ? row.week_start : row.week_start.toISOString().slice(0, 10),
          search_n: row.search_n == null ? null : Number(row.search_n),
          view_n: row.view_n == null ? null : Number(row.view_n),
          contact_n: row.contact_n == null ? null : Number(row.contact_n),
          book_n: Number(row.book_n),
        }));
        const total = r.rows.length > 0 ? Number(r.rows[0].total_segments_seen) : 0;
        return {
          ok: true,
          data: { rows, truncated: total > rows.length, total_segments_seen: total },
        };
      });
    },

    async query_verified_bookings_by_campaign() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "The verified-booking-by-campaign join is not implemented for Postgres operator_db (Mongo-shape tenants only).",
      );
    },

    async query_new_users_in_window(
      filter: NewUsersFilter,
      cfg: SchemaMap,
    ): Promise<OperatorDbResult<NewUsersInWindowResult>> {
      const window_days = Math.max(1, Math.min(365, Math.floor(filter.window_days || 7)));
      const notAvailable: OperatorDbResult<NewUsersInWindowResult> = {
        ok: true,
        data: { available: false, reason: "not_available", window_days, count: 0 },
      };
      const m = cfg.users;
      if (!m?.table || !m.created_at_field) return notAvailable;
      const sql = `SELECT COUNT(*)::int AS n FROM ${ident(m.table)} WHERE ${ident(m.created_at_field)} >= now() - make_interval(days => $1::int)`;
      return withSql(cfg, async (c) => {
        const r = await c.query(sql, [window_days]);
        const count = Number(r.rows[0]?.n ?? 0);
        return { ok: true, data: { available: true, window_days, count } };
      });
    },

    async query_new_bookings_in_window(
      filter: NewBookingsFilter,
      cfg: SchemaMap,
    ): Promise<OperatorDbResult<NewBookingsInWindowResult>> {
      const window_days = Math.max(1, Math.min(365, Math.floor(filter.window_days || 7)));
      const notAvailable: OperatorDbResult<NewBookingsInWindowResult> = {
        ok: true,
        data: { available: false, reason: "not_available", window_days, count: 0 },
      };
      const m = cfg.bookings;
      if (!m?.table || !m.created_at_field) return notAvailable;
      const sql = `SELECT COUNT(*)::int AS n FROM ${ident(m.table)} WHERE ${ident(m.created_at_field)} >= now() - make_interval(days => $1::int)`;
      return withSql(cfg, async (c) => {
        const r = await c.query(sql, [window_days]);
        const count = Number(r.rows[0]?.n ?? 0);
        return { ok: true, data: { available: true, window_days, count } };
      });
    },

    async query_new_users_in_range(filter: CountRangeFilter, cfg: SchemaMap) {
      if (filter.match && Object.keys(filter.match).length > 0) {
        return { ok: true as const, data: { available: false, reason: "not_available" as const, since: filter.since, until: filter.until, count: 0 } };
      }
      return pgCountInRange(filter, cfg.users?.table, cfg.users?.created_at_field, cfg);
    },

    async query_new_bookings_in_range(filter: { since: string; until: string }, cfg: SchemaMap) {
      return pgCountInRange(filter, cfg.bookings?.table, cfg.bookings?.created_at_field, cfg);
    },

  };
}

async function pgCountInRange(
  filter: { since: string; until: string },
  table: string | undefined,
  createdCol: string | undefined,
  cfg: SchemaMap,
): Promise<OperatorDbResult<{ available: boolean; reason?: "not_available"; since: string; until: string; count: number }>> {
  const notAvailable = {
    ok: true as const,
    data: { available: false, reason: "not_available" as const, since: filter.since, until: filter.until, count: 0 },
  };
  const since = new Date(filter.since);
  const until = new Date(filter.until);
  if (!table || !createdCol || !Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since >= until) {
    return notAvailable;
  }
  const sql = `SELECT COUNT(*)::int AS n FROM ${ident(table)} WHERE ${ident(createdCol)} >= $1 AND ${ident(createdCol)} < $2`;
  return withSql(cfg, async (c) => {
    const r = await c.query(sql, [filter.since, filter.until]);
    const count = Number(r.rows[0]?.n ?? 0);
    return { ok: true as const, data: { available: true, since: filter.since, until: filter.until, count } };
  });
}
