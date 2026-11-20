
import { z } from "zod";
import { listEvents, type GCalEvent } from "./_client";
import type { ToolSpec } from "@/services/tools/types";

const inputSchema = z.object({
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  max_results: z.number().int().min(1).max(2500).default(250),
});

type EventRow = {
  id: string | null;
  title: string;
  status: string;
  start: string | null;
  end: string | null;
  all_day: boolean;
  organizer_email: string | null;
  attendees: Array<{ email: string | null; display_name: string | null; response_status: string | null; self: boolean }>;
  html_link: string | null;
};

function toIso(t?: { date?: string; dateTime?: string }): { value: string | null; all_day: boolean } {
  if (t?.dateTime) return { value: t.dateTime, all_day: false };
  if (t?.date) return { value: t.date, all_day: true };
  return { value: null, all_day: false };
}

function mapEvent(e: GCalEvent): EventRow {
  const start = toIso(e.start);
  const end = toIso(e.end);
  return {
    id: e.id ?? null,
    title: e.summary ?? "(no title)",
    status: e.status ?? "confirmed",
    start: start.value,
    end: end.value,
    all_day: start.all_day,
    organizer_email: e.organizer?.email ?? null,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email ?? null,
      display_name: a.displayName ?? null,
      response_status: a.responseStatus ?? null,
      self: a.self === true,
    })),
    html_link: e.htmlLink ?? null,
  };
}

export const gCalListEventsTool: ToolSpec = {
  name: "google_calendar_list_events",
  effect: "read",
  description:
    "Read events from the operator's connected Google Calendar in a time window: title, start/end, status, organizer, and attendees with their response status. Read-only via the Calendar v3 API. Defaults to the trailing 7 days through the next 7 days. Throws google_calendar_not_connected if OAuth is not yet wired.",
  input_schema: inputSchema,
  async execute(ctx, input) {
    const { since, until, max_results } = inputSchema.parse(input);
    const now = Date.now();
    const timeMin = since ? new Date(since).toISOString() : new Date(now - 7 * 86_400_000).toISOString();
    const timeMax = until ? new Date(until).toISOString() : new Date(now + 7 * 86_400_000).toISOString();

    const resp = await listEvents(ctx.tenant_id, { timeMin, timeMax, maxResults: max_results });
    const events = (resp.items ?? []).map(mapEvent);

    return {
      time_min: timeMin,
      time_max: timeMax,
      event_count: events.length,
      events,
    };
  },
};
