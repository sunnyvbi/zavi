
import { z } from "zod";
import { withAttachedDriver, loadDbAccess, visibleCatalog, type DbAccess } from "@/services/data-gateway";
import { gatewayCtx } from "./gateway-ctx";
import {
  getCatalog,
  getDeclaredDialect,
  renderCatalogDigest,
  renderCatalogIndex,
  allowedCollectionsFromCatalog,
} from "./catalog";
import { maybeRediscoverCatalog, rediscoveryRequestedRecently } from "./discovery/retry";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolSpec } from "@/services/tools/types";
import { isSecretField } from "./discovery/redact";
import { MAX_ROWS_PER_READ } from "./codeact-sql";
import {
  coerceMongoExtendedJson,
  coerceOperatorDbQueryInput,
} from "./query-input-coerce";
import type { DiscoveryCoverage, EntityHints, GenericReadOptions, RecordReadOptions } from "./types";

function secretColumns(access: DbAccess, table: string | undefined): string[] {
  if (!table) return [];
  const t = (access.catalog?.catalog?.tables ?? []).find(
    (c) => typeof c.name === "string" && c.name.toLowerCase() === table.toLowerCase(),
  );
  return (t?.columns ?? [])
    .map((c) => c.name)
    .filter((n): n is string => typeof n === "string" && isSecretField(n));
}

function recordReadOptions(access: DbAccess, table: string | undefined): RecordReadOptions {
  return { secretFieldExclusions: secretColumns(access, table) };
}

export const queryUserTool: ToolSpec = {
  name: "operator_db_query_user",
  effect: "read",
  description:
    "Fetch a user record from the operator's DB by id. Read-only. Returns the row/document with PII and credential fields masked. Dialect-agnostic — works whether operator uses Postgres, MongoDB, or MySQL.",
  input_schema: z.object({
    user_id: z.string().min(1),
  }),
  async execute(ctx, input) {
    const { user_id } = (input as { user_id: string });
    return withAttachedDriver(gatewayCtx(ctx, "operator_db__query_user"), ({ driver, cfg, access }) =>
      driver.query_user(user_id, cfg, recordReadOptions(access, cfg.users?.table)),
    );
  },
};

export const queryListingTool: ToolSpec = {
  name: "operator_db_query_listing",
  effect: "read",
  description:
    "Fetch a listing/product record from the operator's DB by id. Read-only.",
  input_schema: z.object({
    listing_id: z.string().min(1),
  }),
  async execute(ctx, input) {
    const { listing_id } = (input as { listing_id: string });
    return withAttachedDriver(gatewayCtx(ctx, "operator_db__query_listing"), ({ driver, cfg, access }) =>
      driver.query_listing(listing_id, cfg, recordReadOptions(access, cfg.listings?.table)),
    );
  },
};

export const queryRecentTransactionsTool: ToolSpec = {
  name: "operator_db_query_recent_transactions",
  effect: "read",
  description:
    "Fetch a user's transactions since a given unix timestamp. Read-only. Returns up to 100 rows newest-first.",
  input_schema: z.object({
    user_id: z.string().min(1),
    since_unix: z.number().int(),
  }),
  async execute(ctx, input) {
    const args = input as { user_id: string; since_unix: number };
    return withAttachedDriver(gatewayCtx(ctx, "operator_db__query_recent_transactions"), ({ driver, cfg, access }) =>
      driver.query_recent_transactions(args.user_id, args.since_unix, cfg, recordReadOptions(access, cfg.transactions?.table)),
    );
  },
};

const NOT_READY_NOTE: Record<string, string> = {
  not_connected: "Operator DB is not connected for this workspace.",
  discovery_pending: "Operator DB schema is still being discovered — this is automatic, retry shortly.",
  discovery_failed:
    "Operator DB schema discovery did not complete — reconnect the database in settings to retry.",
  empty_catalog:
    "Operator DB connected but no collections were discovered — reconnect to re-run discovery.",
  connection_unavailable:
    "Operator DB is configured but its connection is currently unavailable — reconnect in settings.",
};

const MAX_CATALOG_DETAIL_TABLES = 20;

const RECENT_FAILURE_MS = 60 * 60 * 1000;

const ENTITY_ROLES = ["users", "listings", "transactions", "bookings", "cancellations"] as const;

function entityMapBlock(hints: EntityHints): Record<string, unknown> {
  const resolved = ENTITY_ROLES.filter((role) => {
    const v = (hints as Record<string, unknown>)[role] as { table?: unknown } | undefined;
    return !!v && typeof v === "object" && typeof v.table === "string" && v.table.length > 0;
  });
  if (resolved.length > 0) return { entity_map: resolved };
  return {
    entity_map: "none_inferred",
    entity_map_note:
      "No canonical entity map could be inferred from this schema's table names — common when tables use " +
      "legacy or coded names (tbl_cust_mstr, rsv_hdr). This means the MAP is missing, NOT the data. " +
      "Do not retry the per-entity tools (query_user / query_listing / query_recent_transactions) or the " +
      "query_*_by_geo_category aggregates — they will fail with invalid_identifier / schema_map_missing. " +
      "Work from the `collections` list instead: the `rows` estimate points at the tables that matter, then " +
      "read with operator_db_codeact (Postgres/MySQL) or operator_db_query (MongoDB).",
  };
}

function coverageBlock(cov: DiscoveryCoverage | null): Record<string, unknown> {
  if (!cov) return {};
  const missing = Math.max(0, cov.tables_total - cov.tables_indexed);
  const partial =
    missing > 0 || cov.skipped_unsafe_names > 0 || cov.deadline_hit || cov.listing_truncated;
  if (!partial) return { coverage: { ...cov, complete: true } };

  const why: string[] = [];
  if (missing > 0) {
    why.push(
      `${missing} of ${cov.tables_total} tables were not indexed (discovery caps how many it reads)`,
    );
  }
  if (cov.skipped_unsafe_names > 0) {
    why.push(
      `${cov.skipped_unsafe_names} table name(s) were skipped because the name is not identifier-safe (spaces, dashes, non-ASCII)`,
    );
  }
  if (cov.deadline_hit) why.push("discovery ran out of time before finishing");
  if (cov.listing_truncated) {
    why.push(`the table listing itself was cut short, so ${cov.tables_total} is a LOWER BOUND`);
  }

  return {
    coverage: { ...cov, complete: false },
    coverage_note:
      `PARTIAL VIEW of this database — ${why.join("; ")}. ` +
      "You are seeing a subset of the schema. Do NOT tell the user a table or field does not exist " +
      "based on this list: an unlisted table may simply be past the cutoff. Say the catalog is partial " +
      "and name what you can see.",
  };
}

export function freshnessBlock(cat: { rescan_failed_at?: string | null; discovered_at?: string | null }): Record<string, unknown> {
  if (!cat.rescan_failed_at) return {};
  return {
    freshness: { last_good_scan_at: cat.discovered_at ?? null, latest_rescan_failed_at: cat.rescan_failed_at },
    freshness_note:
      `This table list is from the last successful scan${cat.discovered_at ? ` (${cat.discovered_at})` : ""}. ` +
      "A newer scan did not finish, so tables or fields added since then may be missing; the scan retries automatically. " +
      "Do not tell the user a table or field does not exist based on this list alone.",
  };
}

export function mappingBlock(confirmed: DbAccess["confirmed_map"]): Record<string, unknown> {
  const map: Record<string, Record<string, string>> = {};
  for (const [role, entry] of Object.entries(confirmed ?? {})) {
    if (!entry || typeof entry.table !== "string" || !entry.table) continue;
    const out: Record<string, string> = { table: entry.table };
    for (const [k, v] of Object.entries(entry)) {
      if (k !== "label" && k !== "table" && k !== "carried_from" && typeof v === "string" && v) out[k] = v;
    }
    map[role] = out;
  }
  return {
    confirmed_map: Object.keys(map).length ? map : null,
    hints_note:
      "`hints` are automatic guesses from table names, not confirmed by the founder. Metrics and reports read `confirmed_map`; where the two differ, `confirmed_map` is right. Never tell the user a metric or report is set up on a hint's table.",
  };
}

export function scanBlock(cat: { discovered_at?: string | null }): Record<string, unknown> {
  if (!cat.discovered_at) return {};
  return { scanned_at: cat.discovered_at, scan_note: `This table list is a stored scan from ${cat.discovered_at}, not a live read of the database.` };
}

export const operatorDbCatalogTool: ToolSpec = {
  name: "operator_db_catalog",
  effect: "read",
  description:
    "Return the operator's auto-discovered DB schema plus the inferred entity map (users/listings/transactions/bookings). Structure only — no row data. " +
    "By default returns the FULL LIST of collection/table NAMES (with row estimates where known) and omits column detail, so the entire inventory always fits. " +
    `To see columns, call again with \`tables:[...]\` naming up to ${MAX_CATALOG_DETAIL_TABLES} collections, then use the read tools to query rows. ` +
    "A collection you DO see listed is queryable even if its columns were omitted here.",
  input_schema: z.object({
    tables: z
      .array(z.string().min(1))
      .max(MAX_CATALOG_DETAIL_TABLES)
      .optional()
      .describe(
        `Return full column detail for these collections only (max ${MAX_CATALOG_DETAIL_TABLES}). Omit to get the name-only index.`,
      ),
  }),
  async execute(ctx, input) {
    const requested = (input as { tables?: string[] } | undefined)?.tables;
    let resolved = await getCatalog(ctx.tenant_id);
    if (!ctx.writes_suppressed) resolved = await maybeRediscoverCatalog(ctx.tenant_id, resolved);

    const dialect = resolved?.dialect ?? (await getDeclaredDialect(ctx.tenant_id)) ?? undefined;

    let policy: Awaited<ReturnType<typeof loadDbAccess>>["policy"];
    let confirmed: DbAccess["confirmed_map"] = null;
    try {
      const access = await loadDbAccess(ctx.tenant_id);
      policy = access.policy;
      confirmed = access.confirmed_map ?? null;
    } catch (e) {
      const code = e instanceof ExpectedToolError ? e.code : "";
      const lastWrite = resolved?.updated_at ? Date.parse(resolved.updated_at) : NaN;
      const failedRecently = Number.isFinite(lastWrite) && Date.now() - lastWrite < RECENT_FAILURE_MS;
      const healing = !ctx.writes_suppressed && !failedRecently && rediscoveryRequestedRecently(ctx.tenant_id);
      const reason =
        code === "operator_db_not_connected" || !dialect
          ? "not_connected"
          : code === "operator_db_secret_missing" || code === "operator_db_config_read_failed"
            ? "connection_unavailable"
            : resolved?.discovery_error
              ? healing ? "discovery_pending" : "discovery_failed"
              : !resolved
                ? "discovery_pending"
                : (resolved.catalog.tables?.length ?? 0) === 0
                  ? healing ? "discovery_pending" : "empty_catalog"
                  : "connection_unavailable";
      const next_step = reason === "discovery_pending" ? "auto" : "operator_action";
      return { ok: true, data: { ready: false, dialect, reason, next_step, note: NOT_READY_NOTE[reason] } };
    }

    const r2raw = resolved ?? (await getCatalog(ctx.tenant_id));
    const r2 = r2raw ? { ...r2raw, catalog: visibleCatalog(r2raw.catalog, policy) } : null;
    if (!r2 || (r2.catalog.tables?.length ?? 0) === 0) {
      const reason = !r2 ? "discovery_pending" : "empty_catalog";
      const next_step = reason === "discovery_pending" ? "auto" : "operator_action";
      return { ok: true, data: { ready: false, dialect, reason, next_step, note: NOT_READY_NOTE[reason] } };
    }
    const collections = renderCatalogIndex(r2.catalog);

    if (!requested?.length) {
      return {
        ok: true,
        data: {
          ready: true,
          dialect,
          total_collections: collections.length,
          ...coverageBlock(r2.coverage),
          ...freshnessBlock(r2),
          hints: r2.hints,
          ...entityMapBlock(r2.hints),
          ...mappingBlock(confirmed),
          ...scanBlock(r2),
          collections,
          note: `Row counts are ENGINE ESTIMATES, not exact counts — never quote one as a total; use a count query. Column detail omitted. Call operator_db_catalog again with tables:[...] (max ${MAX_CATALOG_DETAIL_TABLES}) for specific collections, then use the read tools to query rows.`,
        },
      };
    }

    const known = new Set(collections.map((c) => c.name));
    const matched = requested.filter((t) => known.has(t));
    const unknown_tables = requested.filter((t) => !known.has(t));

    return {
      ok: true,
      data: {
        ready: true,
        dialect,
        total_collections: collections.length,
        ...coverageBlock(r2.coverage),
        ...freshnessBlock(r2),
        hints: r2.hints,
        ...entityMapBlock(r2.hints),
        ...mappingBlock(confirmed),
        ...scanBlock(r2),
        collections,
        ...(unknown_tables.length ? { unknown_tables } : {}),
        schema: matched.length
          ? renderCatalogDigest(r2.catalog, { only: matched })
          : "(no matching tables)",
      },
    };
  },
};

export const operatorDbQueryTool: ToolSpec = {
  name: "operator_db_query",
  effect: "read",
  description:
    "Run a READ-ONLY query over any of the operator's auto-discovered collections (MongoDB). " +
    "Use `operator_db_catalog` first to see the collection names. Two modes: " +
    "`find` (filter + projection/sort/limit) and `aggregate` (a read pipeline). " +
    "Writes, server-side JavaScript ($where/$function/$accumulator/$out/$merge), " +
    "$graphLookup/$unionWith/$expr, and unknown operators are rejected. $lookup is " +
    "allowed only into a discovered collection. Results are row-capped, time-bounded, " +
    "and PII-redacted. Postgres/MySQL operators should use operator_db_codeact instead.",
  input_schema: z.preprocess(
    coerceOperatorDbQueryInput,
    z.object({
    collection: z
      .string()
      .min(1)
      .describe("The collection to read. Must be one of the discovered collections (see operator_db_catalog)."),
    mode: z.enum(["find", "aggregate"]).describe("`find` for a filter query, `aggregate` for a read pipeline."),
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("find mode: the query filter object (e.g. {status: 'active'}). Omit for all docs (still row-capped)."),
    pipeline: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe("aggregate mode: the read pipeline (e.g. [{$match:{...}},{$group:{...}}]). Max 12 stages."),
    projection: z
      .record(z.string(), z.number().int())
      .optional()
      .describe("Field include(1)/exclude(0) map. Secret/credential fields are always excluded regardless."),
    sort: z.record(z.string(), z.number().int()).optional().describe("find mode: sort spec (1 asc / -1 desc)."),
    limit: z
      .number()
      .int()
      .positive()
      .max(MAX_ROWS_PER_READ)
      .optional()
      .describe(`Max rows to return (hard cap ${MAX_ROWS_PER_READ}).`),
    skip: z.number().int().nonnegative().optional().describe("find mode: rows to skip (pagination)."),
    }),
  ),
  async execute(ctx, input) {
    const args = input as {
      collection: string;
      mode: "find" | "aggregate";
      filter?: Record<string, unknown>;
      pipeline?: Record<string, unknown>[];
      projection?: Record<string, number>;
      sort?: Record<string, number>;
      limit?: number;
      skip?: number;
    };

    return withAttachedDriver(gatewayCtx(ctx, "operator_db__query"), async ({ driver, cfg, access }) => {
    const config = access.config;
    if (config.type !== "mongodb") {
      throw new ExpectedToolError(
        "operator_db_query_dialect_unsupported",
        `operator_db__query is MongoDB-only and this tenant's DB is "${config.type}". ` +
          `This is NOT a connection problem — retry with operator_db__codeact, which runs read-only SQL. ` +
          `All three fields are REQUIRED. Example: operator_db__codeact({ ` +
          `purpose: "<what you are answering>", ` +
          `sql_reads: ["SELECT count(*) AS n FROM <table>"], ` +
          `python_code: "result = int(rows[0]['rows'][0]['n'])" }).`,
      );
    }
    if (!driver.query_collection || !driver.aggregate) {
      throw new ExpectedToolError(
        "operator_db_query_unsupported",
        "Generic read not available for this operator DB driver.",
      );
    }

    const resolved = access.catalog;
    const allowed = allowedCollectionsFromCatalog(resolved.catalog);
    if (allowed.size === 0) {
      throw new ExpectedToolError(
        "operator_db_no_collections",
        "No discovered collections to read (fail-closed).",
      );
    }

    const catTable = (resolved.catalog.tables ?? []).find(
      (t) => typeof t.name === "string" && t.name.toLowerCase() === args.collection.toLowerCase(),
    );
    const secretFieldExclusions = (catTable?.columns ?? [])
      .map((c) => c.name)
      .filter((n): n is string => typeof n === "string" && isSecretField(n));

    const filter = coerceMongoExtendedJson(args.filter ?? {}) as Record<string, unknown>;
    const pipeline = Array.isArray(args.pipeline)
      ? (coerceMongoExtendedJson(args.pipeline) as Record<string, unknown>[])
      : args.pipeline;
    const options: GenericReadOptions = {
      projection: args.projection,
      sort: args.sort,
      limit: args.limit,
      skip: args.skip,
      secretFieldExclusions,
    };

    if (args.mode === "find") {
      return driver.query_collection!(args.collection, filter, options, cfg, allowed);
    }
    if (!Array.isArray(pipeline)) {
      throw new ExpectedToolError(
        "operator_db_query_bad_pipeline",
        "aggregate mode requires a `pipeline` array.",
      );
    }
    return driver.aggregate!(args.collection, pipeline, options, cfg, allowed);
    });
  },
};
