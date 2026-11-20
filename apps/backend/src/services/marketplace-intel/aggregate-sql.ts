
import type { OperatorDbType } from "@/services/tools/operator-db/types";
import { runCodeActReads } from "@/services/tools/operator-db/codeact-sql";
import type { ReadSession } from "@/services/data-gateway/session";
import {
  activeRefField,
  ALL_LOCATIONS_LABEL,
  regionMappingOf,
  rollupFromKeyedRows,
  type GeoWeekRawRow,
  type MarketplaceTotals,
  type RegionMapping,
  type SupplyRawRow,
} from "./aggregate";
import { buildRegionIndex, NO_LOCATION_REGION, OTHER_REGION, type LocationWeight } from "./regions";
import {
  MIN_CELL_DEFAULT,
  WINDOW_WEEKS_DEFAULT,
  type GeoWeekCell,
  type MarketplaceIntelConfig,
  type SupplySnapshot,
} from "./contract";

export type SqlDialect = Extract<OperatorDbType, "postgres" | "mysql">;

const ZAVI_SQL = { trustedSql: true } as const;

export function isSqlDialect(t: unknown): t is SqlDialect {
  return t === "postgres" || t === "mysql";
}

export function quoteIdent(dialect: SqlDialect, name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 256 || name.includes("\0")) {
    throw new Error("marketplace intel: invalid SQL identifier");
  }
  return dialect === "postgres"
    ? `"${name.replace(/"/g, '""')}"`
    : `\`${name.replace(/`/g, "``")}\``;
}

function windowStartIso(window_weeks: number): string {
  const d = new Date(Date.now() - window_weeks * 7 * 24 * 3600 * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export const SQL_MAX_LOCATIONS = 300;

function textType(dialect: SqlDialect): string {
  return dialect === "postgres" ? "text" : "CHAR";
}

function locationText(dialect: SqlDialect, expr: string): string {
  return dialect === "postgres"
    ? `CAST(${expr} AS text)`
    : `CONVERT(CAST(${expr} AS CHAR) USING utf8mb4) COLLATE utf8mb4_bin`;
}

function locationLiteral(dialect: SqlDialect, value: string): string {
  return dialect === "postgres" ? textLiteral(dialect, value) : `${textLiteral(dialect, value)} COLLATE utf8mb4_bin`;
}

function col(dialect: SqlDialect, alias: string, name: string): string {
  return `${alias}.${quoteIdent(dialect, name)}`;
}

function tsExpr(dialect: SqlDialect, column: string): string {
  if (dialect === "postgres") {
    const txt = `CAST(${column} AS text)`;
    return (
      `(CASE WHEN ${txt} ~ '^[0-9]{13}$' THEN to_timestamp(CAST(${txt} AS numeric) / 1000)` +
      ` WHEN ${txt} ~ '^[0-9]{10}$' THEN to_timestamp(CAST(${txt} AS numeric))` +
      ` ELSE CAST(${txt} AS timestamptz) END AT TIME ZONE 'UTC')`
    );
  }
  const txt = `CAST(${column} AS CHAR)`;
  return (
    `(CASE WHEN ${txt} REGEXP '^[0-9]{13}$' THEN DATE_ADD('1970-01-01 00:00:00', INTERVAL FLOOR(CAST(${txt} AS DECIMAL(20,0)) / 1000) SECOND)` +
    ` WHEN ${txt} REGEXP '^[0-9]{10}$' THEN DATE_ADD('1970-01-01 00:00:00', INTERVAL CAST(${txt} AS DECIMAL(20,0)) SECOND)` +
    ` ELSE CAST(${column} AS DATETIME) END)`
  );
}

export const UNREADABLE_DATE_SHARE = 0.5;

export const DATE_HEALTH_SAMPLE_ROWS = 10_000;

export function dateHealthSql(dialect: SqlDialect, table: string, column: string): string {
  const name = quoteIdent(dialect, column);
  const sample = `(SELECT ${col(dialect, "t", column)} AS ${name} FROM ${quoteIdent(dialect, table)} t WHERE ${col(dialect, "t", column)} IS NOT NULL LIMIT ${DATE_HEALTH_SAMPLE_ROWS})`;
  const c = col(dialect, "d", column);
  return `SELECT COUNT(${c}) AS present, SUM(CASE WHEN ${tsExpr(dialect, c)} IS NULL THEN 1 ELSE 0 END) AS unreadable FROM ${sample} d`;
}

function nowLiteral(dialect: SqlDialect): string {
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  return dialect === "postgres" ? `CAST('${now}' AS timestamp)` : `'${now}'`;
}

function sinceLiteral(dialect: SqlDialect, window_weeks: number): string {
  const since = windowStartIso(window_weeks).slice(0, 19).replace("T", " ");
  return dialect === "postgres" ? `CAST('${since}' AS timestamp)` : `'${since}'`;
}

function oneRowPerId(dialect: SqlDialect, table: string, idField: string, geoField: string): string {
  const t = textType(dialect);
  return `(SELECT CAST(${col(dialect, "j", idField)} AS ${t}) AS jid, MIN(${locationText(dialect, col(dialect, "j", geoField))}) AS geo FROM ${quoteIdent(dialect, table)} j GROUP BY 1)`;
}

export function orderBaseSql(dialect: SqlDialect, cfg: MarketplaceIntelConfig, window_weeks: number): string {
  const t = textType(dialect);
  const b = cfg.bookings;
  const ts = tsExpr(dialect, col(dialect, "b", b.created_at_field));
  const active = activeRefField(cfg);
  const activeExpr = active ? `CAST(${col(dialect, "b", active)} AS ${t})` : "NULL";
  const sellerExpr = b.seller_ref_field ? `CAST(${col(dialect, "b", b.seller_ref_field)} AS ${t})` : "NULL";

  let geo: string;
  let join = "";
  switch (cfg.location_source) {
    case "order":
      geo = locationText(dialect, col(dialect, "b", b.geo_field!));
      break;
    case "listing": {
      const l = cfg.listings!;
      geo = "l.geo";
      join = ` LEFT JOIN ${oneRowPerId(dialect, l.table, l.id_field, l.geo_field!)} l ON l.jid = CAST(${col(dialect, "b", b.listing_ref_field!)} AS ${t})`;
      break;
    }
    case "user": {
      const u = cfg.location_table!;
      geo = "u.geo";
      join = ` LEFT JOIN ${oneRowPerId(dialect, u.table, u.id_field, u.geo_field)} u ON u.jid = CAST(${col(dialect, "b", b.buyer_ref_field!)} AS ${t})`;
      break;
    }
    default:
      geo = locationLiteral(dialect, ALL_LOCATIONS_LABEL);
  }
  return `SELECT ${geo} AS geo, ${ts} AS ts, ${activeExpr} AS active_ref, ${sellerExpr} AS seller_ref FROM ${quoteIdent(dialect, b.table)} b${join} WHERE ${ts} >= ${sinceLiteral(dialect, window_weeks)} AND ${ts} <= ${nowLiteral(dialect)}`;
}

function textLiteral(dialect: SqlDialect, value: string): string {
  const hex = Buffer.from(value, "utf8").toString("hex");
  return dialect === "postgres"
    ? `convert_from(decode('${hex}', 'hex'), 'UTF8')`
    : `CONVERT(X'${hex}' USING utf8mb4)`;
}

function regionKeyCase(dialect: SqlDialect, alias: string, mapping: RegionMapping): string {
  const branches = mapping
    .filter((m) => typeof m.raw === "string")
    .map((m) => ` WHEN ${alias}.geo = ${locationLiteral(dialect, m.raw as string)} THEN ${textLiteral(dialect, m.key)}`)
    .join("");
  return `CASE WHEN ${alias}.geo IS NULL THEN '${NO_LOCATION_REGION}'${branches} ELSE '${OTHER_REGION}' END`;
}

function listingBaseSql(dialect: SqlDialect, cfg: MarketplaceIntelConfig, window_weeks: number): string | null {
  if (cfg.supply_source !== "listings" || !cfg.listings) return null;
  const l = cfg.listings;
  const geo =
    cfg.location_source === "none" || !l.geo_field
      ? locationLiteral(dialect, ALL_LOCATIONS_LABEL)
      : locationText(dialect, col(dialect, "l", l.geo_field));
  const listedTs = l.listed_at_field ? tsExpr(dialect, col(dialect, "l", l.listed_at_field)) : null;
  const where = listedTs
    ? ` WHERE ${listedTs} >= ${sinceLiteral(dialect, window_weeks)} AND ${listedTs} <= ${nowLiteral(dialect)}`
    : "";
  return `SELECT ${geo} AS geo FROM ${quoteIdent(dialect, l.table)} l${where}`;
}

function rankSourceSql(dialect: SqlDialect, cfg: MarketplaceIntelConfig, window_weeks: number): string {
  const orders = `SELECT o0.geo FROM (${orderBaseSql(dialect, cfg, window_weeks)}) o0`;
  const listings = listingBaseSql(dialect, cfg, window_weeks);
  return listings ? `${orders} UNION ALL SELECT l0.geo FROM (${listings}) l0` : orders;
}

export function locationCountsSql(dialect: SqlDialect, cfg: MarketplaceIntelConfig, window_weeks: number): string {
  return `SELECT k.geo AS geo, COUNT(*) AS n FROM (${rankSourceSql(dialect, cfg, window_weeks)}) k GROUP BY k.geo ORDER BY COUNT(*) DESC, k.geo LIMIT ${SQL_MAX_LOCATIONS}`;
}

export function totalsWeekSql(
  dialect: SqlDialect,
  cfg: MarketplaceIntelConfig,
  window_weeks: number,
): string | null {
  if (!activeRefField(cfg)) return null;
  const base = orderBaseSql(dialect, cfg, window_weeks);
  const year = dialect === "postgres" ? "CAST(EXTRACT(ISOYEAR FROM o.ts) AS int)" : "FLOOR(YEARWEEK(o.ts, 3) / 100)";
  const week = dialect === "postgres" ? "CAST(EXTRACT(WEEK FROM o.ts) AS int)" : "MOD(YEARWEEK(o.ts, 3), 100)";
  return `SELECT ${year} AS iso_week_year, ${week} AS iso_week, COUNT(DISTINCT o.active_ref) AS active_supply_n FROM (${base}) o GROUP BY 1, 2`;
}

export function totalsSupplySql(
  dialect: SqlDialect,
  cfg: MarketplaceIntelConfig,
  window_weeks: number,
): string | null {
  if (cfg.supply_source === "sellers_on_orders") {
    return `SELECT COUNT(DISTINCT o.seller_ref) AS n FROM (${orderBaseSql(dialect, cfg, window_weeks)}) o`;
  }
  const base = listingBaseSql(dialect, cfg, window_weeks);
  return base ? `SELECT COUNT(*) AS n FROM (${base}) s` : null;
}

export function geoWeekSql(
  dialect: SqlDialect,
  cfg: MarketplaceIntelConfig,
  window_weeks: number,
  mapping: RegionMapping,
): string {
  const base = orderBaseSql(dialect, cfg, window_weeks);
  const year =
    dialect === "postgres" ? "CAST(EXTRACT(ISOYEAR FROM o.ts) AS int)" : "FLOOR(YEARWEEK(o.ts, 3) / 100)";
  const week = dialect === "postgres" ? "CAST(EXTRACT(WEEK FROM o.ts) AS int)" : "MOD(YEARWEEK(o.ts, 3), 100)";
  return `SELECT ${regionKeyCase(dialect, "o", mapping)} AS geo, ${year} AS iso_week_year, ${week} AS iso_week, COUNT(*) AS bookings_n, COUNT(DISTINCT o.active_ref) AS active_supply_n FROM (${base}) o GROUP BY 1, 2, 3`;
}

export function supplySql(
  dialect: SqlDialect,
  cfg: MarketplaceIntelConfig,
  window_weeks: number,
  mapping: RegionMapping,
): string | null {
  if (cfg.supply_source === "sellers_on_orders") {
    const base = orderBaseSql(dialect, cfg, window_weeks);
    return `SELECT ${regionKeyCase(dialect, "o", mapping)} AS geo, '__all__' AS status, COUNT(DISTINCT o.seller_ref) AS count FROM (${base}) o GROUP BY 1`;
  }
  const base = listingBaseSql(dialect, cfg, window_weeks);
  if (!base) return null;
  return `SELECT ${regionKeyCase(dialect, "s", mapping)} AS geo, '__all__' AS status, COUNT(*) AS count FROM (${base}) s GROUP BY 1`;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function computeSqlRollup(
  dialect: SqlDialect,
  session: ReadSession,
  cfg: MarketplaceIntelConfig,
  opts: { window_weeks?: number; min_cell?: number } = {},
): Promise<{ cells: GeoWeekCell[]; supply: SupplySnapshot[] }> {
  const window_weeks = opts.window_weeks ?? WINDOW_WEEKS_DEFAULT;
  const min_cell = opts.min_cell ?? MIN_CELL_DEFAULT;

  const dateChecks: Array<{ what: string; sql: string }> = [
    { what: "order date field", sql: dateHealthSql(dialect, cfg.bookings.table, cfg.bookings.created_at_field) },
  ];
  if (cfg.supply_source === "listings" && cfg.listings?.listed_at_field) {
    dateChecks.push({ what: "listing date field", sql: dateHealthSql(dialect, cfg.listings.table, cfg.listings.listed_at_field) });
  }
  const health = await runCodeActReads(session, dateChecks.map((d) => d.sql), ZAVI_SQL);
  dateChecks.forEach((check, i) => {
    const row = health[i]?.rows?.[0] ?? {};
    const present = num(row.present);
    if (present > 0 && num(row.unreadable) / present >= UNREADABLE_DATE_SHARE) {
      throw new Error(`marketplace intel: most values in the ${check.what} are not a readable date`);
    }
  });

  const [countsRead] = await runCodeActReads(session, [locationCountsSql(dialect, cfg, window_weeks)], ZAVI_SQL);
  const locations: LocationWeight[] = (countsRead?.rows ?? []).map((r) => ({
    raw: r.geo == null ? null : String(r.geo),
    weight: num(r.n),
  }));
  const index = buildRegionIndex(locations);
  const mapping = regionMappingOf(locations, index);

  const supplyQuery = supplySql(dialect, cfg, window_weeks, mapping);
  const totalsWeekQuery = totalsWeekSql(dialect, cfg, window_weeks);
  const totalsSupplyQuery = totalsSupplySql(dialect, cfg, window_weeks);
  const reads = await runCodeActReads(session, [
    geoWeekSql(dialect, cfg, window_weeks, mapping),
    ...(supplyQuery ? [supplyQuery] : []),
    ...(totalsWeekQuery ? [totalsWeekQuery] : []),
    ...(totalsSupplyQuery ? [totalsSupplyQuery] : []),
  ], ZAVI_SQL);
  let next = 1;
  const geoRead = reads[0];
  const supplyRead = supplyQuery ? reads[next++] : { rows: [], truncated: false };
  const totalsWeekRead = totalsWeekQuery ? reads[next++] : { rows: [], truncated: false };
  const totalsSupplyRead = totalsSupplyQuery ? reads[next++] : { rows: [], truncated: false };
  const totals: MarketplaceTotals = {
    weeks: (totalsWeekRead?.rows ?? []).map((r) => ({
      isoWeekYear: num(r.iso_week_year),
      isoWeek: num(r.iso_week),
      active_supply_n: num(r.active_supply_n),
    })),
    supply_total: totalsSupplyQuery ? num(totalsSupplyRead?.rows?.[0]?.n) : null,
  };
  if (!geoRead || geoRead.truncated || supplyRead.truncated) {
    throw new Error(
      "marketplace intel SQL rollup hit the row cap; refusing to write partial numbers",
    );
  }

  const geoRows: GeoWeekRawRow[] = geoRead.rows.map((r) => ({
    geo: r.geo == null ? NO_LOCATION_REGION : String(r.geo),
    isoWeekYear: num(r.iso_week_year),
    isoWeek: num(r.iso_week),
    bookings_n: num(r.bookings_n),
    active_supply_n: num(r.active_supply_n),
    gmv_proxy_n: null,
  }));
  const supplyRows: SupplyRawRow[] = supplyRead.rows.map((r) => ({
    geo: r.geo == null ? NO_LOCATION_REGION : String(r.geo),
    status: r.status,
    count: num(r.count),
  }));

  return rollupFromKeyedRows(geoRows, supplyRows, cfg, index, { demand_basis: "bookings", min_cell, totals });
}
