
import { getCatalog, getDeclaredDialect } from "@/services/tools/operator-db/catalog";
import {
  getConfirmedMapping,
  getLatestConfirmedMapping,
  proposedCanonicalMap,
  type CanonicalMap,
  type CanonicalMapEntry,
} from "@/services/tools/operator-db/mapping";
import type { LocationSource, MarketplaceIntelConfig, SupplySource } from "./contract";
import { proposeFromSchema, type ProposalSchema } from "./proposal";

export const SELF_SERVE_PROVENANCE_SOURCE = "self_serve_confirmed";

export const SUPPLY_DEMAND_DIALECTS = ["mongodb", "postgres", "mysql"] as const;
export type SupplyDemandDialect = (typeof SUPPLY_DEMAND_DIALECTS)[number];

export function isSupplyDemandDialect(t: unknown): t is SupplyDemandDialect {
  return (SUPPLY_DEMAND_DIALECTS as readonly unknown[]).includes(t);
}

export const LOCATION_SOURCES: readonly LocationSource[] = ["order", "listing", "user", "none"];
export const SUPPLY_SOURCES: readonly SupplySource[] = ["listings", "sellers_on_orders", "none"];

export type SupplyDemandChoices = { location_source: LocationSource; supply_source: SupplySource };

function isLocationSource(v: unknown): v is LocationSource {
  return (LOCATION_SOURCES as readonly unknown[]).includes(v);
}
function isSupplySource(v: unknown): v is SupplySource {
  return (SUPPLY_SOURCES as readonly unknown[]).includes(v);
}

export const LOCATION_ROLE = "supply_demand_location";
export type SetupRole = "bookings" | "listings" | typeof LOCATION_ROLE;

export function isOptionalField(choices: SupplyDemandChoices, key: string): boolean {
  if (key === "listed_at_field") return true;
  return key === "listing_ref_field" && choices.location_source !== "listing";
}

export function supplyDemandRoles(choices: SupplyDemandChoices): Partial<Record<SetupRole, string[]>> {
  const { location_source: location, supply_source: supply } = choices;
  const bookings = ["created_at_field"];
  if (location === "order") bookings.push("geo_field");
  if (location === "listing" || supply === "listings") bookings.push("listing_ref_field");
  if (location === "user") bookings.push("buyer_ref_field");
  if (supply === "sellers_on_orders") bookings.push("seller_ref_field");

  const roles: Partial<Record<SetupRole, string[]>> = { bookings };
  if (location === "listing" || supply === "listings") {
    const listings = ["id_field"];
    if (location !== "none") listings.push("geo_field");
    if (supply === "listings") listings.push("listed_at_field");
    roles.listings = listings;
  }
  if (location === "user") roles[LOCATION_ROLE] = ["id_field", "geo_field"];
  return roles;
}

export const SUPPLY_DEMAND_OPT_IN_KEY = "supply_demand";

function choicesFromMarker(map: CanonicalMap | null | undefined): SupplyDemandChoices | null {
  const marker = (map as Record<string, unknown> | null | undefined)?.[SUPPLY_DEMAND_OPT_IN_KEY];
  if (!marker || typeof marker !== "object") return null;
  const m = marker as Record<string, unknown>;
  if (m.confirmed !== true) return null;
  if (m.version === undefined) return { location_source: "order", supply_source: "listings" };
  if (!isLocationSource(m.location_source) || !isSupplySource(m.supply_source)) return null;
  return { location_source: m.location_source, supply_source: m.supply_source };
}

export function isSafeMongoName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 256 &&
    !name.startsWith("$") &&
    !name.includes("\0")
  );
}

function fieldOf(entry: CanonicalMapEntry | undefined, key: string): string | null {
  const v = (entry as Record<string, unknown> | undefined)?.[key];
  return isSafeMongoName(v) ? v : null;
}

export function buildSelfServeConfig(
  tenantId: string,
  map: CanonicalMap | null | undefined,
  dialect: SupplyDemandDialect = "mongodb",
  confirmedAt?: string,
  catalogHash?: string,
): MarketplaceIntelConfig | null {
  const choices = choicesFromMarker(map);
  if (!choices || !map) return null;
  const roles = supplyDemandRoles(choices);

  for (const [role, keys] of Object.entries(roles) as Array<[SetupRole, string[]]>) {
    const entry = map[role];
    if (!isSafeMongoName(entry?.table)) return null;
    for (const key of keys) {
      if (isOptionalField(choices, key)) continue;
      if (!fieldOf(entry, key)) return null;
    }
  }

  const uses = (role: SetupRole, key: string) => roles[role]?.includes(key) ?? false;
  const pick = (role: SetupRole, key: string) => (uses(role, key) ? fieldOf(map[role], key) : null);
  const b = map.bookings;
  const l = roles.listings ? map.listings : undefined;
  const u = roles[LOCATION_ROLE] ? map[LOCATION_ROLE] : undefined;

  return {
    tenant_id: tenantId,
    dialect,
    location_source: choices.location_source,
    supply_source: choices.supply_source,
    bookings: {
      table: b.table,
      created_at_field: fieldOf(b, "created_at_field") as string,
      geo_field: pick("bookings", "geo_field"),
      listing_ref_field: pick("bookings", "listing_ref_field"),
      seller_ref_field: pick("bookings", "seller_ref_field"),
      buyer_ref_field: pick("bookings", "buyer_ref_field"),
      gmv_proxy_field: null,
    },
    listings: l
      ? {
          table: l.table,
          id_field: fieldOf(l, "id_field") as string,
          geo_field: pick("listings", "geo_field"),
          listed_at_field: pick("listings", "listed_at_field"),
        }
      : null,
    location_table: u
      ? { table: u.table, id_field: fieldOf(u, "id_field") as string, geo_field: fieldOf(u, "geo_field") as string }
      : null,
    category: {
      source: "none_on_trips",
      note: "category not collected by self-serve setup",
    },
    intent_events: { search: null, view: null, contact: null },
    provenance: {
      source: SELF_SERVE_PROVENANCE_SOURCE,
      validated: true,
      ...(confirmedAt ? { confirmed_at: confirmedAt } : {}),
      ...(confirmedAt && catalogHash ? { setup_id: `${catalogHash}:${confirmedAt}` } : {}),
    },
  };
}

export async function resolveMarketplaceConfig(
  tenantId: string,
): Promise<MarketplaceIntelConfig | null> {
  try {
    const catalog = await getCatalog(tenantId);
    if (!catalog || !isSupplyDemandDialect(catalog.dialect)) return null;
    if (catalog.discovery_error || !catalog.catalog_hash) return null;
    const confirmed = await getConfirmedMapping(tenantId, catalog.catalog_hash);
    return buildSelfServeConfig(
      tenantId,
      confirmed?.confirmed_map,
      catalog.dialect,
      confirmed?.confirmed_at,
      catalog.catalog_hash,
    );
  } catch {
    return null;
  }
}

export type SupplyDemandSetup =
  | { state: "no_db" }
  | { state: "unsupported_db"; db_type: string }
  | { state: "discovering" }
  | { state: "discovery_failed" }
  | {
      state: "needs_confirm";
      catalog_hash: string;
      proposed: Partial<Record<SetupRole, CanonicalMapEntry>>;
      choices: SupplyDemandChoices;
      roles: Partial<Record<SetupRole, string[]>>;
      options: {
        location_source: readonly LocationSource[];
        supply_source: readonly SupplySource[];
        roles_by_pair: Record<string, Partial<Record<SetupRole, string[]>>>;
      };
      schema: { tables: Array<{ name: string; columns: string[] }> };
    }
  | { state: "needs_admin" }
  | { state: "waiting_first_run" };

const ROLE_LABELS: Record<SetupRole, string> = {
  bookings: "Orders",
  listings: "Listings",
  [LOCATION_ROLE]: "Customers",
};

const ALL_FIELDS: Record<SetupRole, string[]> = {
  bookings: ["created_at_field", "geo_field", "listing_ref_field", "buyer_ref_field", "seller_ref_field"],
  listings: ["id_field", "geo_field", "listed_at_field"],
  [LOCATION_ROLE]: ["id_field", "geo_field"],
};

function roleEntry(
  role: SetupRole,
  confirmed: CanonicalMap | undefined,
  proposed: CanonicalMap,
): CanonicalMapEntry {
  const c = confirmed?.[role];
  const p = proposed[role] ?? (role === LOCATION_ROLE ? proposed.users : undefined);
  const out: CanonicalMapEntry = { table: c?.table || p?.table || "", label: ROLE_LABELS[role] };
  for (const key of ALL_FIELDS[role]) {
    const v = fieldOf(c, key) || fieldOf(p, key);
    if (v) (out as Record<string, string>)[key] = v;
  }
  return out;
}

function confirmedEntries(confirmed: CanonicalMap | undefined): Set<string> {
  const out = new Set<string>();
  const pairs = [
    ["bookings", "bookings"],
    ["listings", "listings"],
    ["customers", LOCATION_ROLE],
  ] as const;
  for (const [role, src] of pairs) {
    const entry = confirmed?.[src];
    if (!entry?.table) continue;
    out.add(role);
    for (const key of ALL_FIELDS[src]) if (fieldOf(entry, key)) out.add(`${role}.${key}`);
  }
  return out;
}

function guessChoices(
  proposed: Partial<Record<SetupRole, CanonicalMapEntry>>,
  refusedListings = false,
): SupplyDemandChoices {
  const bookingsGeo = Boolean(proposed.bookings?.geo_field);
  const listingsGeo = Boolean(proposed.listings?.table && proposed.listings?.geo_field);
  const customerGeo = Boolean(
    proposed[LOCATION_ROLE]?.table && proposed[LOCATION_ROLE]?.geo_field && proposed.bookings?.buyer_ref_field,
  );
  return {
    location_source: bookingsGeo ? "order" : listingsGeo ? "listing" : customerGeo ? "user" : "none",
    supply_source: proposed.listings?.table
      ? "listings"
      : proposed.bookings?.seller_ref_field
        ? "sellers_on_orders"
        : refusedListings
          ? "listings"
          : "none",
  };
}

export async function getSupplyDemandSetup(
  tenantId: string,
  opts: { formEvenIfConfirmed?: boolean } = {},
): Promise<SupplyDemandSetup> {
  const dialect = await getDeclaredDialect(tenantId);
  if (!dialect) return { state: "no_db" };
  if (!isSupplyDemandDialect(dialect)) return { state: "unsupported_db", db_type: dialect };

  const catalog = await getCatalog(tenantId);
  if (!catalog) return { state: "discovering" };
  if (catalog.discovery_error || !catalog.catalog_hash) {
    return { state: "discovery_failed" };
  }
  if ((catalog.catalog.tables ?? []).length === 0) {
    return { state: "discovering" };
  }

  const confirmed = await getConfirmedMapping(tenantId, catalog.catalog_hash);
  if (!opts.formEvenIfConfirmed && buildSelfServeConfig(tenantId, confirmed?.confirmed_map)) {
    return { state: "waiting_first_run" };
  }

  const previous = confirmed ?? (await carriedOverConfirmation(tenantId, catalog.catalog));
  const guessed = proposedCanonicalMap(catalog.hints ?? {});
  const hinted = {
    bookings: roleEntry("bookings", previous?.confirmed_map, guessed),
    listings: roleEntry("listings", previous?.confirmed_map, guessed),
    customers: roleEntry(LOCATION_ROLE, previous?.confirmed_map, guessed),
  };
  const coverage = catalog.coverage;
  const catalogIsComplete =
    !coverage ||
    (!coverage.deadline_hit &&
      !coverage.listing_truncated &&
      coverage.tables_indexed >= coverage.tables_total);
  const droppedByName = new Set<string>();
  const grounded = proposeFromSchema(
    catalog.catalog as ProposalSchema,
    hinted,
    {
      bookings: ROLE_LABELS.bookings,
      listings: ROLE_LABELS.listings,
      customers: ROLE_LABELS[LOCATION_ROLE],
    },
    {
      complete: catalogIsComplete,
      confirmed: confirmedEntries(previous?.confirmed_map),
      droppedByName,
    },
  );
  const proposed: Partial<Record<SetupRole, CanonicalMapEntry>> = {
    ...(grounded.bookings ? { bookings: grounded.bookings } : {}),
    ...(grounded.listings ? { listings: grounded.listings } : {}),
    ...(grounded.customers ? { [LOCATION_ROLE]: grounded.customers } : {}),
  };
  const markerChoices = choicesFromMarker(previous?.confirmed_map);
  const choices =
    markerChoices && Object.keys(supplyDemandRoles(markerChoices)).every((role) => proposed[role as SetupRole]?.table)
      ? markerChoices
      : guessChoices(proposed, droppedByName.has("listings"));
  return {
    state: "needs_confirm",
    catalog_hash: catalog.catalog_hash,
    proposed,
    choices,
    roles: supplyDemandRoles(choices),
    options: {
      location_source: LOCATION_SOURCES,
      supply_source: SUPPLY_SOURCES,
      roles_by_pair: Object.fromEntries(
        LOCATION_SOURCES.flatMap((location_source) =>
          SUPPLY_SOURCES.map((supply_source) => [
            `${location_source}|${supply_source}`,
            supplyDemandRoles({ location_source, supply_source }),
          ]),
        ),
      ),
    },
    schema: {
      tables: (catalog.catalog.tables ?? []).map((t) => ({
        name: t.name,
        columns: (t.columns ?? []).map((c) => c.name).filter(Boolean),
      })),
    },
  };
}

async function carriedOverConfirmation(
  tenantId: string,
  catalog: { tables?: Array<{ name: string; columns?: Array<{ name: string }> }> },
): Promise<{ confirmed_map: CanonicalMap } | null> {
  const previous = await getLatestConfirmedMapping(tenantId);
  if (!previous) return null;
  const columnsByTable = new Map(
    (catalog.tables ?? []).map((t) => [t.name, new Set((t.columns ?? []).map((c) => c.name))]),
  );
  for (const role of Object.keys(ALL_FIELDS) as SetupRole[]) {
    const entry = previous.confirmed_map?.[role];
    if (!entry?.table) continue;
    const columns = columnsByTable.get(entry.table);
    if (!columns) return null;
    for (const [key, value] of Object.entries(entry)) {
      if (key === "table" || key === "label" || typeof value !== "string" || !value) continue;
      if (!ALL_FIELDS[role].includes(key)) continue;
      if (!columns.has(value)) return null;
    }
  }
  return previous;
}

export type SupplyDemandAnswersError = {
  error: "invalid_answers";
  field: string;
  reason: "missing" | "not_allowed" | "unsafe_name" | "unknown_column" | "unknown_table";
};

export type SupplyDemandAnswers = {
  location_source?: unknown;
  supply_source?: unknown;
  bookings?: Record<string, unknown>;
  listings?: Record<string, unknown>;
  [LOCATION_ROLE]?: Record<string, unknown>;
};

export function mergeSupplyDemandAnswers(
  existing: CanonicalMap | null | undefined,
  answers: SupplyDemandAnswers,
): { map: CanonicalMap } | SupplyDemandAnswersError {
  const bad = (field: string, reason: SupplyDemandAnswersError["reason"]): SupplyDemandAnswersError => ({
    error: "invalid_answers",
    field,
    reason,
  });
  if (!answers || typeof answers !== "object") return bad("answers", "missing");
  const legacy = answers.location_source === undefined && answers.supply_source === undefined;
  const location = legacy ? "order" : answers.location_source;
  const supply = legacy ? "listings" : answers.supply_source;
  if (!isLocationSource(location)) return bad("location_source", "not_allowed");
  if (!isSupplySource(supply)) return bad("supply_source", "not_allowed");
  const choices: SupplyDemandChoices = { location_source: location, supply_source: supply };

  const merged: CanonicalMap = JSON.parse(JSON.stringify(existing ?? {}));
  for (const [role, keys] of Object.entries(supplyDemandRoles(choices)) as Array<[SetupRole, string[]]>) {
    const a = answers[role];
    if (!a || typeof a !== "object") return bad(`${role}`, "missing");
    const table = (a as Record<string, unknown>).table;
    if (!isSafeMongoName(table)) return bad(`${role}.table`, table ? "unsafe_name" : "missing");
    const entry: Record<string, string> = {
      ...((merged[role] as unknown as Record<string, string>) ?? {}),
      table,
      label:
        role === "bookings"
          ? "Bookings / orders / trips"
          : role === "listings"
            ? "Listings / inventory"
            : "Customers (Supply & Demand location)",
    };
    const prior = merged[role]?.table;
    if (prior && prior !== table) {
      for (const k of Object.keys(entry)) {
        if (k === "field" || k.endsWith("_field")) delete entry[k];
      }
    }
    for (const key of keys) {
      const v = (a as Record<string, unknown>)[key];
      if (v === undefined || v === null || v === "") {
        if (isOptionalField(choices, key)) {
          delete entry[key];
          continue;
        }
        return bad(`${role}.${key}`, "missing");
      }
      if (!isSafeMongoName(v)) return bad(`${role}.${key}`, "unsafe_name");
      entry[key] = v;
    }
    merged[role] = entry as unknown as CanonicalMapEntry;
  }
  (merged as Record<string, unknown>)[SUPPLY_DEMAND_OPT_IN_KEY] = {
    confirmed: true,
    version: 2,
    location_source: choices.location_source,
    supply_source: choices.supply_source,
  };
  return { map: merged };
}
