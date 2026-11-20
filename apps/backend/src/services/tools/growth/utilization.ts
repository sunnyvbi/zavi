
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ExpectedToolError, type ToolContext, type ToolSpec } from "@/services/tools/types";
import { isHumanAuthoredChat } from "@/services/agents/untrusted-context";
import { isTenantOwnerOrAdmin } from "@/services/analytics/data-notes";
import { getCatalog, type ResolvedCatalog } from "@/services/tools/operator-db/catalog";
import type { CatalogColumn, DiscoveryCoverage } from "@/services/tools/operator-db/types";
import { withReadSession } from "@/services/data-gateway";
import { GatewayRefusal } from "@/services/data-gateway/types";
import { isMongoTimeout } from "@zavi/shared/db-guard";
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { fieldInColumns, mongoField, pgIdent } from "@/services/growth/booking-metrics/outcomes";
import {
  DataChangedDuringReadError,
  TooManyLocationsError,
  MAX_LOCATIONS,
  isNativeTime,
  keyFamilyOf,
  mapFieldsByTable,
  mongoRefConvertible,
  readUtilization,
  type KeyFamily,
  type Scalar,
  type UtilEngine,
  type UtilizationMap,
  type UtilizationResult,
} from "@/services/growth/booking-metrics/utilization";

const DAY_MS = 86_400_000;

export type SavedConfig = UtilizationMap & { source_epoch: number; updated_at: string; confirmed_at: string };

export type UtilizationDeps = {
  getConfig: (tenant_id: string) => Promise<SavedConfig | null>;
  getSourceEpoch: (tenant_id: string) => Promise<number>;
  getCatalog: (tenant_id: string) => Promise<ResolvedCatalog | null>;
  getBookingHint: (tenant_id: string) => Promise<{ table: string; status_field: string | null } | null>;
  compute: (ctx: ToolContext, engine: UtilEngine, map: UtilizationMap, family: KeyFamily, w: { since: Date; until: Date; limit: number }) => Promise<UtilizationResult>;
  isOwnerOrAdmin: (tenant_id: string, user_id: string) => Promise<boolean>;
  confirm: (args: { tenant_id: string; confirmed_by: string; expected_updated_at: string | null; source_epoch: number; map: UtilizationMap }) => Promise<void>;
  now: () => Date;
};

const scalarList = (v: unknown): Scalar[] | null =>
  Array.isArray(v) ? v.filter((x): x is Scalar => typeof x === "string" || typeof x === "number" || typeof x === "boolean") : null;

async function realGetConfig(tenant_id: string): Promise<SavedConfig | null> {
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("utilization_metric_config")
    .select(
      "source_epoch, supply_table, supply_key_field, location_fields, active_field, active_values, occupancy_table, occupancy_unit_field, occupancy_start_field, occupancy_end_field, occupancy_status_field, occupying_values, confirmed_at, updated_at",
    )
    .maybeSingle();
  if (error) throw new Error(`utilization map read failed: ${error.message}`);
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    source_epoch: Number(r.source_epoch),
    supply_table: String(r.supply_table),
    supply_key_field: String(r.supply_key_field),
    location_fields: Array.isArray(r.location_fields) ? (r.location_fields as unknown[]).map(String) : [],
    active_field: (r.active_field as string | null) ?? null,
    active_values: scalarList(r.active_values),
    occupancy_table: String(r.occupancy_table),
    occupancy_unit_field: String(r.occupancy_unit_field),
    occupancy_start_field: String(r.occupancy_start_field),
    occupancy_end_field: String(r.occupancy_end_field),
    occupancy_status_field: (r.occupancy_status_field as string | null) ?? null,
    occupying_values: scalarList(r.occupying_values),
    confirmed_at: String(r.confirmed_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
  };
}

async function realGetSourceEpoch(tenant_id: string): Promise<number> {
  const { data, error } = await tenantClient(asTenantId(tenant_id)).from("tenant_db_generation").select("source_epoch").maybeSingle();
  if (error) throw new Error(`database source read failed: ${error.message}`);
  return Number((data as { source_epoch?: unknown } | null)?.source_epoch ?? 0);
}

async function realGetBookingHint(tenant_id: string): Promise<{ table: string; status_field: string | null } | null> {
  const { data } = await tenantClient(asTenantId(tenant_id)).from("booking_metric_config").select("booking_source, status_field, state").maybeSingle();
  const r = data as { booking_source?: string; status_field?: string | null; state?: string } | null;
  return r && r.state === "confirmed" && r.booking_source ? { table: r.booking_source, status_field: r.status_field ?? null } : null;
}

export const realUtilizationDeps: UtilizationDeps = {
  getConfig: realGetConfig,
  getSourceEpoch: realGetSourceEpoch,
  getCatalog,
  getBookingHint: realGetBookingHint,
  compute: (ctx, engine, map, family, w) =>
    withReadSession(
      {
        tenant_id: ctx.tenant_id,
        caller: { kind: "agent" as const, agent_slug: ctx.agent_slug ?? null, run_id: ctx.run_id ?? null, tool_name: "utilization_by_location" },
      },
      (session) => readUtilization(session, engine, map, family, w),
    ),
  isOwnerOrAdmin: (t, u) => isTenantOwnerOrAdmin(t, u),
  async confirm(a) {
    const m = a.map;
    const { error } = await tenantRpc(asTenantId(a.tenant_id), "confirm_utilization_metric_config", {
      p_tenant_id: a.tenant_id,
      p_confirmed_by: a.confirmed_by,
      p_expected_updated_at: a.expected_updated_at,
      p_source_epoch: a.source_epoch,
      p_supply_table: m.supply_table,
      p_supply_key_field: m.supply_key_field,
      p_location_fields: m.location_fields,
      p_active_field: m.active_field,
      p_active_values: m.active_values,
      p_occupancy_table: m.occupancy_table,
      p_occupancy_unit_field: m.occupancy_unit_field,
      p_occupancy_start_field: m.occupancy_start_field,
      p_occupancy_end_field: m.occupancy_end_field,
      p_occupancy_status_field: m.occupancy_status_field,
      p_occupying_values: m.occupying_values,
    });
    if (error) {
      const changed = /changed since it was read/.test(error.message ?? "");
      throw new ExpectedToolError(
        changed ? "utilization_map_changed" : "utilization_map_save_failed",
        changed
          ? "The saved map or the connected database changed while this was being saved. Read it again (growth__utilization_by_location), show the founder, and confirm again."
          : `The map could not be saved (${error.code ?? error.message}).`,
      );
    }
  },
  now: () => new Date(),
};

function coverageComplete(cov: DiscoveryCoverage | null): boolean {
  if (!cov) return false;
  return cov.tables_total <= cov.tables_indexed && cov.skipped_unsafe_names === 0 && !cov.deadline_hit && !cov.listing_truncated;
}

function engineOf(cat: ResolvedCatalog): UtilEngine | null {
  return cat.dialect === "mongodb" || cat.dialect === "postgres" ? cat.dialect : null;
}

function columnsOf(cat: ResolvedCatalog, table: string): CatalogColumn[] | null {
  return cat.catalog.tables.find((t) => t.name === table)?.columns ?? null;
}

function typeOf(columns: CatalogColumn[], field: string): string | null {
  return columns.find((c) => c.name === field)?.type ?? null;
}

export function describeMap(m: UtilizationMap) {
  return {
    supply: `Each row of "${m.supply_table}" is one unit you book, identified by "${m.supply_key_field}".`,
    location: `A unit's location is ${m.location_fields.map((f) => `"${f}"`).join(" + ")}.`,
    active: m.active_field
      ? `A unit counts as available today when "${m.active_field}" is ${m.active_values!.map((v) => JSON.stringify(v)).join(" or ")}.`
      : "Every unit in that table counts as available today.",
    occupancy: `Each row of "${m.occupancy_table}" occupies the unit in "${m.occupancy_unit_field}" from "${m.occupancy_start_field}" to "${m.occupancy_end_field}"${
      m.occupancy_status_field ? `, when "${m.occupancy_status_field}" is ${m.occupying_values!.map((v) => JSON.stringify(v)).join(" or ")}` : " (every row counts)"
    }.`,
  };
}

function codeSecret(): string {
  const k = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.INNGEST_SIGNING_KEY || "").trim();
  if (!k) throw new ExpectedToolError("utilization_map_unavailable", "Saving this map is unavailable right now (no server key).");
  return k;
}

export function confirmationCode(
  tenant_id: string,
  actor_user_id: string,
  source_epoch: number,
  revision: string | null,
  m: UtilizationMap,
  preview_run_id: string,
): string {
  const canonical = JSON.stringify([
    "utilization-map-confirm:v1",
    tenant_id,
    actor_user_id,
    source_epoch,
    revision,
    preview_run_id,
    m.supply_table,
    m.supply_key_field,
    m.location_fields,
    m.active_field,
    m.active_values,
    m.occupancy_table,
    m.occupancy_unit_field,
    m.occupancy_start_field,
    m.occupancy_end_field,
    m.occupancy_status_field,
    m.occupying_values,
  ]);
  return `${createHmac("sha256", codeSecret()).update(canonical).digest("base64url")}.${preview_run_id}`;
}

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const LIMITS =
  "Capacity is today's active units for the whole window (units added or removed during it are not tracked), so this is occupancy against current capacity. " +
  "High occupancy alone does not prove a shortage: demand that could not be served (failed searches or declined requests) is not measured here. Say \"high occupancy; shortage unproven\" unless that evidence is shown.";

export const utilizationInputSchema = z
  .object({
    days: z.number().int().min(7).max(365).optional().describe("Window length in days, ending now. Default 28."),
    limit: z.number().int().min(1).max(100).optional().describe("Most locations to return, highest occupancy first. Default 25."),
  })
  .strict();

const QUESTIONS = [
  "Which table holds the units you book (one row per unit), and which field is a unit's id?",
  "Which field(s) say where a unit is (for example a city and a region field)? Up to 3.",
  "Which units count as available today: a field and its values, or every row?",
  "Which table records a unit being booked or occupied (one row per unit per period), which field points at the unit, and which fields hold when it starts and ends?",
  "Which status values mean the unit is actually occupied (not cancelled or declined), or does every row count?",
];

export async function runUtilizationByLocation(ctx: ToolContext, raw: unknown, deps: UtilizationDeps = realUtilizationDeps) {
  const input = utilizationInputSchema.parse(raw ?? {});
  const days = input.days ?? 28;
  const limit = input.limit ?? 25;
  const [cfg, epoch] = await Promise.all([deps.getConfig(ctx.tenant_id), deps.getSourceEpoch(ctx.tenant_id)]);
  if (!cfg) {
    const [cat, booking] = await Promise.all([deps.getCatalog(ctx.tenant_id), deps.getBookingHint(ctx.tenant_id)]);
    const hints = cat?.hints ?? {};
    return {
      status: "not_set_up",
      message:
        "Occupancy by location needs a map the founder confirms once. Ask them these questions in plain words (use the database catalog to show the real table and field names), then preview and save their answers with growth__confirm_utilization_map. Until then there is no occupancy number to give.",
      questions: QUESTIONS,
      suggestions: {
        ...(booking ? { occupancy_table: booking.table, occupancy_status_field: booking.status_field, occupancy_note: "From the confirmed revenue mapping; confirm it is also the table where one row occupies one unit for a period." } : {}),
        ...(hints.listings ? { supply_table: hints.listings.table, supply_key_field: hints.listings.id_field, location_field: hints.listings.geo_field ?? null } : {}),
        ...(hints.bookings?.listing_ref_field ? { occupancy_unit_field: hints.bookings.listing_ref_field } : {}),
      },
      config_revision: null,
      database_revision: epoch,
    };
  }
  const shown = { map: describeMap(cfg), confirmed_at: cfg.confirmed_at, config_revision: cfg.updated_at, database_revision: epoch };
  if (cfg.source_epoch !== epoch) {
    return {
      status: "reconfirm",
      reason: "database_changed",
      message: "The connected database changed after this map was confirmed. Show the founder the map again and re-confirm it (preview, then save).",
      ...shown,
    };
  }
  const cat = await deps.getCatalog(ctx.tenant_id);
  if (!cat) {
    return { status: "read_failed", message: "The database catalog could not be read just now. Try again shortly.", ...shown };
  }
  const engine = engineOf(cat);
  if (!engine) {
    return { status: "unsupported_engine", message: `Occupancy by location supports MongoDB and Postgres, not ${cat.dialect} yet.`, ...shown };
  }
  const complete = coverageComplete(cat.coverage);
  for (const { table, fields } of mapFieldsByTable(cfg)) {
    const cols = columnsOf(cat, table);
    const gone = cols ? fields.filter((f) => !fieldInColumns(engine, cols, f)) : complete ? fields : [];
    if (gone.length > 0 && complete) {
      return {
        status: "reconfirm",
        reason: "fields_missing",
        message: `"${table}" no longer has ${gone.map((f) => `"${f}"`).join(", ")} in the database catalog. Show the founder the map and re-confirm it.`,
        ...shown,
      };
    }
  }
  const typed = checkTypes(engine, cat, cfg);
  if ("problem" in typed && !complete && !typesKnown(cat, cfg)) {
    return { status: "catalog_incomplete", message: "The database catalog is partial right now, so the confirmed fields cannot be checked. Re-run discovery, then ask again; the map is kept.", ...shown };
  }
  if ("problem" in typed) {
    return { status: "reconfirm", reason: "type_changed", message: `${typed.problem} Show the founder the map and re-confirm it.`, ...shown };
  }
  const until = deps.now();
  const since = new Date(until.getTime() - days * DAY_MS);
  try {
    const result = await deps.compute(ctx, engine, cfg, typed.family, { since, until, limit });
    if (result.location_count > MAX_LOCATIONS) throw new TooManyLocationsError();
    if (result.totals.units === 0) {
      return { status: "no_active_units", message: "No unit counts as available today under the confirmed map, so there is no capacity to measure against.", coverage: result.coverage, ...shown };
    }
    const c = result.coverage;
    if (c.duplicate_unit_keys > 0 || c.units_without_key > 0) {
      return {
        status: "unit_ids_not_unique",
        message: `Among the units available today, ${c.duplicate_unit_keys} share an id with another and ${c.units_without_key} have no id, so bookings cannot be tied to one unit and no occupancy is given. The founder fixes those rows, or confirms a field that is unique per unit.`,
        coverage: c,
        ...shown,
      };
    }
    const why: string[] = [];
    if (c.rows_without_unit > 0) why.push(`${c.rows_without_unit} occupying rows point at no readable unit`);
    if (c.rows_without_dates === null) why.push("rows whose start or end is not a date could not be counted");
    else if (c.rows_without_dates > 0) why.push(`${c.rows_without_dates} occupying rows have a start or end that is not a date`);
    if (c.rows_end_not_after_start > 0) why.push(`${c.rows_end_not_after_start} occupying rows end before they start`);
    return {
      status: "ok",
      exact: why.length === 0,
      ...(why.length ? { why_not_exact: `Booked time is a lower bound: ${why.join("; ")}.` } : {}),
      limits: LIMITS,
      ...result,
      ...shown,
    };
  } catch (e) {
    if (e instanceof DataChangedDuringReadError) {
      return { status: "data_changed_during_read", message: "Units were being changed while this was read, twice in a row, so the numbers would not add up. Try again in a minute.", ...shown };
    }
    if (e instanceof TooManyLocationsError) {
      return {
        status: "too_many_locations",
        message: `More than ${MAX_LOCATIONS} locations. Ask the founder for a coarser location field (a city or region rather than an address) and re-confirm the map.`,
        ...shown,
      };
    }
    if (e instanceof GatewayRefusal) {
      return { status: "refused_by_data_settings", message: `The founder's data-access settings refused this read: ${e.reason}`, ...shown };
    }
    if (isMongoTimeout(e) || /statement timeout|canceling statement/i.test(String((e as Error)?.message ?? ""))) {
      return { status: "calculation_too_large", message: "The calculation ran past the time limit on this database. Try a shorter window (days).", ...shown };
    }
    console.warn(`[utilization] read failed for ${ctx.tenant_id}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    return { status: "read_failed", message: "The database could not be read just now. Say the occupancy could not be computed; do not estimate it.", ...shown };
  }
}

export const utilizationByLocationTool: ToolSpec = {
  name: "growth_utilization_by_location",
  effect: "read",
  description:
    "Occupancy (utilization) per location, ranked: booked unit-time over today's active units x the window, from a map the founder confirmed once. " +
    "Use for supply-vs-demand by location, utilization or occupancy by place, or where supply is short. Returns not_set_up with the questions to ask until the map is confirmed. Read-only.",
  input_schema: utilizationInputSchema,
  async execute(ctx, input) {
    return runUtilizationByLocation(ctx, input);
  },
};

const field = z.string().trim().min(1).max(128);
const scalar = z.union([z.string().trim().min(1).max(128), z.number().finite(), z.boolean()]);
const orNull = <T extends z.ZodType>(t: T) => z.union([t, z.null()]);

export const confirmUtilizationInputSchema = z
  .object({
    supply_table: field.describe("Table/collection with one row per bookable unit."),
    supply_key_field: field.describe("The unit's id field in that table."),
    location_fields: z.array(field).min(1).max(3).describe("1-3 fields that place a unit (e.g. city then region)."),
    active_field: orNull(field).describe("Field that says a unit is available today, or null when every row counts."),
    active_values: orNull(z.array(scalar).min(1).max(64)).describe("Values of active_field that mean available; null with a null active_field."),
    occupancy_table: field.describe("Table/collection where one row occupies one unit for a period."),
    occupancy_unit_field: field.describe("Field of that row pointing at the unit's id."),
    occupancy_start_field: field.describe("When the occupancy starts (a date-time)."),
    occupancy_end_field: field.describe("When it ends (a date-time)."),
    occupancy_status_field: orNull(field).describe("Status field, or null when every row occupies."),
    occupying_values: orNull(z.array(scalar).min(1).max(64)).describe("Status values that mean occupied (not cancelled/declined); null with a null status field."),
    config_revision: orNull(z.string().min(1).max(64)).describe("config_revision from growth__utilization_by_location (null when not set up)."),
    database_revision: z.number().int().min(0).describe("database_revision from growth__utilization_by_location."),
    confirmation_code: orNull(z.string().max(160)).describe("null for a PREVIEW (checks the choices and returns them in plain words plus a code). After the founder says the preview is right, call again with the same choices and that code to save."),
  })
  .strict();

type ConfirmInput = z.infer<typeof confirmUtilizationInputSchema>;

function typesKnown(cat: ResolvedCatalog, m: UtilizationMap): boolean {
  const sup = columnsOf(cat, m.supply_table);
  const occ = columnsOf(cat, m.occupancy_table);
  return !!sup && !!occ && !!typeOf(sup, m.supply_key_field) && [m.occupancy_unit_field, m.occupancy_start_field, m.occupancy_end_field].every((f) => !!typeOf(occ, f));
}

export function checkTypes(engine: UtilEngine, cat: ResolvedCatalog, map: UtilizationMap): { family: KeyFamily } | { code: string; problem: string } {
  const supplyCols = columnsOf(cat, map.supply_table) ?? [];
  const occCols = columnsOf(cat, map.occupancy_table) ?? [];
  const keyType = typeOf(supplyCols, map.supply_key_field) ?? "";
  const family = keyFamilyOf(engine, keyType);
  if (!family) {
    return { code: "utilization_unsupported_key", problem: `"${map.supply_key_field}" (${keyType || "unknown type"}) is not a supported unit id: it must be one id type (an object id, text, or a whole number).` };
  }
  const refType = typeOf(occCols, map.occupancy_unit_field) ?? "";
  const refOk = engine === "mongodb" ? mongoRefConvertible(refType) : keyFamilyOf(engine, refType) === family;
  if (!refOk) {
    return {
      code: "utilization_unsupported_key",
      problem: `"${map.occupancy_unit_field}" (${refType || "unknown type"}) cannot be matched to the unit id "${map.supply_key_field}" (${keyType}).${engine === "postgres" ? " Both must be the same kind of id (text/uuid, or whole numbers)." : ""}`,
    };
  }
  for (const f of [map.occupancy_start_field, map.occupancy_end_field]) {
    const t = typeOf(occCols, f) ?? "";
    if (!isNativeTime(engine, t)) {
      return {
        code: "utilization_unsupported_date_type",
        problem: `"${f}" is stored as ${t || "an unknown type"}. Occupancy needs a real date-time field${engine === "postgres" ? " with a time zone (timestamptz)" : " (a stored Date, not text)"}.`,
      };
    }
  }
  return { family };
}

function validateAgainstCatalog(cat: ResolvedCatalog, a: ConfirmInput): { map: UtilizationMap; family: KeyFamily; engine: UtilEngine } {
  const engine = engineOf(cat);
  if (!engine) throw new ExpectedToolError("utilization_unsupported_engine", `Occupancy by location supports MongoDB and Postgres, not ${cat.dialect} yet.`);
  const map: UtilizationMap = {
    supply_table: a.supply_table,
    supply_key_field: a.supply_key_field,
    location_fields: [...new Set(a.location_fields)],
    active_field: a.active_field,
    active_values: a.active_values ? [...new Set(a.active_values)] : null,
    occupancy_table: a.occupancy_table,
    occupancy_unit_field: a.occupancy_unit_field,
    occupancy_start_field: a.occupancy_start_field,
    occupancy_end_field: a.occupancy_end_field,
    occupancy_status_field: a.occupancy_status_field,
    occupying_values: a.occupying_values ? [...new Set(a.occupying_values)] : null,
  };
  if ((map.active_field === null) !== (map.active_values === null)) {
    throw new ExpectedToolError("utilization_bad_input", "active_field and active_values go together: both set, or both null (every unit counts).");
  }
  if ((map.occupancy_status_field === null) !== (map.occupying_values === null)) {
    throw new ExpectedToolError("utilization_bad_input", "occupancy_status_field and occupying_values go together: both set, or both null (every row counts).");
  }
  if (map.occupancy_start_field === map.occupancy_end_field) {
    throw new ExpectedToolError("utilization_bad_input", "The start and end of an occupancy must be two different fields.");
  }
  for (const t of [map.supply_table, map.occupancy_table]) {
    try {
      if (engine === "postgres") pgIdent(t, "table");
    } catch {
      throw new ExpectedToolError("utilization_bad_field", `"${t}" is not a valid table name for this database.`);
    }
  }
  for (const { table, fields } of mapFieldsByTable(map)) {
    const cols = columnsOf(cat, table);
    if (!cols) throw new ExpectedToolError("utilization_unknown_table", `"${table}" is not in the discovered database catalog. Re-run discovery or check the name.`);
    for (const f of fields) {
      try {
        if (engine === "postgres") pgIdent(f, "column");
        else mongoField(f);
      } catch {
        throw new ExpectedToolError("utilization_bad_field", `"${f}" is not a valid field name for this database.`);
      }
      if (!fieldInColumns(engine, cols, f)) throw new ExpectedToolError("utilization_unknown_field", `"${f}" is not a field of "${table}" in the discovered catalog.`);
    }
  }
  const typed = checkTypes(engine, cat, map);
  if ("problem" in typed) throw new ExpectedToolError(typed.code, typed.problem);
  const family = typed.family;
  return { map, family, engine };
}

export async function runConfirmUtilizationMap(ctx: ToolContext, raw: unknown, deps: UtilizationDeps = realUtilizationDeps) {
  if (!isHumanAuthoredChat(ctx)) {
    throw new ExpectedToolError("utilization_map_denied", "This can only be saved from a live chat with the founder, from what they confirmed.");
  }
  const user = ctx.actor?.actor_user_id ?? null;
  if (!user || !(await deps.isOwnerOrAdmin(ctx.tenant_id, user))) {
    throw new ExpectedToolError("utilization_map_denied", "Only a workspace owner or admin can confirm this map. Ask them to confirm in chat.");
  }
  const parsed = confirmUtilizationInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExpectedToolError("utilization_bad_input", `Not saved: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}.`);
  }
  const a = parsed.data;
  const [cfg, epoch, cat] = await Promise.all([deps.getConfig(ctx.tenant_id), deps.getSourceEpoch(ctx.tenant_id), deps.getCatalog(ctx.tenant_id)]);
  const current = cfg?.updated_at ?? null;
  if (current !== a.config_revision || epoch !== a.database_revision) {
    throw new ExpectedToolError(
      "utilization_map_changed",
      "The saved map or the connected database changed after it was read. Read it again (growth__utilization_by_location), show the founder, and confirm again.",
    );
  }
  if (!cat) throw new ExpectedToolError("utilization_catalog_unavailable", "The database catalog could not be read just now. Try again shortly.");
  const { map } = validateAgainstCatalog(cat, a);
  const run = ctx.run_id ?? null;
  if (!run) throw new ExpectedToolError("utilization_map_denied", "This chat turn has no run id, so the founder's confirmation cannot be tied to a preview. Try again in a new message.");
  if (a.confirmation_code === null) {
    return {
      status: "preview",
      saved: false,
      map: describeMap(map),
      confirmation_code: confirmationCode(ctx.tenant_id, user, epoch, current, map, run),
      message:
        "Not saved yet. Show the founder these four lines word for word and ask whether they are right, then stop and wait for their reply. Only after they say yes (in their next message), call again with the same choices and this confirmation_code. If they change anything, preview again.",
    };
  }
  const dot = a.confirmation_code.indexOf(".");
  const previewRun = dot > 0 ? a.confirmation_code.slice(dot + 1) : "";
  if (!previewRun || !sameCode(a.confirmation_code, confirmationCode(ctx.tenant_id, user, epoch, current, map, previewRun))) {
    throw new ExpectedToolError("utilization_code_mismatch", "These choices, this person or this revision differ from the preview the founder saw, or the code is not one Zavi issued. Preview again and show the founder.");
  }
  if (previewRun === run) {
    throw new ExpectedToolError(
      "utilization_awaiting_founder",
      "Not saved: the preview was made in this same turn, so the founder has not answered it yet. Show it and wait for their reply; save in the turn where they confirm.",
    );
  }
  await deps.confirm({ tenant_id: ctx.tenant_id, confirmed_by: user, expected_updated_at: current, source_epoch: epoch, map });
  return {
    status: "saved",
    saved: true,
    map: describeMap(map),
    message: "Saved with the founder as the confirmer. Now call growth__utilization_by_location to answer their question.",
  };
}

export const confirmUtilizationMapTool: ToolSpec = {
  name: "growth_confirm_utilization_map",
  effect: "write",
  description:
    "Save the occupancy map the founder confirmed in this chat (questions from growth__utilization_by_location). Two steps: confirmation_code null previews the choices in plain words; after the founder says it is right, the same choices plus that code save it. " +
    "Only the founder's answers, never your own pick. Owner/admin only; every field is checked against the database catalog.",
  input_schema: confirmUtilizationInputSchema,
  async execute(ctx, input) {
    return runConfirmUtilizationMap(ctx, input);
  },
};
