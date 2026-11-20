
import { ObjectId, type Document } from "mongodb";
import type {
  OperatorDbDriver,
  SchemaMap,
  GenericReadOptions,
  GenericReadResult,
  NewBookingsInWindowResult,
  NewUsersInWindowResult,
  OperatorDbResult,
  VerifiedBookingsByCampaignResult,
  VerifiedBookingByCampaignRow,
} from "../types";
import { ExpectedToolError } from "@/services/tools/types";
import { rethrowMongoAsRecoverable } from "../mongo-error";
import { withMongoDb, withMongoDbStrict, type MongoDbLike } from "../session-attach";
import { VERIFIED_ROW_LIMIT, buildVerifiedPipeline, catalogUtmCampaignPaths, siblingSource, utmProbePaths } from "../verified-utm";
import { MAX_ROWS_PER_READ } from "../codeact-sql";
import { validateFind, validateAggregate } from "../mongo-read-grammar";
import { isSecretField, isSensitiveName, maskTaintedValue, redactDocDeep } from "../discovery/redact";
import { logEvent } from "@/services/logging/logEvent";

const READ_MAX_TIME_MS = 5000;

function noteSwallowedRead(op: string, e: unknown): void {
  void logEvent({
    level: "warn",
    source: "operator_db.mongo",
    code: "read_failed",
    message: `${op}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`.slice(0, 400),
  });
}

export const SECRET_FIELD_RE =
  /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|access[_-]?key|^body$|_body$|blob|html|encrypted|cipher)/i;

export type DateFieldProbe = "date" | "missing" | "string" | "other";

export async function probeDateField(
  db: MongoDbLike,
  coll: string,
  field: string,
): Promise<DateFieldProbe> {
  const doc = await db
    .collection(coll)
    .findOne({ [field]: { $exists: true, $ne: null } }, { projection: { [field]: 1 }, maxTimeMS: READ_MAX_TIME_MS });
  if (!doc) return "missing";
  let v: unknown = doc;
  for (const part of field.split(".")) v = (v as Record<string, unknown> | null | undefined)?.[part];
  if (v instanceof Date) return "date";
  if (typeof v === "string") return "string";
  return "other";
}

function dateProbeDetail(probe: DateFieldProbe): string | null {
  if (probe === "date") return null;
  if (probe === "missing") return "date_field_missing";
  if (probe === "string") return "date_field_is_string";
  return "date_field_not_a_date";
}

function coerceId(id: string): unknown {
  return ObjectId.isValid(id) && id.length === 24 ? new ObjectId(id) : id;
}

export function buildProjection(
  callerProjection: Record<string, number> | undefined,
  secretFieldExclusions?: string[],
): Record<string, 0 | 1> | undefined {
  const norm = (v: number): 0 | 1 => (v === 0 ? 0 : 1);
  const secretExcl = Array.from(
    new Set((secretFieldExclusions ?? []).filter((f) => isSecretField(f))),
  );

  if (callerProjection) {
    const isInclusion = Object.entries(callerProjection).some(
      ([k, v]) => norm(v) === 1 && k !== "_id",
    );
    if (isInclusion) {
      const out: Record<string, 0 | 1> = {};
      for (const [k, v] of Object.entries(callerProjection)) {
        if (norm(v) === 1 && isSecretField(k)) continue;
        out[k] = norm(v);
      }
      return out;
    }
    const out: Record<string, 0 | 1> = {};
    for (const [k, v] of Object.entries(callerProjection)) out[k] = norm(v);
    for (const f of secretExcl) out[f] = 0;
    return Object.keys(out).length > 0 ? out : undefined;
  }

  if (secretExcl.length === 0) return undefined;
  const out: Record<string, 0 | 1> = {};
  for (const f of secretExcl) out[f] = 0;
  return out;
}

const OPAQUE_FIELD_OPS = new Set(["$getField", "$setField", "$objectToArray", "$function", "$accumulator"]);

export function mongoReadTainted(spec: unknown, key?: string, depth = 0): boolean {
  if (depth > 40) return true;
  if (typeof spec === "string") {
    if (!spec.startsWith("$")) return false;
    const dot = spec.indexOf(".");
    const path = spec.startsWith("$$") ? (dot < 0 ? "" : spec.slice(dot + 1)) : spec.slice(1);
    return path.split(".").some((seg) => seg && isSensitiveName(seg)) && path !== key;
  }
  if (Array.isArray(spec)) return spec.some((s) => mongoReadTainted(s, undefined, depth + 1));
  if (spec && typeof spec === "object") {
    return Object.entries(spec as Record<string, unknown>).some(
      ([k, v]) => k !== "$match" && (OPAQUE_FIELD_OPS.has(k) || mongoReadTainted(v, k, depth + 1)),
    );
  }
  return false;
}

function clampLimit(requested: number | undefined): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return MAX_ROWS_PER_READ;
  }
  return Math.min(Math.floor(requested), MAX_ROWS_PER_READ);
}

export function buildAggregatePipeline(
  pipeline: Document[],
  cap: number,
  projection: Record<string, 0 | 1> | undefined,
): Document[] {
  const out: Document[] = [...pipeline];
  if (projection) out.push({ $project: projection });
  out.push({ $limit: Math.min(cap + 1, MAX_ROWS_PER_READ) });
  return out;
}

function assertCollectionAllowed(
  name: string,
  allowed: ReadonlySet<string>,
): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new ExpectedToolError(
      "operator_db_bad_collection",
      "collection name must be a non-empty string",
    );
  }
  if (!allowed.has(name.toLowerCase())) {
    throw new ExpectedToolError(
      "operator_db_collection_not_allowlisted",
      `Collection "${name}" is not in the tenant's discovered collections. Reads are limited to the auto-discovered catalog.`,
    );
  }
}

export function mongoDriver(): OperatorDbDriver {
  return {
    async query_user(userId, cfg, opts) {
      const m = cfg.users;
      const projection = buildProjection(undefined, opts?.secretFieldExclusions);
      return withMongoDb(cfg, async (db) => {
        const doc = await db.collection(m.table).findOne({ [m.id_field]: coerceId(userId) }, projection ? { projection } : undefined);
        return { ok: true, data: doc ? redactDocDeep(doc) : null };
      });
    },

    async query_listing(listingId, cfg, opts) {
      const m = cfg.listings;
      if (!m) throw new ExpectedToolError("operator_db_no_listings_map", "schema_map.listings not declared");
      const projection = buildProjection(undefined, opts?.secretFieldExclusions);
      return withMongoDb(cfg, async (db) => {
        const doc = await db.collection(m.table).findOne({ [m.id_field]: coerceId(listingId) }, projection ? { projection } : undefined);
        return { ok: true, data: doc ? redactDocDeep(doc) : null };
      });
    },

    async query_recent_transactions(userId, sinceUnix, cfg, opts) {
      const m = cfg.transactions;
      if (!m) throw new ExpectedToolError("operator_db_no_transactions_map", "schema_map.transactions not declared");
      const projection = buildProjection(undefined, opts?.secretFieldExclusions);
      return withMongoDb(cfg, async (db) => {
        let cur = db.collection(m.table).find({
          user_id: coerceId(userId),
          created_at: { $gte: new Date(sinceUnix * 1000) },
        }).sort({ created_at: -1 }).limit(100);
        if (projection) cur = cur.project(projection);
        const data = (await cur.toArray()).map((d) => redactDocDeep(d));
        return { ok: true, data };
      });
    },

    async query_collection(
      collectionName: string,
      filter: Record<string, unknown>,
      options: GenericReadOptions,
      cfg: SchemaMap,
      allowedCollections: ReadonlySet<string>,
    ): Promise<OperatorDbResult<GenericReadResult>> {
      assertCollectionAllowed(collectionName, allowedCollections);
      const fv = validateFind(filter ?? {});
      if (!fv.ok) throw new ExpectedToolError("operator_db_read_rejected", fv.error);
      const limit = clampLimit(options?.limit);
      const projection = buildProjection(
        options?.projection,
        options?.secretFieldExclusions,
      );

      return withMongoDbStrict(cfg, async (db) => {
        let cur = db
          .collection(collectionName)
          .find(filter ?? {}, { maxTimeMS: READ_MAX_TIME_MS });
        if (projection) cur = cur.project(projection);
        if (options?.sort) {
          const sortSpec: Record<string, 1 | -1> = {};
          for (const [k, v] of Object.entries(options.sort)) sortSpec[k] = v < 0 ? -1 : 1;
          cur = cur.sort(sortSpec);
        }
        if (options?.skip && options.skip > 0) cur = cur.skip(Math.floor(options.skip));
        cur = cur.limit(Math.min(limit + 1, MAX_ROWS_PER_READ));
        const raw = (await cur.toArray().catch((e: unknown) => {
          rethrowMongoAsRecoverable(e, collectionName);
        })) as Record<string, unknown>[];
        const truncated = raw.length > limit || raw.length === MAX_ROWS_PER_READ;
        const kept = truncated ? raw.slice(0, limit) : raw;
        const tainted = mongoReadTainted(options?.projection);
        const rows = kept.map((d) => (tainted ? (maskTaintedValue(redactDocDeep(d)) as Record<string, unknown>) : redactDocDeep(d)));
        return {
          ok: true,
          data: {
            collection: collectionName,
            row_count: rows.length,
            truncated,
            rows,
            ...(tainted ? { masked: "strings" as const } : {}),
          },
        };
      });
    },

    async aggregate(
      collectionName: string,
      pipeline: unknown[],
      options: GenericReadOptions,
      cfg: SchemaMap,
      allowedCollections: ReadonlySet<string>,
    ): Promise<OperatorDbResult<GenericReadResult>> {
      assertCollectionAllowed(collectionName, allowedCollections);
      const av = validateAggregate(pipeline, { allowedCollections });
      if (!av.ok) throw new ExpectedToolError("operator_db_read_rejected", av.error);
      const limit = clampLimit(options?.limit);

      const secretFirst = Object.keys(buildProjection(undefined, options?.secretFieldExclusions) ?? {});
      const effectivePipeline = buildAggregatePipeline(
        [...(secretFirst.length ? [{ $unset: secretFirst }] : []), ...(pipeline as Document[])],
        limit,
        buildProjection(options?.projection, options?.secretFieldExclusions),
      );

      return withMongoDbStrict(cfg, async (db) => {
        const cur = db.collection(collectionName).aggregate(effectivePipeline, {
          maxTimeMS: READ_MAX_TIME_MS,
          allowDiskUse: false,
        });
        const raw = (await cur.toArray().catch((e: unknown) => {
          rethrowMongoAsRecoverable(e, collectionName);
        })) as Record<string, unknown>[];
        const truncated = raw.length > limit || raw.length === MAX_ROWS_PER_READ;
        const kept = truncated ? raw.slice(0, limit) : raw;
        const tainted = mongoReadTainted(pipeline);
        const rows = kept.map((d) => (tainted ? (maskTaintedValue(redactDocDeep(d)) as Record<string, unknown>) : redactDocDeep(d)));
        return {
          ok: true,
          data: {
            collection: collectionName,
            row_count: rows.length,
            truncated,
            rows,
            ...(tainted ? { masked: "strings" as const } : {}),
          },
        };
      });
    },

    async query_bookings_by_geo_category() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "Geo-category aggregate shortcuts on MongoDB operator_db are not implemented in v1. Use operator_db_query (aggregate) with an explicit pipeline.",
      );
    },
    async query_active_supply_by_geo_category() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "Geo-category aggregate shortcuts on MongoDB operator_db are not implemented in v1. Use operator_db_query (aggregate) with an explicit pipeline.",
      );
    },
    async query_funnel_by_geo_category() {
      throw new ExpectedToolError(
        "operator_db_aggregate_not_yet_implemented",
        "Geo-category aggregate shortcuts on MongoDB operator_db are not implemented in v1. Use operator_db_query (aggregate) with an explicit pipeline.",
      );
    },

    async query_verified_bookings_by_campaign(filter, cfg) {
      const window_days = Math.max(1, Math.min(365, Math.floor(filter.window_days || 30)));
      const notAvailable = (reason: NonNullable<VerifiedBookingsByCampaignResult["reason"]>): OperatorDbResult<VerifiedBookingsByCampaignResult> => ({
        ok: true,
        data: { available: false, reason, window_days, total_verified: 0, matched_verified: 0, rows: [] },
      });
      const map = filter.order_map;
      if (!map) return notAvailable("order_map_unconfirmed");
      const usersColl = cfg.users?.table;
      const usersIdField = cfg.users?.id_field ?? "_id";
      if (!usersColl) return notAvailable("no_customer_table");
      const windowStart = new Date(Date.now() - window_days * 86400 * 1000);

      try {
        return await withMongoDb(cfg, async (db) => {
          const columns = filter.user_columns ?? [];
          let utm: { campaign: string; source: string | null } | null = null;
          const listed = catalogUtmCampaignPaths(columns);
          for (const campaign of listed) {
            const n = await db.collection(usersColl).countDocuments({ [campaign]: { $exists: true, $ne: null } }, { limit: 1, maxTimeMS: READ_MAX_TIME_MS });
            if (n > 0) {
              utm = { campaign, source: siblingSource(campaign, columns.map((c) => c.name)) };
              break;
            }
          }
          if (!utm) {
            for (const cand of utmProbePaths(columns)) {
              const n = await db.collection(usersColl).countDocuments({ [cand.campaign]: { $exists: true, $ne: null } }, { limit: 1, maxTimeMS: READ_MAX_TIME_MS });
              if (n > 0) {
                const s = await db.collection(usersColl).countDocuments({ [cand.source]: { $exists: true, $ne: null } }, { limit: 1, maxTimeMS: READ_MAX_TIME_MS });
                utm = { campaign: cand.campaign, source: s > 0 ? cand.source : null };
                break;
              }
            }
          }
          if (!utm) return notAvailable("no_utm_field");

          const pipeline = buildVerifiedPipeline(map, { table: usersColl, id_field: usersIdField }, utm, windowStart);
          const agg = (await db
            .collection(map.booking_source)
            .aggregate(pipeline, { maxTimeMS: READ_MAX_TIME_MS * 4, allowDiskUse: true })
            .toArray()) as Array<{
            totals?: Array<{ total_verified?: number; matched_verified?: number; unreadable?: number }>;
            byCampaign?: Array<{ _id?: { c?: unknown; s?: unknown }; verified_bookings?: number; net_gmv?: number }>;
          }>;
          const facet = agg[0] ?? {};
          const totals = facet.totals?.[0] ?? {};
          const total_verified = Number(totals.total_verified ?? 0);
          const matched_verified = Number(totals.matched_verified ?? 0);
          if (!Number.isFinite(total_verified) || total_verified === 0) return notAvailable("no_finished_orders");
          const raw = facet.byCampaign ?? [];
          const rows: VerifiedBookingByCampaignRow[] = raw.slice(0, VERIFIED_ROW_LIMIT).map((r) => ({
            utm_campaign: String(r._id?.c ?? ""),
            utm_source: r._id?.s == null ? null : String(r._id.s),
            verified_bookings: Number(r.verified_bookings ?? 0),
            net_gmv: Math.round(Number(r.net_gmv ?? 0) * 100) / 100,
          }));
          return {
            ok: true,
            data: {
              available: true,
              window_days,
              total_verified,
              matched_verified,
              rows,
              truncated: raw.length > VERIFIED_ROW_LIMIT,
              unreadable_revenue_orders: Number(totals.unreadable ?? 0),
              utm_fields: utm,
            },
          };
        });
      } catch (e) {
        noteSwallowedRead("query_verified_bookings_by_campaign", e);
        return notAvailable("read_failed");
      }
    },

    async query_new_users_in_window(filter, cfg) {
      const window_days = Math.max(1, Math.min(365, Math.floor(filter.window_days || 7)));
      const notAvailable: OperatorDbResult<NewUsersInWindowResult> = {
        ok: true,
        data: { available: false, reason: "not_available", window_days, count: 0 },
      };

      const usersColl = cfg.users?.table;
      if (!usersColl) return notAvailable;
      const createdField = cfg.users?.created_at_field ?? "createdAt";
      const windowStart = new Date(Date.now() - window_days * 86400 * 1000);

      try {
        return await withMongoDb(cfg, async (db) => {
          const fieldProbe = await db
            .collection(usersColl)
            .countDocuments(
              { [createdField]: { $exists: true, $ne: null } },
              { limit: 1, maxTimeMS: READ_MAX_TIME_MS },
            );
          if (fieldProbe === 0) return notAvailable;
          const detail = dateProbeDetail(await probeDateField(db, usersColl, createdField));
          if (detail) return { ok: true, data: { available: false, reason: "not_available", detail, window_days, count: 0 } };

          const count = await db
            .collection(usersColl)
            .countDocuments(
              { [createdField]: { $gte: windowStart } },
              { maxTimeMS: READ_MAX_TIME_MS },
            );
          return {
            ok: true,
            data: { available: true, window_days, count },
          };
        });
      } catch (e) {
        noteSwallowedRead("query_new_users_in_window", e);
        return notAvailable;
      }
    },

    async query_new_bookings_in_window(filter, cfg) {
      const window_days = Math.max(1, Math.min(365, Math.floor(filter.window_days || 7)));
      const notAvailable: OperatorDbResult<NewBookingsInWindowResult> = {
        ok: true,
        data: { available: false, reason: "not_available", window_days, count: 0 },
      };

      const bookingsColl = cfg.bookings?.table;
      if (!bookingsColl) return notAvailable;
      const createdField = cfg.bookings?.created_at_field ?? "createdAt";
      const windowStart = new Date(Date.now() - window_days * 86400 * 1000);

      try {
        return await withMongoDb(cfg, async (db) => {
          const fieldProbe = await db
            .collection(bookingsColl)
            .countDocuments(
              { [createdField]: { $exists: true, $ne: null } },
              { limit: 1, maxTimeMS: READ_MAX_TIME_MS },
            );
          if (fieldProbe === 0) return notAvailable;
          const detail = dateProbeDetail(await probeDateField(db, bookingsColl, createdField));
          if (detail) return { ok: true, data: { available: false, reason: "not_available", detail, window_days, count: 0 } };

          const count = await db
            .collection(bookingsColl)
            .countDocuments(
              { [createdField]: { $gte: windowStart } },
              { maxTimeMS: READ_MAX_TIME_MS },
            );
          return {
            ok: true,
            data: { available: true, window_days, count },
          };
        });
      } catch (e) {
        noteSwallowedRead("query_new_bookings_in_window", e);
        return notAvailable;
      }
    },

    async query_new_users_in_range(filter, cfg) {
      return mongoCountInRange(filter, cfg.users?.table, cfg.users?.created_at_field ?? "createdAt", cfg, filter.match);
    },

    async query_new_bookings_in_range(filter, cfg) {
      return mongoCountInRange(filter, cfg.bookings?.table, cfg.bookings?.created_at_field ?? "createdAt", cfg);
    },

  };
}

async function mongoCountInRange(
  filter: { since: string; until: string },
  coll: string | undefined,
  createdField: string,
  cfg: SchemaMap,
  match: Record<string, unknown> = {},
): Promise<OperatorDbResult<{ available: boolean; reason?: "not_available"; detail?: string; since: string; until: string; count: number }>> {
  const since = new Date(filter.since);
  const until = new Date(filter.until);
  const notAvailable = {
    ok: true as const,
    data: { available: false, reason: "not_available" as const, since: filter.since, until: filter.until, count: 0 },
  };
  if (!coll || !Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since >= until) {
    return notAvailable;
  }
  for (const [k, v] of Object.entries(match)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || !["string", "number", "boolean"].includes(typeof v)) return notAvailable;
  }
  try {
    return await withMongoDb(cfg, async (db) => {
      const fieldProbe = await db
        .collection(coll)
        .countDocuments({ [createdField]: { $exists: true, $ne: null } }, { limit: 1, maxTimeMS: READ_MAX_TIME_MS });
      if (fieldProbe === 0) return notAvailable;
      const detail = dateProbeDetail(await probeDateField(db, coll, createdField));
      if (detail) return { ok: true as const, data: { ...notAvailable.data, detail } };
      const count = await db
        .collection(coll)
        .countDocuments({ ...match, [createdField]: { $gte: since, $lt: until } }, { maxTimeMS: READ_MAX_TIME_MS });
      return { ok: true as const, data: { available: true, since: filter.since, until: filter.until, count } };
    });
  } catch (e) {
    noteSwallowedRead("mongoCountInRange", e);
    return notAvailable;
  }
}
