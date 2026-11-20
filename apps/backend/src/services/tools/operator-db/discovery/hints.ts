
import { callModel } from "@/services/llm/call-model";
import { DEFAULT_PROVIDER } from "@/services/llm/models";
import type {
  OperatorDbCatalog,
  CatalogTable,
  CatalogColumn,
  EntityHints,
} from "../types";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 700;

function colNames(t: CatalogTable): string[] {
  return t.columns.map((c) => c.name);
}

function findCol(t: CatalogTable, re: RegExp): string | undefined {
  return colNames(t).find((n) => re.test(n));
}

const NOT_CREATED_AT =
  /(photo|image|thumb|avatar|updated|modified|edited|deleted|removed|expir|refresh|sync|last[_-]?|[_-]?last|login|seen|birth|dob)/i;

const ARRAY_TYPE = /(^|\b)(array|list|set)(\b|$|<|\[)/i;
const DATE_TYPE = /(date|time|timestamp)/i;

function isDateTyped(col: CatalogColumn | undefined): boolean {
  const t = typeof col?.type === "string" ? col.type.trim() : "";
  if (t.length === 0) return true;
  if (ARRAY_TYPE.test(t)) return false;
  if (DATE_TYPE.test(t)) return true;
  return false;
}

function findCreatedAtCol(t: CatalogTable): string | undefined {
  const byName = new Map(t.columns.map((c) => [c.name, c]));
  const cols = colNames(t).filter((n) => isDateTyped(byName.get(n)));
  const tiers: RegExp[] = [
    /^(created_?at|createdon|created_?date|date_?created|inserted_?at|insert_?date|create_?time|createtime)$/i,
    /(^|[_-])created([_-]?at|[_-]?on)?($|[_-])/i,
    /(created|inserted)/i,
    /^(booked_?at|booking_?date|order_?date|placed_?at|start_?date|trip_?date|transaction_?date)$/i,
  ];
  for (const re of tiers) {
    const hit = cols.find((n) => re.test(n));
    if (hit) return hit;
  }
  return cols.find((n) => /(^date$|_at$|_date$|timestamp)/i.test(n) && !NOT_CREATED_AT.test(n));
}

function idField(t: CatalogTable): string {
  const names = colNames(t);
  return (
    names.find((n) => n === "id" || n === "_id") ??
    names.find((n) => /(^|_)id$/i.test(n)) ??
    names[0] ??
    "id"
  );
}

function pickTable(
  tables: CatalogTable[],
  exact: RegExp,
  loose: RegExp,
): { t: CatalogTable; confidence: number } | undefined {
  const ex = tables.find((t) => exact.test(t.name));
  if (ex) return { t: ex, confidence: 0.8 };
  const lo = tables.find((t) => loose.test(t.name));
  if (lo) return { t: lo, confidence: 0.5 };
  return undefined;
}

function pickPreferred(
  tables: CatalogTable[],
  exactInOrder: RegExp[],
  loose: RegExp,
): { t: CatalogTable; confidence: number } | undefined {
  for (const exact of exactInOrder) {
    const hit = tables.find((t) => exact.test(t.name));
    if (hit) return { t: hit, confidence: 0.8 };
  }
  const lo = tables.find((t) => loose.test(t.name));
  if (lo) return { t: lo, confidence: 0.5 };
  return undefined;
}

function listingGeoField(t: CatalogTable | undefined): string | undefined {
  if (!t) return undefined;
  return findCol(t, /(^state$|\.state$|_state$|region|city|metro|location|area|market)/i);
}

export function heuristicHints(catalog: OperatorDbCatalog): EntityHints {
  const tables = catalog.tables ?? [];
  const out: EntityHints = { _confidence: {} };
  const conf = out._confidence as Record<string, number>;

  const users = pickPreferred(
    tables,
    [
      /^(users?|accounts?|members?|profiles?)$/i,
      /^(customers?|clients?|subscribers?)$/i,
    ],
    /(user|account|member|profile|customer|client|subscriber|buyer)/i,
  );
  if (users) {
    out.users = { table: users.t.name, id_field: idField(users.t) };
    conf.users = users.confidence;
  }

  const listings = pickTable(
    tables,
    /^(listings?|products?|items?|vehicles?|cars?|properties|rentals?)$/i,
    /(listing|product|item|vehicle|\bcar|propert|rental|inventory)/i,
  );
  if (listings) {
    out.listings = {
      table: listings.t.name,
      id_field: idField(listings.t),
      geo_field: listingGeoField(listings.t),
    };
    conf.listings = listings.confidence;
  }

  const tx = pickTable(
    tables,
    /^(transactions?|payments?|charges?|invoices?)$/i,
    /(transaction|payment|charge|invoice|payout)/i,
  );
  if (tx) {
    out.transactions = { table: tx.t.name };
    conf.transactions = tx.confidence;
  }

  const bk = pickTable(
    tables,
    /^(bookings?|orders?|reservations?|trips?)$/i,
    /(booking|order|reservation|\btrip)/i,
  );
  if (bk) {
    const t = bk.t;
    out.bookings = {
      table: t.name,
      geo_field: findCol(t, /(city|metro|region|location|area|market)/i),
      category_field: findCol(t, /(category|^type$|_type$|class|segment|vehicle_class)/i),
      created_at_field: findCreatedAtCol(t),
      listing_ref_field: findCol(t, /(listing_id|product_id|item_id|vehicle_id|car_id)/i),
      gmv_proxy_field: findCol(t, /(amount|total|price|gmv|revenue|grand_total|value_cents)/i),
    };
    conf.bookings = bk.confidence;
  }

  const cancelTbl = pickTable(
    tables,
    /^(cancellations?|cancel_events?|cancelled_bookings?)$/i,
    /(cancellation|cancel)/i,
  );
  const reasonRe = /(cancel_?reason|cancellation_?reason|cancelled_?reason)/i;
  const statusRe = /(status|state|booking_status|trip_status)/i;
  if (cancelTbl) {
    const t = cancelTbl.t;
    out.cancellations = {
      table: t.name,
      status_field: findCol(t, statusRe),
      reason_field: findCol(t, reasonRe) ?? findCol(t, /reason/i),
      created_at_field: findCol(t, /(cancell?ed_at|canceled_at|created_at|created|updated_at|timestamp)/i),
    };
    conf.cancellations = cancelTbl.confidence;
  } else if (bk) {
    const t = bk.t;
    const reason = findCol(t, reasonRe) ?? findCol(t, /reason/i);
    const status = findCol(t, statusRe);
    if (reason || status) {
      out.cancellations = {
        table: t.name,
        status_field: status,
        reason_field: reason,
        created_at_field: findCol(t, /(cancell?ed_at|canceled_at|created_at|created|updated_at|timestamp)/i),
      };
      conf.cancellations = 0.4;
    }
  }

  return out;
}

export const REFINE_DIGEST_MAX_CHARS = 60_000;

export function digest(catalog: OperatorDbCatalog): string {
  const tables = [...(catalog.tables ?? [])].sort((a, b) => {
    const ea = typeof a.rowEstimate === "number" ? a.rowEstimate : -1;
    const eb = typeof b.rowEstimate === "number" ? b.rowEstimate : -1;
    if (ea !== eb) return eb - ea;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const t of tables) {
    const line = `${t.name}(${t.columns.map((c) => c.name).join(",")})`;
    if (used + line.length + 1 > REFINE_DIGEST_MAX_CHARS) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (dropped > 0) {
    lines.push(`-- ${dropped} smaller table(s) omitted for length`);
  }
  return lines.join("\n");
}

function tableExists(catalog: OperatorDbCatalog, name?: string): boolean {
  return !!name && (catalog.tables ?? []).some((t) => t.name === name);
}

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const p = JSON.parse(m[0]);
    return p && typeof p === "object" && !Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

export async function refineHintsWithHaiku(
  catalog: OperatorDbCatalog,
  heuristic: EntityHints,
  budgetMs: number,
  tenantId?: string | null,
): Promise<EntityHints> {
  if (budgetMs <= 0 || !(catalog.tables ?? []).length) return heuristic;

  const system = [
    "You map a company operator's database schema to canonical roles.",
    "Roles: users, listings, transactions, bookings, cancellations.",
    "Use ONLY table/column names that appear verbatim in the provided schema.",
    "Output strict JSON only:",
    '{"users":{"table":"","id_field":""},"listings":{"table":"","id_field":""},',
    '"transactions":{"table":""},"bookings":{"table":"","geo_field":"",',
    '"category_field":"","created_at_field":"","listing_ref_field":"",',
    '"gmv_proxy_field":""},"cancellations":{"table":"","status_field":"",',
    '"reason_field":"","created_at_field":""}}',
    "cancellations may reuse the bookings table when cancellation lives there",
    "as a status + reason column. Omit any role you cannot confidently map.",
    "No prose.",
  ].join("\n");

  try {
    const resp = await callModel({
      provider: DEFAULT_PROVIDER,
      model: HAIKU_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: `Schema:\n${digest(catalog)}` }],
      timeoutMs: budgetMs,
      tags: { tenantId, agentSlug: "operator-db-discovery" },
    });

    const text = resp.text.trim();
    const parsed = extractJson(text);
    if (!parsed) return heuristic;

    const refined: EntityHints = { ...heuristic, _confidence: { ...heuristic._confidence } };
    const c = refined._confidence as Record<string, number>;

    const u = parsed.users as { table?: string; id_field?: string } | undefined;
    if (u && tableExists(catalog, u.table)) {
      refined.users = { table: u.table!, id_field: u.id_field || "id" };
      c.users = 0.9;
    }
    const l = parsed.listings as { table?: string; id_field?: string } | undefined;
    if (l && tableExists(catalog, l.table)) {
      refined.listings = {
        table: l.table!,
        id_field: l.id_field || "id",
        geo_field: listingGeoField((catalog.tables ?? []).find((t) => t.name === l.table)),
      };
      c.listings = 0.9;
    }
    const tx = parsed.transactions as { table?: string } | undefined;
    if (tx && tableExists(catalog, tx.table)) {
      refined.transactions = { table: tx.table! };
      c.transactions = 0.9;
    }
    const b = parsed.bookings as Record<string, string> | undefined;
    if (b && tableExists(catalog, b.table)) {
      refined.bookings = {
        table: b.table,
        geo_field: b.geo_field || refined.bookings?.geo_field,
        category_field: b.category_field || refined.bookings?.category_field,
        created_at_field: b.created_at_field || refined.bookings?.created_at_field,
        listing_ref_field: b.listing_ref_field || refined.bookings?.listing_ref_field,
        gmv_proxy_field: b.gmv_proxy_field || refined.bookings?.gmv_proxy_field,
      };
      c.bookings = 0.9;
    }
    const cn = parsed.cancellations as Record<string, string> | undefined;
    if (cn && tableExists(catalog, cn.table)) {
      refined.cancellations = {
        table: cn.table,
        status_field: cn.status_field || refined.cancellations?.status_field,
        reason_field: cn.reason_field || refined.cancellations?.reason_field,
        created_at_field: cn.created_at_field || refined.cancellations?.created_at_field,
      };
      c.cancellations = 0.9;
    }
    return refined;
  } catch {
    return heuristic;
  }
}
