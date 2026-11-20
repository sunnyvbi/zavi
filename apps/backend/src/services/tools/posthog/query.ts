
import { z } from "zod";
import { runHogqlQuery } from "./_client";
import { ExpectedToolError, type ToolSpec } from "@/services/tools/types";

const MAX_ROWS = 500;

const MUTATING = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|ATTACH|RENAME)\b/i;

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "A HogQL (ClickHouse-flavoured SQL) SELECT statement. Core tables: `events` " +
        "(columns: event, timestamp, distinct_id, person_id, properties), `persons`, " +
        "`sessions`. Access event properties as properties.$browser or " +
        "properties.your_key. Example: SELECT event, count() FROM events WHERE " +
        "timestamp > now() - INTERVAL 30 DAY GROUP BY event ORDER BY 2 DESC LIMIT 20",
    ),
});

export const posthogQueryTool: ToolSpec = {
  name: "posthog_query",
  effect: "read",
  description:
    "Run a read-only HogQL (SQL) query against the operator's connected PostHog project and " +
    "return the rows. Use it for product-analytics questions: funnel drop-off, activation and " +
    "retention, event volumes, breakdowns by property, and cohort sizing. Because HogQL is SQL, " +
    "one query can express a funnel or a trend — there is no separate funnel tool. " +
    "Throws posthog_not_connected if the operator has not connected PostHog yet.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { query } = inputSchema.parse(input);

    if (MUTATING.test(query)) {
      throw new ExpectedToolError(
        "posthog_query_not_read_only",
        "This tool runs read-only analytics queries. Rewrite it as a SELECT.",
        { next_step: "revise_input" },
      );
    }

    const { columns, results } = await runHogqlQuery(ctx.tenant_id, query);

    const truncated = results.length > MAX_ROWS;
    return {
      columns,
      rows: truncated ? results.slice(0, MAX_ROWS) : results,
      row_count: results.length,
      truncated,
      ...(truncated
        ? { note: `Showing the first ${MAX_ROWS} rows. Add LIMIT or aggregate to narrow the result.` }
        : {}),
    };
  },
};
