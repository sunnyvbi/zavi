
import { z } from "zod";
import { getIssue } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  issue_id: z
    .string()
    .min(1)
    .max(64)
    .describe("The Sentry issue id (numeric, as shown by sentry_list_issues' `id` field)."),
});

export const sentryGetIssueTool: ToolSpec = {
  name: "sentry_get_issue",
  effect: "read",
  description:
    "Get one Sentry issue's detail (title, culprit, level, status, seen counts) plus its latest " +
    "event's exception stack trace, trimmed to filename/function/line. Use it after " +
    "sentry_list_issues to look into a specific error. " +
    "Throws sentry_not_connected if the operator has not connected Sentry yet.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { issue_id } = inputSchema.parse(input);

    const { issue, latestEvent } = await getIssue(ctx.tenant_id, issue_id);

    return {
      id: issue.id,
      short_id: issue.shortId,
      title: issue.title,
      culprit: issue.culprit,
      level: issue.level,
      status: issue.status,
      count: issue.count,
      user_count: issue.userCount,
      first_seen: issue.firstSeen,
      last_seen: issue.lastSeen,
      permalink: issue.permalink,
      latest_event: {
        event_id: latestEvent.eventID,
        date_created: latestEvent.dateCreated,
        message: latestEvent.message,
        frames: latestEvent.frames,
      },
    };
  },
};
