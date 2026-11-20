
import type { OperatorDbDriver, SchemaMap } from "../types";
import { ExpectedToolError } from "@/services/tools/types";
import { withMysql } from "../session-attach";

function ident(name: string): string {
  if (typeof name !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(name)) {
    throw new ExpectedToolError("operator_db_invalid_identifier", `Bad SQL identifier: ${String(name)}`);
  }
  return name.split(".").map((p) => `\`${p}\``).join(".");
}

export function mysqlDriver(): OperatorDbDriver {
  return {
    async query_user(userId, cfg) {
      const m = cfg.users;
      const sql = `SELECT * FROM ${ident(m.table)} WHERE ${ident(m.id_field)} = ? LIMIT 1`;
      return withMysql(cfg, async (c) => {
        const [rows] = await c.query(sql, [userId]);
        const arr = rows as Record<string, unknown>[];
        return { ok: true, data: arr[0] ?? null };
      });
    },

    async query_listing(listingId, cfg) {
      const m = cfg.listings;
      if (!m) throw new ExpectedToolError("operator_db_no_listings_map", "schema_map.listings not declared");
      const sql = `SELECT * FROM ${ident(m.table)} WHERE ${ident(m.id_field)} = ? LIMIT 1`;
      return withMysql(cfg, async (c) => {
        const [rows] = await c.query(sql, [listingId]);
        const arr = rows as Record<string, unknown>[];
        return { ok: true, data: arr[0] ?? null };
      });
    },

    async query_recent_transactions(userId, sinceUnix, cfg) {
      const m = cfg.transactions;
      if (!m) throw new ExpectedToolError("operator_db_no_transactions_map", "schema_map.transactions not declared");
      const sql = `SELECT * FROM ${ident(m.table)} WHERE user_id = ? AND created_at >= FROM_UNIXTIME(?) ORDER BY created_at DESC LIMIT 100`;
      return withMysql(cfg, async (c) => {
        const [rows] = await c.query(sql, [userId, sinceUnix]);
        return { ok: true, data: rows as Record<string, unknown>[] };
      });
    },

    async query_bookings_by_geo_category() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "Aggregate queries on MySQL operator_db are not implemented in v1. Postgres-shape tenants only for now.",
      );
    },
    async query_active_supply_by_geo_category() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "Aggregate queries on MySQL operator_db are not implemented in v1. Postgres-shape tenants only for now.",
      );
    },
    async query_funnel_by_geo_category() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "Aggregate queries on MySQL operator_db are not implemented in v1. Postgres-shape tenants only for now.",
      );
    },
    async query_verified_bookings_by_campaign() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "The verified-booking-by-campaign join is not implemented for MySQL operator_db (Mongo-shape tenants only).",
      );
    },
    async query_new_users_in_window() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "The new-users-in-window count is not implemented for MySQL operator_db (Postgres + Mongo tenants only for now).",
      );
    },
    async query_new_bookings_in_window() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "The new-bookings-in-window count is not implemented for MySQL operator_db (Postgres + Mongo tenants only for now).",
      );
    },

  };
}
