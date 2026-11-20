
import { z } from "zod";
import { supabaseManagementGet } from "./_client";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";

export const supabaseProjectInfoTool: ToolSpec = {
  name: "supabase_project_info",
  effect: "read",
  description:
    "Get the connected Supabase project's status, region, and database engine version. Use it to " +
    "answer 'is my Supabase project paused/active', 'what region is it in', or 'what Postgres version " +
    "am I on'. Throws supabase_not_connected if the operator has not connected Supabase yet.",
  input_schema: z.object({}),
  async execute(ctx) {
    const project = (await supabaseManagementGet(ctx.tenant_id, "")) as Record<string, unknown>;
    return {
      ref: project.ref,
      name: project.name,
      region: project.region,
      status: project.status,
      created_at: project.created_at,
      database: project.database,
    };
  },
};

export const supabaseListEdgeFunctionsTool: ToolSpec = {
  name: "supabase_list_edge_functions",
  effect: "read",
  description:
    "List the edge functions deployed to the connected Supabase project, with each function's status " +
    "(ACTIVE/etc.), version, and last-updated time. Use it to answer 'what edge functions do I have', " +
    "'is <function> deployed', or 'when was <function> last updated'. Throws supabase_not_connected if " +
    "the operator has not connected Supabase yet.",
  input_schema: z.object({}),
  async execute(ctx) {
    const functions = (await supabaseManagementGet(ctx.tenant_id, "/functions")) as unknown[];
    const list = Array.isArray(functions) ? functions : [];
    return {
      functions: list.map((f) => {
        const fn = f as Record<string, unknown>;
        return {
          slug: fn.slug,
          name: fn.name,
          status: fn.status,
          version: fn.version,
          created_at: fn.created_at,
          updated_at: fn.updated_at,
          verify_jwt: fn.verify_jwt,
        };
      }),
      count: list.length,
    };
  },
};

const MAX_LOG_ROWS = 500;
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

const MUTATING = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|ATTACH|RENAME)\b/i;

const queryLogsSchema = z.object({
  sql: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "A ClickHouse-SQL SELECT against the unified `logs` table. Filter by `source_name` to pick a " +
        "log source (e.g. 'edge_logs' for edge function invocations, 'postgres_logs' for database logs, " +
        "'auth_logs' for auth events). Nested fields live under the `log_attributes` map. Example: " +
        "SELECT timestamp, event_message FROM logs WHERE source_name = 'edge_logs' AND event_message " +
        "ILIKE '%error%' ORDER BY timestamp DESC LIMIT 50",
    ),
  minutes_back: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional()
    .describe(
      "How far back to search, in minutes (max 1440 = 24h, a Supabase Management API hard limit). " +
        "Defaults to 60 minutes if omitted.",
    ),
});

export const supabaseQueryLogsTool: ToolSpec = {
  name: "supabase_query_logs",
  effect: "read",
  description:
    "Run a read-only ClickHouse-SQL query against the connected Supabase project's platform logs " +
    "(edge function invocations, database logs, auth logs — NOT your application's business data; use " +
    "the operator_db tools for that). Use it to debug 'why is my edge function failing', 'what's erroring " +
    "in the database right now', or 'show recent auth failures'. Throws supabase_not_connected if the " +
    "operator has not connected Supabase yet.",
  input_schema: queryLogsSchema,
  async execute(ctx, input) {
    const { sql, minutes_back } = queryLogsSchema.parse(input);

    if (MUTATING.test(sql)) {
      throw new ExpectedToolError(
        "supabase_query_not_read_only",
        "This tool runs read-only log queries. Rewrite it as a SELECT.",
        { next_step: "revise_input" },
      );
    }

    const end = new Date();
    const start = new Date(end.getTime() - (minutes_back ? minutes_back * 60 * 1000 : DEFAULT_WINDOW_MS));

    const result = (await supabaseManagementGet(ctx.tenant_id, "/analytics/endpoints/logs", {
      sql,
      iso_timestamp_start: start.toISOString(),
      iso_timestamp_end: end.toISOString(),
    })) as { result?: unknown[] };

    const rows = Array.isArray(result?.result) ? result.result : [];
    const truncated = rows.length > MAX_LOG_ROWS;
    return {
      rows: truncated ? rows.slice(0, MAX_LOG_ROWS) : rows,
      row_count: rows.length,
      truncated,
      window: { start: start.toISOString(), end: end.toISOString() },
      ...(truncated
        ? { note: `Showing the first ${MAX_LOG_ROWS} rows. Add LIMIT or narrow the window to see fewer.` }
        : {}),
    };
  },
};
