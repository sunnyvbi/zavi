
import { z } from "zod";
import { listIssues } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const MAX_LIMIT = 100;

const inputSchema = z.object({
  project: z
    .string()
    .min(1)
    .max(200)
    .describe("The Sentry project slug or numeric project id to list issues for (e.g. `backend` or `4501234567`)."),
  query: z
    .string()
    .max(300)
    .optional()
    .describe("Sentry search query. Defaults to `is:unresolved`. Example: `is:unresolved level:error`."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Max issues to return (default 25, max ${MAX_LIMIT}).`),
});

export const sentryListIssuesTool: ToolSpec = {
  name: "sentry_list_issues",
  effect: "read",
  description:
    "List a Sentry project's issues, newest first, with title, culprit, event count, and level. " +
    "Defaults to unresolved issues only. Use it to answer 'what's broken', 'any new errors', or " +
    "'what's failing in production' for a connected Sentry project. " +
    "Throws sentry_not_connected if the operator has not connected Sentry yet.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { project, query, limit } = inputSchema.parse(input);

    const issues = await listIssues(ctx.tenant_id, { project, query, limit });

    return {
      issues: issues.map((i) => ({
        id: i.id,
        short_id: i.shortId,
        title: i.title,
        culprit: i.culprit,
        level: i.level,
        status: i.status,
        count: i.count,
        user_count: i.userCount,
        first_seen: i.firstSeen,
        last_seen: i.lastSeen,
        permalink: i.permalink,
      })),
      count: issues.length,
    };
  },
};
