import { z } from "zod";
import { createGoogleAdsReadSession } from "./_client";
import { accountClock, shiftDate } from "./_read-window";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({ days: z.number().int().min(1).max(30).default(30), limit: z.number().int().min(1).max(1000).default(500) });
type ChangeRow = { changeEvent?: { changeResourceName?: string; changeResourceType?: string; resourceChangeOperation?: string; changeDateTime?: string; clientType?: string; campaign?: string; changedFields?: string | { paths?: string[] } } };

function fieldPaths(mask: ChangeRow["changeEvent"]) {
  const raw = mask?.changedFields;
  const paths = typeof raw === "string" ? raw.split(",") : raw?.paths ?? [];
  return [...new Set(paths.map((path) => path.trim()).filter((path) => /^[a-zA-Z][a-zA-Z0-9_.]*$/.test(path)))].sort();
}

export const changeHistoryTool: ToolSpec = {
  name: "google_ads_change_history",
  effect: "read",
  description: "Read bounded Google Ads change metadata for the current account day plus up to 29 previous account days. Returns resource identity/type, operation, account-local date-time, client type and field paths only; never old/new values or user email. A capped result is incomplete and nearby changes support hypotheses, not proven causation.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { days, limit } = inputSchema.parse(input);
    const search = createGoogleAdsReadSession(ctx.tenant_id);
    const clock = await accountClock(ctx.tenant_id, search);
    const start = `${shiftDate(clock.date, 1 - days)} 00:00:00`;
    const rows = await search(`SELECT change_event.change_resource_name, change_event.change_resource_type, change_event.resource_change_operation, change_event.change_date_time, change_event.client_type, change_event.campaign, change_event.changed_fields FROM change_event WHERE change_event.change_date_time >= '${start}' AND change_event.change_date_time <= '${clock.date_time}' ORDER BY change_event.change_date_time DESC LIMIT ${limit}`) as ChangeRow[];
    const events = rows.slice(0, limit).map(({ changeEvent: event }) => ({
      resource_name: event?.changeResourceName ?? null,
      resource_type: event?.changeResourceType ?? null,
      operation: event?.resourceChangeOperation ?? null,
      date_time: event?.changeDateTime ?? null,
      client_type: event?.clientType ?? null,
      campaign_id: event?.campaign?.split("/").at(-1) ?? null,
      changed_fields: fieldPaths(event),
    })).sort((a, b) => (b.date_time ?? "").localeCompare(a.date_time ?? "") || (a.resource_name ?? "").localeCompare(b.resource_name ?? ""));
    return {
      connected: true, time_zone: clock.time_zone, window: { start, end: clock.date_time }, events,
      possibly_truncated: rows.length >= limit, limit,
      limitation: "Current account day plus previous requested calendar days, within the past 30 days. Change events may lag by several minutes and do not cover every UI history resource. Shared-budget changes can have no campaign ID. No matching event means no relevant change observed in available history, never nothing changed. Old/new values and user emails are neither selected nor returned.",
    };
  },
};
