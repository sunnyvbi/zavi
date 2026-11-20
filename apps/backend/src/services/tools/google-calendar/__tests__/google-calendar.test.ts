import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";

const listEventsMock = vi.fn();
vi.mock("../_client", () => ({
  listEvents: (...args: unknown[]) => listEventsMock(...args),
}));

import { gCalListEventsTool } from "../list_events";

const ctx = { tenant_id: "t-1" } as any;

beforeEach(() => {
  listEventsMock.mockReset();
});

describe("gCalListEventsTool", () => {
  it("maps a timed event with attendees → a typed EventRow", async () => {
    listEventsMock.mockResolvedValue({
      items: [
        {
          id: "evt-1",
          status: "confirmed",
          summary: "1:1 with Jemis",
          htmlLink: "https://calendar.google.com/event?eid=abc",
          start: { dateTime: "2026-09-02T17:00:00Z", timeZone: "UTC" },
          end: { dateTime: "2026-09-02T17:30:00Z", timeZone: "UTC" },
          organizer: { email: "ravi@upcar.ai", displayName: "Ravi", self: true },
          attendees: [
            { email: "jemis@upcar.ai", displayName: "Jemis", responseStatus: "accepted", self: false },
            { email: "ravi@upcar.ai", displayName: "Ravi", responseStatus: "accepted", self: true, organizer: true },
          ],
        },
      ],
    });

    const out = (await gCalListEventsTool.execute(ctx, {})) as {
      event_count: number;
      events: Array<{ title: string; all_day: boolean; organizer_email: string | null; attendees: Array<{ email: string | null; response_status: string | null }> }>;
    };

    expect(out.event_count).toBe(1);
    expect(out.events[0]).toMatchObject({
      id: "evt-1",
      title: "1:1 with Jemis",
      status: "confirmed",
      start: "2026-09-02T17:00:00Z",
      end: "2026-09-02T17:30:00Z",
      all_day: false,
      organizer_email: "ravi@upcar.ai",
      html_link: "https://calendar.google.com/event?eid=abc",
    });
    expect(out.events[0].attendees).toHaveLength(2);
    expect(out.events[0].attendees[0]).toEqual({
      email: "jemis@upcar.ai",
      display_name: "Jemis",
      response_status: "accepted",
      self: false,
    });
  });

  it("maps an all-day event via the `date` field, not `dateTime`", async () => {
    listEventsMock.mockResolvedValue({
      items: [{ id: "evt-2", status: "confirmed", summary: "Offsite", start: { date: "2026-09-10" }, end: { date: "2026-09-11" } }],
    });
    const out = (await gCalListEventsTool.execute(ctx, {})) as { events: Array<{ all_day: boolean; start: string | null }> };
    expect(out.events[0].all_day).toBe(true);
    expect(out.events[0].start).toBe("2026-09-10");
  });

  it("returns an empty event set (not a crash) when the calendar has no events", async () => {
    listEventsMock.mockResolvedValue({ items: [] });
    const out = (await gCalListEventsTool.execute(ctx, {})) as { event_count: number; events: unknown[] };
    expect(out.event_count).toBe(0);
    expect(out.events).toEqual([]);
  });

  it("defaults an untitled event to a placeholder, never undefined/blank", async () => {
    listEventsMock.mockResolvedValue({ items: [{ id: "evt-3", start: { dateTime: "2026-09-02T09:00:00Z" }, end: { dateTime: "2026-09-02T09:15:00Z" } }] });
    const out = (await gCalListEventsTool.execute(ctx, {})) as { events: Array<{ title: string }> };
    expect(out.events[0].title).toBe("(no title)");
  });

  it("propagates google_calendar_not_connected from the client (no fabricated data)", async () => {
    listEventsMock.mockRejectedValue(
      new ExpectedToolError("google_calendar_not_connected", "not connected"),
    );
    await expect(gCalListEventsTool.execute(ctx, {})).rejects.toMatchObject({
      code: "google_calendar_not_connected",
    });
  });

  it("passes an explicit since/until window through as ISO timeMin/timeMax", async () => {
    listEventsMock.mockResolvedValue({ items: [] });
    await gCalListEventsTool.execute(ctx, { since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z" });
    const params = listEventsMock.mock.calls[0][1];
    expect(params.timeMin).toBe("2026-06-01T00:00:00.000Z");
    expect(params.timeMax).toBe("2026-06-30T00:00:00.000Z");
  });

  it("defaults to a trailing-7d/leading-7d window when since/until are omitted", async () => {
    listEventsMock.mockResolvedValue({ items: [] });
    await gCalListEventsTool.execute(ctx, {});
    const params = listEventsMock.mock.calls[0][1];
    const min = new Date(params.timeMin).getTime();
    const max = new Date(params.timeMax).getTime();
    expect(max - min).toBeGreaterThan(13 * 86_400_000);
    expect(max - min).toBeLessThan(15 * 86_400_000);
  });
});
