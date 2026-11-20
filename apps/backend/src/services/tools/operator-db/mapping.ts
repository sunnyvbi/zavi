
import { asTenantId, tenantClient } from "@/services/tenant-client";
import type { EntityHints, SchemaMap } from "./types";

export type CanonicalMapEntry = {
  table: string;
  label: string;
  field?: string;
  id_field?: string;
  created_at_field?: string;
  geo_field?: string;
  category_field?: string;
  gmv_proxy_field?: string;
  listing_ref_field?: string;
  buyer_ref_field?: string;
  seller_ref_field?: string;
  listed_at_field?: string;
  status_field?: string;
  reason_field?: string;
};

export type CanonicalMap = Record<string, CanonicalMapEntry>;

export type ConfirmedMapping = {
  catalog_hash: string;
  confirmed_map: CanonicalMap;
  confirmed_at: string;
};

type CatalogHashRow = { catalog_hash: unknown };
type ConfirmedMappingRow = {
  catalog_hash: unknown;
  confirmed_map: unknown;
  confirmed_at: unknown;
};

export async function getCatalogHash(tenantId: string): Promise<string | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("tenant_db_catalog")
    .select("catalog_hash")
    .maybeSingle() as { data: CatalogHashRow | null; error: { message?: string } | null };
  if (error || !data) return null;
  return (data.catalog_hash as string | null) ?? null;
}

export async function getConfirmedMapping(
  tenantId: string,
  catalogHash: string,
): Promise<ConfirmedMapping | null> {
  const { data, error } = await tenantClient(asTenantId(tenantId))
    .from("mapping_confirmed")
    .select("catalog_hash, confirmed_map, confirmed_at")
    .eq("catalog_hash", catalogHash)
    .maybeSingle() as { data: ConfirmedMappingRow | null; error: { message?: string } | null };
  if (error || !data) return null;
  return {
    catalog_hash: data.catalog_hash as string,
    confirmed_map: (data.confirmed_map as CanonicalMap) ?? {},
    confirmed_at: data.confirmed_at as string,
  };
}

export async function getLatestConfirmedMapping(tenantId: string): Promise<ConfirmedMapping | null> {
  const { data, error } = (await tenantClient(asTenantId(tenantId))
    .from("mapping_confirmed")
    .select("catalog_hash, confirmed_map, confirmed_at")
    .order("confirmed_at", { ascending: false })
    .limit(1)) as { data: ConfirmedMappingRow[] | null; error: { message?: string } | null };
  const row = data?.[0];
  if (error || !row) return null;
  return {
    catalog_hash: row.catalog_hash as string,
    confirmed_map: (row.confirmed_map as CanonicalMap) ?? {},
    confirmed_at: row.confirmed_at as string,
  };
}

function put(
  entry: Record<string, string>,
  key: string,
  value: string | undefined | null,
): void {
  if (typeof value === "string" && value.trim().length > 0) entry[key] = value;
}

export function proposedCanonicalMap(hints: EntityHints): CanonicalMap {
  const map: CanonicalMap = {};

  if (hints.bookings?.table) {
    const e: Record<string, string> = {
      table: hints.bookings.table,
      label: "Bookings / orders / trips",
    };
    put(e, "created_at_field", hints.bookings.created_at_field);
    put(e, "geo_field", hints.bookings.geo_field);
    put(e, "category_field", hints.bookings.category_field);
    put(e, "gmv_proxy_field", hints.bookings.gmv_proxy_field);
    put(e, "listing_ref_field", hints.bookings.listing_ref_field);
    map.bookings = e as unknown as CanonicalMapEntry;
  }

  if (hints.cancellations?.table) {
    const e: Record<string, string> = {
      table: hints.cancellations.table,
      label: "Cancellations (+ reason)",
    };
    put(e, "status_field", hints.cancellations.status_field);
    put(e, "reason_field", hints.cancellations.reason_field);
    put(e, "created_at_field", hints.cancellations.created_at_field);
    map.cancellations = e as unknown as CanonicalMapEntry;
  }

  if (hints.users?.table) {
    const e: Record<string, string> = { table: hints.users.table, label: "Users / accounts" };
    put(e, "id_field", hints.users.id_field);
    map.users = e as unknown as CanonicalMapEntry;
  }

  if (hints.listings?.table) {
    const e: Record<string, string> = { table: hints.listings.table, label: "Listings / inventory" };
    put(e, "id_field", hints.listings.id_field);
    put(e, "geo_field", hints.listings.geo_field);
    map.listings = e as unknown as CanonicalMapEntry;
  }

  if (hints.transactions?.table) {
    map.transactions = { table: hints.transactions.table, label: "Transactions / payments" };
  }

  return map;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

export function applyConfirmedMap(
  base: SchemaMap,
  confirmed: CanonicalMap | null | undefined,
): SchemaMap {
  if (!confirmed || Object.keys(confirmed).length === 0) return base;
  const out: SchemaMap = { ...base };

  const users = confirmed.users;
  if (users) {
    const table = str(users.table);
    const idField = str(users.id_field);
    out.users = {
      ...out.users,
      ...(table ? { table } : {}),
      ...(idField ? { id_field: idField } : {}),
      ...(str(users.created_at_field) ? { created_at_field: str(users.created_at_field)! } : {}),
    };
  }

  const listings = confirmed.listings;
  if (listings && (str(listings.table) || out.listings)) {
    const table = str(listings.table) ?? out.listings?.table;
    if (table) {
      out.listings = {
        ...(out.listings ?? { table, id_field: "id" }),
        table,
        ...(str(listings.id_field) ? { id_field: str(listings.id_field)! } : {}),
      };
    }
  }

  const transactions = confirmed.transactions;
  if (transactions && (str(transactions.table) || out.transactions)) {
    const table = str(transactions.table) ?? out.transactions?.table;
    if (table) {
      out.transactions = { ...(out.transactions ?? { table, id_field: "id" }), table };
    }
  }

  const bookings = confirmed.bookings;
  if (bookings && (str(bookings.table) || out.bookings)) {
    const table = str(bookings.table) ?? out.bookings?.table;
    if (table) {
      const seed = out.bookings ?? {
        table,
        id_field: "id",
        geo_field: "",
        category_field: "",
        created_at_field: "",
      };
      out.bookings = {
        ...seed,
        table,
        ...(str(bookings.created_at_field)
          ? { created_at_field: str(bookings.created_at_field)! }
          : {}),
        ...(str(bookings.geo_field) ? { geo_field: str(bookings.geo_field)! } : {}),
        ...(str(bookings.category_field)
          ? { category_field: str(bookings.category_field)! }
          : {}),
        ...(str(bookings.gmv_proxy_field)
          ? { gmv_proxy_field: str(bookings.gmv_proxy_field)! }
          : {}),
        ...(str(bookings.listing_ref_field)
          ? { listing_ref_field: str(bookings.listing_ref_field)! }
          : {}),
      };
    }
  }

  return out;
}
