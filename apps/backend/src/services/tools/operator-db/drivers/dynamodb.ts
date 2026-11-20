
import type { OperatorDbDriver } from "../types";
import { ExpectedToolError } from "@/services/tools/types";
import { dynamoFor } from "../session-attach";

export {
  parseDynamodbUri,
  assertAwsDynamoEndpoint,
  DYNAMO_ENDPOINT_REJECTED,
  DYNAMO_REGION_REJECTED,
  type ParsedDynamodbUri,
} from "../dynamodb-uri";

const RECENT_TX_ROW_CAP = 100;

function assertSafeName(name: string, kind: "table" | "attribute"): void {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_.\-]{1,255}$/.test(name)) {
    throw new ExpectedToolError(
      "operator_db_invalid_identifier",
      `Bad DynamoDB ${kind} name: ${String(name)}`,
    );
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

export function dynamodbDriver(): OperatorDbDriver {
  return {
    async query_user(userId, cfg) {
      const m = cfg.users;
      assertSafeName(m.table, "table");
      assertSafeName(m.id_field, "attribute");
      const items = await dynamoFor(cfg).query({ table: m.table, key: { [m.id_field]: userId }, limit: 1 });
      return { ok: true, data: asRecord(items[0]) };
    },

    async query_listing(listingId, cfg) {
      const m = cfg.listings;
      if (!m) {
        throw new ExpectedToolError(
          "operator_db_no_listings_map",
          "schema_map.listings not declared",
        );
      }
      assertSafeName(m.table, "table");
      assertSafeName(m.id_field, "attribute");
      const items = await dynamoFor(cfg).query({ table: m.table, key: { [m.id_field]: listingId }, limit: 1 });
      return { ok: true, data: asRecord(items[0]) };
    },

    async query_recent_transactions(userId, sinceUnix, cfg) {
      const m = cfg.transactions;
      if (!m) {
        throw new ExpectedToolError(
          "operator_db_no_transactions_map",
          "schema_map.transactions not declared",
        );
      }
      assertSafeName(m.table, "table");
      const dyn = dynamoFor(cfg);
      const sinceIso = new Date(sinceUnix * 1000).toISOString();
      try {
        const items = await dyn.query({
          table: m.table,
          key: { user_id: userId },
          filter: { gte: { field: "created_at", value: sinceIso } },
          scanIndexForward: false,
          limit: RECENT_TX_ROW_CAP,
        });
        return { ok: true, data: items.slice(0, RECENT_TX_ROW_CAP) };
      } catch (e) {
        const name = (e as { name?: string })?.name ?? "";
        if (name !== "ValidationException") throw e;
        const items = await dyn.scan({
          table: m.table,
          filter: { eq: { user_id: userId }, gte: { field: "created_at", value: sinceIso } },
          limit: RECENT_TX_ROW_CAP,
        });
        return { ok: true, data: items.slice(0, RECENT_TX_ROW_CAP) };
      }
    },

    async query_bookings_by_geo_category() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "Aggregate queries on DynamoDB operator_db are not implemented in v1 (no server-side GROUP BY / JOIN).",
      );
    },
    async query_active_supply_by_geo_category() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "Aggregate queries on DynamoDB operator_db are not implemented in v1 (no server-side GROUP BY / JOIN).",
      );
    },
    async query_funnel_by_geo_category() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "Aggregate queries on DynamoDB operator_db are not implemented in v1 (no server-side GROUP BY / JOIN).",
      );
    },
    async query_verified_bookings_by_campaign() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "The verified-booking-by-campaign join is not implemented for DynamoDB operator_db (Mongo-shape tenants only).",
      );
    },
    async query_new_users_in_window() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "The new-users-in-window count is not implemented for DynamoDB operator_db (Postgres + Mongo tenants only for now).",
      );
    },
    async query_new_bookings_in_window() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "The new-bookings-in-window count is not implemented for DynamoDB operator_db (Postgres + Mongo tenants only for now).",
      );
    },
  };
}

