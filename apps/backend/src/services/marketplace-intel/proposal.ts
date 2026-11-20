
import type { CanonicalMap, CanonicalMapEntry } from "@/services/tools/operator-db/mapping";
import type { OperatorDbCatalog } from "@/services/tools/operator-db/types";

export type ProposalSchema = Pick<OperatorDbCatalog, "tables">;

const tablesOf = (schema: ProposalSchema | null | undefined) => schema?.tables ?? [];

const TABLE_WORDS: Record<string, string[]> = {
  bookings: [
    "order", "booking", "reservation", "purchase", "sale", "transaction", "trip",
    "job", "session", "appointment", "ride", "rental", "checkout", "invoice",
    "load", "shipment", "delivery", "lesson", "stay", "visit", "request",
  ],
  listings: [
    "listing", "item", "product", "inventory", "offer", "service", "unit",
    "vehicle", "property", "room", "space", "sku", "catalog", "asset",
  ],
  customers: ["customer", "buyer", "client", "guest", "user", "account", "member", "person", "people"],
};

const FIELD_WORDS: Record<string, string[]> = {
  created_at_field: ["created", "placed", "ordered", "booked", "purchased", "started", "opened", "date", "timestamp", "time"],
  listed_at_field: ["listed", "published", "posted", "created", "added", "live", "date"],
  geo_field: [
    "city", "town", "region", "state", "province", "county", "district", "area",
    "suburb", "neighborhood", "market", "metro", "location", "place", "origin",
    "country", "postcode", "zipcode", "zip", "postal", "address",
  ],
  id_field: ["id", "uuid", "key", "code", "slug"],
  listing_ref_field: ["listing", "item", "product", "offer", "service", "unit", "vehicle", "property", "room", "sku", "asset"],
  buyer_ref_field: ["buyer", "customer", "client", "guest", "user", "account", "member", "renter", "passenger", "student"],
  seller_ref_field: ["seller", "provider", "vendor", "merchant", "host", "owner", "supplier", "partner", "shop", "store", "driver", "tutor", "operator"],
};

const DATE_FIELDS = new Set(["created_at_field", "listed_at_field"]);
const REF_FIELDS = new Set(["id_field", "listing_ref_field", "buyer_ref_field", "seller_ref_field"]);

const normalize = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function looksLikeReference(rawName: string): boolean {
  const parts = normalize(rawName).split(" ");
  const last = parts[parts.length - 1];
  return last === "id" || last === "key" || last === "uuid";
}

function score(rawName: string, words: string[]): number {
  const name = normalize(rawName);
  const parts = new Set(name.split(" "));
  const joined = name.replace(/ /g, "");
  let best = 0;
  words.forEach((word, i) => {
    const rank = Math.max(1, words.length - i);
    let quality = 0;
    if (
      name === word || name === `${word}s` || name === `${word}es` ||
      joined === word || joined === `${word}s` || joined === `${word}es`
    ) quality = 400;
    else if (parts.has(word) || parts.has(`${word}s`) || parts.has(`${word}es`)) quality = 300;
    else if (name.includes(word) || joined.includes(word)) quality = 120;
    if (quality > 0) best = Math.max(best, quality + rank);
  });
  return best;
}

const isDateType = (type: string | undefined): boolean =>
  !!type && /date|time|timestamp/i.test(type);
const isTextType = (type: string | undefined): boolean =>
  !!type && /char|text|string|enum|uuid|object/i.test(type);
const isRefType = (type: string | undefined): boolean =>
  !!type && /int|serial|uuid|objectid|char|text|string|number|long|bigint/i.test(type);

const isStructuredType = (type: string | undefined): boolean =>
  !!type && /(^|\|)\s*(document|array|object(?!id)|bool)/i.test(type);

function hintedValueFits(column: { name: string; type?: string }, field: string): boolean {
  if (isStructuredType(column.type)) return false;
  if (field === "geo_field") return !isDateType(column.type);
  if (DATE_FIELDS.has(field)) return true;
  if (REF_FIELDS.has(field)) return looksLikeReference(column.name) || isRefType(column.type);
  return true;
}

function tableNamed(schema: ProposalSchema | null | undefined, name: string | undefined) {
  if (!name) return undefined;
  return tablesOf(schema).find((t) => t.name === name);
}

const WHOLE_NAME_MATCH = 400;

function bestRoleByName(tableName: string): { role: string; score: number } | undefined {
  let best: { role: string; score: number } | undefined;
  for (const role of Object.keys(TABLE_WORDS)) {
    const s = score(tableName, TABLE_WORDS[role]);
    if (s > 0 && (!best || s > best.score)) best = { role, score: s };
  }
  return best;
}

function pickTable(schema: ProposalSchema | null | undefined, role: string, taken: Set<string>): string | undefined {
  const words = TABLE_WORDS[role] ?? [];
  let best: { name: string; score: number } | undefined;
  for (const table of tablesOf(schema)) {
    if (taken.has(table.name)) continue;
    const s = score(table.name, words);
    if (s > 0 && (!best || s > best.score)) best = { name: table.name, score: s };
  }
  if (best) return best.name;
  if (role !== "bookings") return undefined;
  const hasRowCounts = tablesOf(schema).some((t) => typeof t.rowEstimate === "number");
  let byShape: { name: string; dateScore: number; columns: number; rows: number } | undefined;
  for (const table of tablesOf(schema)) {
    if (taken.has(table.name)) continue;
    const columns = table.columns ?? [];
    const dated = columns.filter((c) => isDateType(c.type));
    if (dated.length === 0) continue;
    const dateScore = Math.max(...dated.map((c) => score(c.name, FIELD_WORDS.created_at_field)));
    const rows = typeof table.rowEstimate === "number" ? table.rowEstimate : 0;
    const candidate = { name: table.name, dateScore, columns: columns.length, rows };
    const better =
      !byShape ||
      (hasRowCounts
        ? candidate.rows > byShape.rows ||
          (candidate.rows === byShape.rows && candidate.dateScore > byShape.dateScore)
        : candidate.dateScore > byShape.dateScore ||
          (candidate.dateScore === byShape.dateScore && candidate.columns > byShape.columns));
    if (better) byShape = candidate;
  }
  return byShape?.name;
}

function pickColumn(
  table: { columns?: Array<{ name: string; type?: string }> } | undefined,
  field: string,
  opts: { exclude?: Set<string> } = {},
): string | undefined {
  if (!table) return undefined;
  const words = FIELD_WORDS[field] ?? [];
  let best: { name: string; score: number } | undefined;
  for (const column of table.columns ?? []) {
    if (opts.exclude?.has(column.name)) continue;
    const nameScore = score(column.name, words);
    if (nameScore === 0) continue;
    let s = nameScore;
    if (DATE_FIELDS.has(field)) {
      if (isDateType(column.type)) s += 200;
    } else if (field === "geo_field") {
      if (isDateType(column.type) || isStructuredType(column.type)) continue;
      if (isTextType(column.type)) s += 60;
    } else if (REF_FIELDS.has(field)) {
      if (isDateType(column.type)) continue;
      if (isStructuredType(column.type)) continue;
      if (!looksLikeReference(column.name) && !isRefType(column.type)) continue;
      if (isRefType(column.type)) s += 40;
      if (looksLikeReference(column.name)) s += 200;
    }
    if (!best || s > best.score) best = { name: column.name, score: s };
  }
  if (!best && DATE_FIELDS.has(field)) {
    const dates = (table.columns ?? []).filter((c) => isDateType(c.type) && !opts.exclude?.has(c.name));
    if (dates.length === 1) return dates[0].name;
  }
  return best?.name;
}

export function proposeFromSchema(
  schema: ProposalSchema | null | undefined,
  hinted: Partial<Record<string, CanonicalMapEntry>>,
  roleLabels: Record<string, string>,
  opts: { complete?: boolean; confirmed?: Set<string>; droppedByName?: Set<string> } = {},
): Partial<Record<string, CanonicalMapEntry>> {
  const out: Partial<Record<string, CanonicalMapEntry>> = {};
  const taken = new Set<string>();
  void opts;

  const ROLES = ["bookings", "listings", "customers"];
  const hintedNames: Record<string, string | undefined> = {};
  for (const role of ROLES) {
    hintedNames[role] = tableNamed(schema, (hinted[role] as CanonicalMapEntry | undefined)?.table)?.name;
  }
  const hintedTable: Record<string, string | undefined> = {};
  const byConfirmedFirst = [...ROLES].sort(
    (a, b) => Number(!!opts.confirmed?.has(b)) - Number(!!opts.confirmed?.has(a)),
  );
  for (const role of byConfirmedFirst) {
    const table = hintedNames[role] ? tableNamed(schema, hintedNames[role]) : undefined;
    if (!table) continue;
    if (taken.has(table.name)) continue;
    const byName = bestRoleByName(table.name);
    if (
      !opts.confirmed?.has(role) &&
      byName &&
      byName.role !== role &&
      byName.score >= WHOLE_NAME_MATCH
    ) {
      opts.droppedByName?.add(role);
      continue;
    }
    hintedTable[role] = table.name;
    taken.add(table.name);
  }

  for (const role of ROLES) {
    const tableName = hintedTable[role] ?? pickTable(schema, role, taken);
    if (!tableName) continue;
    taken.add(tableName);
    const table = tableNamed(schema, tableName);
    const entry: Record<string, string> = { table: tableName, label: roleLabels[role] ?? role };
    const used = new Set<string>();

    for (const field of FIELDS_BY_ROLE[role] ?? []) {
      const hintedValue = (hinted[role] as Record<string, string> | undefined)?.[field];
      const hintedColumn = hintedValue
        ? (table?.columns ?? []).find((c) => c.name === hintedValue)
        : undefined;
      const keep =
        hintedColumn && (opts.confirmed?.has(`${role}.${field}`) || hintedValueFits(hintedColumn, field))
          ? hintedColumn.name
          : pickColumn(table, field, { exclude: used });
      if (keep) {
        entry[field] = keep;
        used.add(keep);
      }
    }
    out[role] = entry as unknown as CanonicalMapEntry;
  }
  return out;
}

const FIELDS_BY_ROLE: Record<string, string[]> = {
  bookings: ["created_at_field", "geo_field", "listing_ref_field", "buyer_ref_field", "seller_ref_field"],
  listings: ["id_field", "geo_field", "listed_at_field"],
  customers: ["id_field", "geo_field"],
};

export function unbackedRefs(
  schema: ProposalSchema | null | undefined,
  map: CanonicalMap | undefined,
): string[] {
  if (tablesOf(schema).length === 0) return [];
  const bad: string[] = [];
  for (const [role, rawEntry] of Object.entries(map ?? {})) {
    const entry = rawEntry as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") continue;
    const tableName = typeof entry.table === "string" ? entry.table : "";
    if (!tableName) continue;
    const table = tableNamed(schema, tableName);
    if (!table) {
      bad.push(`${role}.table`);
      continue;
    }
    for (const [key, value] of Object.entries(entry)) {
      if (key === "table" || key === "label" || typeof value !== "string" || !value) continue;
      if (!key.endsWith("_field")) continue;
      if (!table.columns?.some((c) => c.name === value)) bad.push(`${role}.${key}`);
    }
  }
  return bad;
}
