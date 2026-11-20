import { MAX_QUERY_BYTES, MAX_ROWS_PER_READ } from "@zavi/shared/db-guard";
import {
  MIN_CELL_DEFAULT,
  WINDOW_WEEKS_DEFAULT,
  type Confidence,
  type GeoWeekCell,
  type MarketplaceIntel,
  type MarketplaceIntelConfig,
  type MarketplaceRegion,
  type SupplySnapshot,
} from "./contract";
import { relativeBalance } from "./balance";
import {
  NO_LOCATION_REGION,
  MARKETPLACE_TOTAL_REGION,
  OTHER_REGION,
  buildRegionIndex,
  isSentinelRegion,
  normalizeLocation,
  type LocationWeight,
  type RegionIndex,
} from "./regions";

export type MarketplaceIntelAggregateCursor<T> = { toArray(): Promise<T[]> };
export type MarketplaceIntelMongoCollection = {
  aggregate<T = unknown>(
    pipeline: unknown[],
    options?: { maxTimeMS?: number; allowDiskUse?: boolean; failIfTruncated?: boolean },
  ): MarketplaceIntelAggregateCursor<T>;
};

export const MONGO_ROLLUP_MAX_TIME_MS = 60_000;

export const ALL_LOCATIONS_LABEL = "All locations";
export type MarketplaceIntelMongoDb = { collection(name: string): MarketplaceIntelMongoCollection };

export type GeoWeekRawRow = {
  geo?: unknown;
  isoWeekYear?: number;
  isoWeek?: number;
  bookings_n?: number;
  active_supply_n?: number;
  active_supply_ids?: unknown[];
  gmv_proxy_n?: number | null;
};

export type SupplyRawRow = {
  status?: unknown;
  geo?: unknown;
  count?: number;
};

export const MARKETPLACE_INTEL_CAVEATS = [
  "booking-based demand, not unmet demand",
  "supply is the listings you have, not proof each one could be booked",
  "supply by location is not measured; showing where orders concentrate only",
  "balance compares each location's orders per unit of supply with your other locations; a location is labelled only when the gap is large and unlikely to be chance; directional, not unmet demand",
] as const;

const MARKETPLACE_INTEL_BASE_CAVEATS = MARKETPLACE_INTEL_CAVEATS.slice(0, 2);

const CONFIDENCE_RANK: Record<Confidence, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const READ_ONLY_MONGO_COMMANDS = new Set([
  "aggregate",
  "count",
  "countDocuments",
  "distinct",
  "estimatedDocumentCount",
  "find",
  "findOne",
  "listCollections",
  "getMore",
  "killCursors",
]);

export function assertReadOnlyMongo(
  command: string | { commandName?: string },
  pipeline: unknown[] = [],
): void {
  const commandName = typeof command === "string" ? command : command.commandName;
  if (!commandName || !READ_ONLY_MONGO_COMMANDS.has(commandName)) {
    throw new Error(`marketplace intel Mongo command is not read-only: ${commandName ?? "unknown"}`);
  }
  assertPipelineDoesNotWrite(pipeline);
}

function assertPipelineDoesNotWrite(pipeline: unknown[]): void {
  for (const stage of pipeline) {
    if (!stage || typeof stage !== "object") continue;
    if ("$out" in stage || "$merge" in stage) {
      throw new Error("marketplace intel Mongo aggregate pipeline must not write");
    }
    const lookup = (stage as { $lookup?: { pipeline?: unknown } }).$lookup;
    if (lookup && Array.isArray(lookup.pipeline)) assertPipelineDoesNotWrite(lookup.pipeline);
  }
}

type FetchOpts = { window_weeks?: number };

const MONGO_GEO = "__zavi_geo";
const MONGO_CREATED = "__zavi_created_at";

const MONGO_REFS = "__zavi_refs";

const MONGO_NO_REF = "\u0000zavi:no-ref";

function mongoRefCandidates(refField: string): unknown {
  const v = `$${refField}`;
  const scalar = { $not: [{ $in: [{ $type: v }, ["array", "object", "missing", "null"]] }] };
  const forms = [
    { $cond: [scalar, v, null] },
    { $cond: [scalar, { $convert: { input: v, to: "string", onError: null, onNull: null } }, null] },
    { $convert: { input: v, to: "objectId", onError: null, onNull: null } },
    {
      $cond: [
        { $and: [{ $eq: [{ $type: v }, "string"] }, { $regexMatch: { input: v, regex: "^-?(0|[1-9][0-9]{0,17})$" } }] },
        { $toLong: v },
        null,
      ],
    },
  ];
  return {
    $let: {
      vars: { refs: { $filter: { input: forms, cond: { $ne: [{ $ifNull: ["$$this", null] }, null] } } } },
      in: { $cond: [{ $gt: [{ $size: "$$refs" }, 0] }, "$$refs", [{ $literal: MONGO_NO_REF }]] },
    },
  };
}

function mongoOrderStages(cfg: MarketplaceIntelConfig, windowStart: Date): unknown[] {
  const b = cfg.bookings;
  const stages: unknown[] = [
    {
      $addFields: {
        [MONGO_CREATED]: {
          ...mongoDateExpr(`$${b.created_at_field}`),
        },
      },
    },
    { $match: { [MONGO_CREATED]: { $gte: windowStart, $lte: new Date() } } },
  ];

  const lookup = (from: string, idField: string, refField: string, geoField: string) => [
    { $addFields: { [MONGO_REFS]: mongoRefCandidates(refField) } },
    {
      $lookup: {
        from,
        localField: MONGO_REFS,
        foreignField: idField,
        pipeline: [
          { $limit: 1 },
          { $project: { _id: 0, g: `$${geoField}` } },
        ],
        as: "__zavi_loc",
      },
    },
    { $addFields: { [MONGO_GEO]: { $arrayElemAt: ["$__zavi_loc.g", 0] } } },
    { $project: { __zavi_loc: 0, [MONGO_REFS]: 0 } },
  ];

  switch (cfg.location_source) {
    case "order":
      stages.push({ $addFields: { [MONGO_GEO]: `$${b.geo_field}` } });
      break;
    case "listing":
      stages.push(...lookup(cfg.listings!.table, cfg.listings!.id_field, b.listing_ref_field!, cfg.listings!.geo_field!));
      break;
    case "user":
      stages.push(
        ...lookup(cfg.location_table!.table, cfg.location_table!.id_field, b.buyer_ref_field!, cfg.location_table!.geo_field),
      );
      break;
    case "none":
      stages.push({ $addFields: { [MONGO_GEO]: { $literal: ALL_LOCATIONS_LABEL } } });
      break;
  }
  return stages;
}

export function activeRefField(cfg: MarketplaceIntelConfig): string | null {
  if (cfg.supply_source === "sellers_on_orders") return cfg.bookings.seller_ref_field ?? null;
  return cfg.bookings.listing_ref_field ?? null;
}

function mongoDateExpr(path: string): { $let: unknown } {
  return {
    $let: {
      vars: { v: path, t: { $type: path } },
      in: {
        $switch: {
          branches: [
            { case: { $eq: ["$$t", "date"] }, then: "$$v" },
            {
              case: { $in: ["$$t", ["int", "long", "double", "decimal"]] },
              then: {
                $toDate: {
                  $cond: [{ $and: [{ $gte: ["$$v", 1e9] }, { $lt: ["$$v", 1e10] }] }, { $multiply: ["$$v", 1000] }, "$$v"],
                },
              },
            },
            {
              case: { $and: [{ $eq: ["$$t", "string"] }, { $regexMatch: { input: "$$v", regex: "^[0-9]{13}$" } }] },
              then: { $toDate: { $toLong: "$$v" } },
            },
            {
              case: { $and: [{ $eq: ["$$t", "string"] }, { $regexMatch: { input: "$$v", regex: "^[0-9]{10}$" } }] },
              then: { $toDate: { $multiply: [{ $toLong: "$$v" }, 1000] } },
            },
          ],
          default: { $convert: { input: "$$v", to: "date", onError: null, onNull: null } },
        },
      },
    },
  };
}

const MONGO_UNREADABLE_DATE_SHARE = 0.5;

export const MONGO_DATE_SAMPLE_ROWS = Math.min(10_000, MAX_ROWS_PER_READ);

async function assertMongoDatesReadable(
  db: MarketplaceIntelMongoDb,
  collection: string,
  field: string,
  what: string,
): Promise<void> {
  const [row] = await runMongo<{ present: number; unreadable: number }>(db, collection, [
    { $match: { [field]: { $exists: true, $nin: [null, ""] } } },
    { $limit: MONGO_DATE_SAMPLE_ROWS },
    { $group: { _id: null, present: { $sum: 1 }, unreadable: { $sum: { $cond: [{ $eq: [mongoDateExpr(`$${field}`), null] }, 1, 0] } } } },
  ]);
  if (row && row.present > 0 && row.unreadable / row.present >= MONGO_UNREADABLE_DATE_SHARE) {
    throw new Error(`marketplace intel: most values in the ${what} are not a readable date`);
  }
}

export type RegionMapping = Array<{ raw: unknown; key: string; weight?: number }>;

export const MAX_RAW_LOCATIONS = 300;

function mongoKeyStage(mapping: RegionMapping): unknown {
  const rawsByKey = new Map<string, unknown[]>();
  for (const { raw, key } of mapping) rawsByKey.set(key, [...(rawsByKey.get(key) ?? []), raw]);
  return {
    $addFields: {
      [MONGO_KEY]: {
        $switch: {
          branches: [
            { case: { $eq: [{ $ifNull: [`$${MONGO_GEO}`, null] }, null] }, then: { $literal: NO_LOCATION_REGION } },
            ...[...rawsByKey].map(([key, raws]) => ({
              case: { $in: [`$${MONGO_GEO}`, { $literal: raws }] },
              then: { $literal: key },
            })),
          ],
          default: { $literal: OTHER_REGION },
        },
      },
    },
  };
}

export function fitMappingToGuard(mapping: RegionMapping, build: (m: RegionMapping) => unknown[][]): RegionMapping {
  const fitsAll = (m: RegionMapping) => build(m).every((p) => JSON.stringify(p).length <= MAX_QUERY_BYTES);
  if (fitsAll(mapping)) return mapping;
  const totals = new Map<string, number>();
  mapping.forEach((e, i) => {
    if (e.key === OTHER_REGION) return;
    totals.set(e.key, (totals.get(e.key) ?? 0) + (e.weight ?? mapping.length - i));
  });
  const keys = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)!);
  const withKeys = (n: number) => {
    const kept = new Set(keys.slice(0, n));
    return mapping.filter((e) => kept.has(e.key));
  };
  const fits = (n: number) => fitsAll(withKeys(n));
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return withKeys(lo);
}

const MONGO_KEY = "__zavi_key";

function mongoListingStages(cfg: MarketplaceIntelConfig, windowStart: Date): unknown[] | null {
  if (cfg.supply_source !== "listings" || !cfg.listings) return null;
  const l = cfg.listings;
  const stages: unknown[] = [];
  if (l.listed_at_field) {
    stages.push(
      {
        $addFields: {
          [MONGO_CREATED]: {
            ...mongoDateExpr(`$${l.listed_at_field}`),
          },
        },
      },
      { $match: { [MONGO_CREATED]: { $gte: windowStart, $lte: new Date() } } },
    );
  }
  stages.push({
    $addFields: {
      [MONGO_GEO]: cfg.location_source === "none" || !l.geo_field ? { $literal: ALL_LOCATIONS_LABEL } : `$${l.geo_field}`,
    },
  });
  return stages;
}

function mongoDistinctCountStages(groupKey: Record<string, unknown> | null, ref: string | null): unknown[] {
  const key = groupKey ?? {};
  const outerKey = Object.fromEntries(Object.keys(key).map((k) => [k, `$_id.${k}`]));
  return [
    { $group: { _id: { ...key, r: ref ? `$${ref}` : { $literal: null } }, rows: { $sum: 1 } } },
    {
      $group: {
        _id: groupKey ? outerKey : null,
        rows: { $sum: "$rows" },
        distinct_n: { $sum: { $cond: [{ $eq: [{ $ifNull: ["$_id.r", null] }, null] }, 0, 1] } },
      },
    },
  ];
}

async function runMongo<T>(db: MarketplaceIntelMongoDb, collection: string, pipeline: unknown[]): Promise<T[]> {
  assertReadOnlyMongo("aggregate", pipeline);
  return db
    .collection(collection)
    .aggregate<T>(pipeline, { maxTimeMS: MONGO_ROLLUP_MAX_TIME_MS, allowDiskUse: true, failIfTruncated: true })
    .toArray();
}

export async function fetchMongoLocationCounts(
  db: MarketplaceIntelMongoDb,
  cfg: MarketplaceIntelConfig,
  opts: FetchOpts = {},
): Promise<LocationWeight[]> {
  const windowStart = windowStartOf(opts);
  const count = [
    { $group: { _id: `$${MONGO_GEO}`, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: MAX_RAW_LOCATIONS },
  ];
  const sources = [runMongo<{ _id: unknown; n: number }>(db, cfg.bookings.table, [...mongoOrderStages(cfg, windowStart), ...count])];
  const listingStages = mongoListingStages(cfg, windowStart);
  if (listingStages) sources.push(runMongo(db, cfg.listings!.table, [...listingStages, ...count]));
  const merged = new Map<string, LocationWeight>();
  for (const rows of await Promise.all(sources)) {
    for (const row of rows) {
      const id = JSON.stringify(row._id ?? null);
      const entry = merged.get(id) ?? { raw: row._id ?? null, weight: 0 };
      entry.weight += Number(row.n ?? 0);
      merged.set(id, entry);
    }
  }
  return [...merged.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_RAW_LOCATIONS);
}

export type MarketplaceTotals = {
  weeks: Array<{ isoWeekYear: number; isoWeek: number; active_supply_n: number }>;
  supply_total: number | null;
};

export async function fetchMongoMarketplaceTotals(
  db: MarketplaceIntelMongoDb,
  cfg: MarketplaceIntelConfig,
  opts: FetchOpts = {},
): Promise<MarketplaceTotals> {
  const windowStart = windowStartOf(opts);
  const activeRef = activeRefField(cfg);
  const weeks = activeRef
    ? await runMongo<{ isoWeekYear: number; isoWeek: number; active_supply_n: number }>(db, cfg.bookings.table, [
        ...mongoOrderStages(cfg, windowStart),
        ...mongoDistinctCountStages({ y: { $isoWeekYear: `$${MONGO_CREATED}` }, w: { $isoWeek: `$${MONGO_CREATED}` } }, activeRef),
        { $project: { _id: 0, isoWeekYear: "$_id.y", isoWeek: "$_id.w", active_supply_n: "$distinct_n" } },
      ])
    : [];

  let supply_total: number | null = null;
  if (cfg.supply_source === "sellers_on_orders" && cfg.bookings.seller_ref_field) {
    const [row] = await runMongo<{ n: number }>(db, cfg.bookings.table, [
      ...mongoOrderStages(cfg, windowStart),
      ...mongoDistinctCountStages(null, cfg.bookings.seller_ref_field),
      { $project: { _id: 0, n: "$distinct_n" } },
    ]);
    supply_total = row?.n ?? 0;
  } else if (cfg.supply_source === "listings") {
    const listingStages = mongoListingStages(cfg, windowStart);
    if (listingStages) {
      const [row] = await runMongo<{ n: number }>(db, cfg.listings!.table, [...listingStages, { $count: "n" }]);
      supply_total = row?.n ?? 0;
    }
  }
  return { weeks, supply_total };
}

function mongoGeoWeekPipeline(cfg: MarketplaceIntelConfig, mapping: RegionMapping, opts: FetchOpts): unknown[] {
  const activeRef = activeRefField(cfg);
  return [
    ...mongoOrderStages(cfg, windowStartOf(opts)),
    mongoKeyStage(mapping),
    ...mongoDistinctCountStages(
      {
        geo: `$${MONGO_KEY}`,
        isoWeekYear: { $isoWeekYear: `$${MONGO_CREATED}` },
        isoWeek: { $isoWeek: `$${MONGO_CREATED}` },
      },
      activeRef,
    ),
    {
      $project: {
        _id: 0,
        geo: "$_id.geo",
        isoWeekYear: "$_id.isoWeekYear",
        isoWeek: "$_id.isoWeek",
        bookings_n: "$rows",
        active_supply_n: "$distinct_n",
        gmv_proxy_n: { $literal: null },
      },
    },
  ];
}

export async function fetchMongoGeoWeekRows(
  db: MarketplaceIntelMongoDb,
  cfg: MarketplaceIntelConfig,
  mapping: RegionMapping,
  opts: FetchOpts = {},
): Promise<GeoWeekRawRow[]> {
  return runMongo<GeoWeekRawRow>(db, cfg.bookings.table, mongoGeoWeekPipeline(cfg, mapping, opts));
}

export async function fetchMongoSupplyRows(
  db: MarketplaceIntelMongoDb,
  cfg: MarketplaceIntelConfig,
  mapping: RegionMapping,
  opts: FetchOpts = {},
): Promise<SupplyRawRow[]> {
  const read = mongoSupplyRead(cfg, mapping, opts);
  return read ? runMongo<SupplyRawRow>(db, read.collection, read.pipeline) : [];
}

function mongoSupplyRead(
  cfg: MarketplaceIntelConfig,
  mapping: RegionMapping,
  opts: FetchOpts,
): { collection: string; pipeline: unknown[] } | null {
  const windowStart = windowStartOf(opts);
  if (cfg.supply_source === "sellers_on_orders") {
    return {
      collection: cfg.bookings.table,
      pipeline: [
        ...mongoOrderStages(cfg, windowStart),
        mongoKeyStage(mapping),
        ...mongoDistinctCountStages({ geo: `$${MONGO_KEY}` }, cfg.bookings.seller_ref_field),
        { $project: { _id: 0, geo: "$_id.geo", status: { $literal: "__all__" }, count: "$distinct_n" } },
      ],
    };
  }
  const listingStages = mongoListingStages(cfg, windowStart);
  if (!listingStages) return null;
  return {
    collection: cfg.listings!.table,
    pipeline: [
      ...listingStages,
      mongoKeyStage(mapping),
      { $group: { _id: `$${MONGO_KEY}`, count: { $sum: 1 } } },
      { $project: { _id: 0, geo: "$_id", status: { $literal: "__all__" }, count: 1 } },
    ],
  };
}

function windowStartOf(opts: FetchOpts): Date {
  const window_weeks = opts.window_weeks ?? WINDOW_WEEKS_DEFAULT;
  return startOfUtcDay(addUtcDays(new Date(), -(window_weeks * 7)));
}

export function regionMappingOf(locations: LocationWeight[], index: RegionIndex): RegionMapping {
  return locations
    .filter((l) => l.raw !== null && l.raw !== undefined)
    .map((l) => ({ raw: l.raw, key: index.resolve(l.raw).key, weight: l.weight }));
}

export async function computeMongoRollup(
  db: MarketplaceIntelMongoDb,
  cfg: MarketplaceIntelConfig,
  opts: { window_weeks?: number; min_cell?: number } = {},
): Promise<{ cells: GeoWeekCell[]; supply: SupplySnapshot[] }> {
  await assertMongoDatesReadable(db, cfg.bookings.table, cfg.bookings.created_at_field, "order date field");
  if (cfg.supply_source === "listings" && cfg.listings?.listed_at_field) {
    await assertMongoDatesReadable(db, cfg.listings.table, cfg.listings.listed_at_field, "listing date field");
  }
  const locations = await fetchMongoLocationCounts(db, cfg, opts);
  const index = buildRegionIndex(locations);
  const fullMapping = regionMappingOf(locations, index);
  const mapping = fitMappingToGuard(fullMapping, (m) => {
    const supplyRead = mongoSupplyRead(cfg, m, opts);
    return supplyRead ? [mongoGeoWeekPipeline(cfg, m, opts), supplyRead.pipeline] : [mongoGeoWeekPipeline(cfg, m, opts)];
  });
  const movedToOther = fullMapping.filter((e) => e.key !== OTHER_REGION).length - mapping.filter((e) => e.key !== OTHER_REGION).length;
  if (movedToOther > 0) {
    console.warn(JSON.stringify({ evt: "marketplace_rollup.locations_cut", tenant_id: cfg.tenant_id, kept: mapping.length, moved_to_other: movedToOther }));
  }
  const geoRows = await fetchMongoGeoWeekRows(db, cfg, mapping, opts);
  const supplyRows = await fetchMongoSupplyRows(db, cfg, mapping, opts);
  const totals = await fetchMongoMarketplaceTotals(db, cfg, opts);
  return rollupFromKeyedRows(geoRows, supplyRows, cfg, index, {
    demand_basis: demandBasisFor(cfg),
    min_cell: opts.min_cell ?? MIN_CELL_DEFAULT,
    totals,
  });
}

export function activeSupplyUnitOf(cfg: MarketplaceIntelConfig): "listings" | "sellers" | null {
  if (!activeRefField(cfg)) return null;
  return cfg.supply_source === "sellers_on_orders" ? "sellers" : "listings";
}

export function supplyUnitOf(
  cfg: MarketplaceIntelConfig,
): "listings_created" | "listings" | "active_sellers" | null {
  if (cfg.supply_source === "sellers_on_orders") return "active_sellers";
  if (cfg.supply_source === "listings") return cfg.listings?.listed_at_field ? "listings_created" : "listings";
  return null;
}

export function regionKeyOf(row: { state: string | null; geo_label: string | null }): string {
  if (row.state) return row.state;
  const label = row.geo_label ?? "";
  if (label === "unknown_state") return OTHER_REGION;
  return normalizeLocation(label) || NO_LOCATION_REGION;
}

export function rollupFromKeyedRows(
  geoRows: GeoWeekRawRow[],
  supplyRows: SupplyRawRow[],
  cfg: MarketplaceIntelConfig,
  index: RegionIndex,
  opts: { demand_basis: "bookings" | "intent_events"; min_cell: number; totals?: MarketplaceTotals },
): { cells: GeoWeekCell[]; supply: SupplySnapshot[] } {
  const cells = geoWeekCellsFromRows(geoRows, cfg, index, opts);
  const supply = cfg.supply_source !== "none" ? supplySnapshotsFromRows(supplyRows, cfg, index) : [];
  if (opts.totals) {
    cells.push(...totalCells(opts.totals, cfg, opts.demand_basis));
    const snapshot = totalSnapshot(opts.totals, cfg);
    if (snapshot) supply.push(snapshot);
  }
  return { cells, supply };
}

function totalCells(
  totals: MarketplaceTotals,
  cfg: MarketplaceIntelConfig,
  demand_basis: "bookings" | "intent_events",
): GeoWeekCell[] {
  return totals.weeks
    .filter((w) => w.isoWeekYear && w.isoWeek)
    .map((w) => ({
      tenant_id: cfg.tenant_id,
      state: null,
      geo_label: MARKETPLACE_TOTAL_REGION,
      week_start: isoWeekStart(w.isoWeekYear, w.isoWeek),
      bookings_n: 0,
      active_supply_n: Number(w.active_supply_n ?? 0),
      gmv_proxy_n: null,
      demand_basis,
      supply_basis: "booked_listings" as const,
      confidence: demand_basis === "bookings" ? ("medium" as const) : ("high" as const),
      suppressed: true,
    }));
}

function totalSnapshot(totals: MarketplaceTotals, cfg: MarketplaceIntelConfig): SupplySnapshot | null {
  if (cfg.supply_source === "none" || totals.supply_total == null) return null;
  return {
    tenant_id: cfg.tenant_id,
    state: null,
    geo_label: MARKETPLACE_TOTAL_REGION,
    total_listings: totals.supply_total,
    completed_listings: totals.supply_total,
    basis: "listing_status",
    confidence: "medium",
    as_of: new Date().toISOString(),
  };
}

function geoWeekCellsFromRows(
  rows: GeoWeekRawRow[],
  cfg: MarketplaceIntelConfig,
  index: RegionIndex,
  opts: { demand_basis: "bookings" | "intent_events"; min_cell: number },
): GeoWeekCell[] {
  const { demand_basis, min_cell } = opts;
  const confidence: Confidence = demand_basis === "bookings" ? "medium" : "high";
  const byRegionWeek = new Map<string, {
    tenant_id: string;
    state: string | null;
    geo_label: string;
    week_start: string;
    bookings_n: number;
    active_supply_n: number;
    active_supply_ids: Set<unknown>;
    gmv_proxy_n: number | null;
    confidence: Confidence;
  }>();

  for (const row of rows) {
    if (!row.isoWeekYear || !row.isoWeek) continue;

    const region = index.regionForKey(String(row.geo ?? ""));
    const week_start = isoWeekStart(row.isoWeekYear, row.isoWeek);
    const key = `${region.key}\u0000${week_start}`;
    const existing = byRegionWeek.get(key);
    const bookings_n = Number(row.bookings_n ?? 0);
    const ids = Array.isArray(row.active_supply_ids)
      ? row.active_supply_ids.filter((id) => id != null && id !== "")
      : [];
    const active_supply_n = Number(row.active_supply_n ?? ids.length ?? 0);
    const gmv_proxy_n = row.gmv_proxy_n == null ? null : Number(row.gmv_proxy_n);

    if (existing) {
      existing.bookings_n += bookings_n;
      if (ids.length) {
        for (const id of ids) existing.active_supply_ids.add(id);
        existing.active_supply_n = existing.active_supply_ids.size;
      } else {
        existing.active_supply_n += active_supply_n;
      }
      existing.gmv_proxy_n =
        existing.gmv_proxy_n == null && gmv_proxy_n == null
          ? null
          : Number(existing.gmv_proxy_n ?? 0) + Number(gmv_proxy_n ?? 0);
      continue;
    }

    byRegionWeek.set(key, {
      tenant_id: cfg.tenant_id,
      state: region.state,
      geo_label: region.label,
      week_start,
      bookings_n,
      active_supply_n,
      active_supply_ids: new Set(ids),
      gmv_proxy_n,
      confidence,
    });
  }

  return [...byRegionWeek.values()]
    .map(({ active_supply_ids: _active_supply_ids, ...cell }) => ({
      ...cell,
      demand_basis,
      supply_basis: "booked_listings" as const,
      suppressed: cell.bookings_n < min_cell,
    }))
    .sort((a, b) => a.week_start.localeCompare(b.week_start) || a.geo_label.localeCompare(b.geo_label));
}

function supplySnapshotsFromRows(
  rows: SupplyRawRow[],
  cfg: MarketplaceIntelConfig,
  index: RegionIndex,
): SupplySnapshot[] {
  const as_of = new Date().toISOString();

  const byRegion = new Map<string, SupplySnapshot>();
  for (const row of rows) {
    const region = index.regionForKey(String(row.geo ?? ""));
    const existing =
      byRegion.get(region.key) ??
      ({
        tenant_id: cfg.tenant_id,
        state: region.state,
        geo_label: region.label,
        total_listings: 0,
        completed_listings: 0,
        basis: "listing_status",
        confidence: "medium",
        as_of,
      } satisfies SupplySnapshot);

    const count = Number(row.count ?? 0);
    existing.total_listings += count;
    existing.completed_listings += count;
    byRegion.set(region.key, existing);
  }

  return [...byRegion.values()].sort((a, b) => a.geo_label.localeCompare(b.geo_label));
}

const REGION_DISPLAY: Record<string, string> = {
  [OTHER_REGION]: "Other locations",
  [NO_LOCATION_REGION]: "No location",
};

export function confidenceForVolume(bookings_n: number, min_cell: number): Confidence {
  const floor = Math.max(1, min_cell);
  if (bookings_n <= 0) return "none";
  if (bookings_n < floor) return "low";
  if (bookings_n < floor * 6) return "medium";
  return "high";
}

export function assembleIntel(
  cells: GeoWeekCell[],
  supply: SupplySnapshot[],
  opts: {
    tenant_id: string;
    configured?: boolean;
    as_of?: string;
    window_weeks?: number;
    min_cell?: number;
    provenance?: { source: string; validated: boolean; confirmed_at?: string; setup_id?: string };
    labels_allowed?: boolean;
  },
): MarketplaceIntel {
  const configured = opts.configured ?? true;
  const window_weeks = opts.window_weeks ?? WINDOW_WEEKS_DEFAULT;
  const min_cell = opts.min_cell ?? MIN_CELL_DEFAULT;
  const as_of = opts.as_of ?? new Date().toISOString();
  const demand_basis = cells.some((cell) => cell.demand_basis === "intent_events")
    ? "intent_events"
    : "bookings";

  const totalSupply = supply.find((s) => regionKeyOf(s) === MARKETPLACE_TOTAL_REGION) ?? null;
  const totalWeeks = new Map<string, number>();
  for (const cell of cells) {
    if (regionKeyOf(cell) === MARKETPLACE_TOTAL_REGION) {
      totalWeeks.set(cell.week_start, (totalWeeks.get(cell.week_start) ?? 0) + cell.active_supply_n);
    }
  }
  const hasMarketplaceTotals = totalWeeks.size > 0 || totalSupply != null;
  cells = cells.filter((cell) => regionKeyOf(cell) !== MARKETPLACE_TOTAL_REGION);
  supply = supply.filter((s) => regionKeyOf(s) !== MARKETPLACE_TOTAL_REGION);

  const supplyByRegion = new Map<string, SupplySnapshot>();
  for (const snapshot of supply) {
    const key = regionKeyOf(snapshot);
    const existing = supplyByRegion.get(key);
    if (existing) {
      existing.total_listings += snapshot.total_listings;
      existing.completed_listings += snapshot.completed_listings;
    } else {
      supplyByRegion.set(key, { ...snapshot });
    }
  }

  const regionRollup = new Map<string, {
    state: string | null;
    geo_label: string;
    bookings_n: number;
    active_supply_n: number;
    confidence: Confidence;
  }>();
  const weekRollup = new Map<string, { week_start: string; bookings_n: number; active_supply_n: number }>();
  let totalBookings = 0;
  let totalActiveSupply = 0;

  for (const cell of cells) {
    const key = regionKeyOf(cell);
    const existing =
      regionRollup.get(key) ??
      { state: cell.state, geo_label: cell.geo_label, bookings_n: 0, active_supply_n: 0, confidence: cell.confidence };
    existing.bookings_n += cell.bookings_n;
    existing.active_supply_n += cell.active_supply_n;
    existing.confidence = capConfidence(existing.confidence, cell.confidence);
    regionRollup.set(key, existing);

    const week =
      weekRollup.get(cell.week_start) ??
      { week_start: cell.week_start, bookings_n: 0, active_supply_n: 0 };
    week.bookings_n += cell.bookings_n;
    week.active_supply_n += cell.active_supply_n;
    weekRollup.set(cell.week_start, week);

    totalBookings += cell.bookings_n;
    totalActiveSupply += cell.active_supply_n;
  }
  for (const [key, snapshot] of supplyByRegion) {
    if (regionRollup.has(key)) continue;
    regionRollup.set(key, {
      state: snapshot.state,
      geo_label: snapshot.geo_label,
      bookings_n: 0,
      active_supply_n: 0,
      confidence: snapshot.confidence,
    });
  }

  const balance = relativeBalance(
    [...regionRollup.entries()].map(([key, region]) => ({
      key,
      demand: region.bookings_n,
      supply: supplyByRegion.get(key)?.completed_listings ?? null,
    })),
    { min_demand: min_cell },
  );
  const labels_allowed = opts.labels_allowed ?? true;

  const regions: MarketplaceRegion[] = [...regionRollup.entries()]
    .map(([key, region]) => {
      const snapshot = supplyByRegion.get(key);
      const result = balance.get(key);
      return {
        region_key: key,
        region_label: REGION_DISPLAY[key] ?? region.geo_label,
        state: region.state,
        bookings_n: region.bookings_n,
        active_supply_n: region.active_supply_n,
        total_listings: snapshot?.total_listings ?? null,
        completed_listings: snapshot?.completed_listings ?? null,
        balance_label: labels_allowed ? (result?.label ?? "insufficient_data") : "not_compared",
        demand_index: labels_allowed ? (result?.demand_index ?? null) : null,
        confidence:
          demand_basis !== "bookings"
            ? region.confidence
            : isSentinelRegion(key)
              ? capConfidence(confidenceForVolume(region.bookings_n, min_cell), "medium")
              : confidenceForVolume(region.bookings_n, min_cell),
        suppressed: region.bookings_n < min_cell,
      };
    })
    .sort(
      (a, b) =>
        Number(isSentinelRegion(a.region_key)) - Number(isSentinelRegion(b.region_key)) ||
        b.bookings_n - a.bookings_n ||
        a.region_label.localeCompare(b.region_label),
    );

  const hasSupplyByRegion = supplyByRegion.size > 0;
  const caveats: string[] = [...MARKETPLACE_INTEL_BASE_CAVEATS];
  if (!hasSupplyByRegion) caveats.push(MARKETPLACE_INTEL_CAVEATS[2]);
  caveats.push(MARKETPLACE_INTEL_CAVEATS[3]);

  const totalListings = totalSupply ? totalSupply.total_listings : null;
  const weeks = [...weekRollup.values()]
    .map((week) => ({
      ...week,
      active_supply_n: hasMarketplaceTotals ? (totalWeeks.get(week.week_start) ?? 0) : week.active_supply_n,
    }))
    .sort((a, b) => a.week_start.localeCompare(b.week_start));
  const totalActive = hasMarketplaceTotals
    ? weeks.reduce((sum, week) => sum + week.active_supply_n, 0)
    : totalActiveSupply;

  return {
    tenant_id: opts.tenant_id,
    configured,
    as_of,
    window_weeks,
    min_cell,
    demand_basis,
    grouped_by: regions.some((region) => region.state) ? "us_state" : "location",
    regions,
    weeks,
    provenance: {
      source: opts.provenance?.source ?? "unknown",
      validated: opts.provenance?.validated ?? false,
      ...(opts.provenance?.confirmed_at ? { confirmed_at: opts.provenance.confirmed_at } : {}),
      ...(opts.provenance?.setup_id ? { setup_id: opts.provenance.setup_id } : {}),
      caveats,
    },
    total: {
      bookings_n: totalBookings,
      active_supply_n: totalActive,
      total_listings: totalListings,
    },
  };
}

export function demandBasisFor(cfg: MarketplaceIntelConfig): "bookings" | "intent_events" {
  return cfg.intent_events.search || cfg.intent_events.view || cfg.intent_events.contact
    ? "intent_events"
    : "bookings";
}

function capConfidence(confidence: Confidence, max: Confidence): Confidence {
  return CONFIDENCE_RANK[confidence] <= CONFIDENCE_RANK[max] ? confidence : max;
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoWeekStart(isoWeekYear: number, isoWeek: number): string {
  const jan4 = new Date(Date.UTC(isoWeekYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const weekOneMonday = new Date(jan4);
  weekOneMonday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  weekOneMonday.setUTCDate(weekOneMonday.getUTCDate() + (isoWeek - 1) * 7);
  return weekOneMonday.toISOString().slice(0, 10);
}
