import { describe, it, expect } from "vitest";
import {
  bucketByDay,
  errorCopy,
  ERROR_COPY,
  isEditable,
  statusTone,
  toCalendarPost,
  weekDays,
  type SocialPostRow,
} from "./socialPostRows";

const row = (o: Partial<SocialPostRow>): SocialPostRow => ({
  id: "p1",
  channel: "linkedin",
  status: "scheduled",
  scheduled_at: null,
  created_at: "2026-09-01T10:00:00.000Z",
  external_url: null,
  last_error: null,
  approved_payload_snapshot: { payload: { text: "Hello\nsecond line" } },
  ...o,
});

describe("weekDays", () => {
  it("is Monday → Sunday at local midnight for a mid-week and a Sunday anchor", () => {
    for (const anchor of [new Date(2026, 8, 9, 15, 30), new Date(2026, 8, 13, 23, 59)]) {
      const days = weekDays(anchor);
      expect(days.map((d) => d.getDate())).toEqual([7, 8, 9, 10, 11, 12, 13]);
      expect(days.every((d) => d.getHours() === 0 && d.getMinutes() === 0)).toBe(true);
      expect(days[0].getDay()).toBe(1);
      expect(days[6].getDay()).toBe(0);
    }
  });
});

describe("toCalendarPost", () => {
  it("sits at scheduled_at when present, else created_at", () => {
    expect(toCalendarPost(row({ scheduled_at: "2026-09-10T09:00:00.000Z" })).at).toBe("2026-09-10T09:00:00.000Z");
    expect(toCalendarPost(row({})).at).toBe("2026-09-01T10:00:00.000Z");
  });

  it("snippet is the first non-empty line, title first, capped at 90 chars", () => {
    expect(toCalendarPost(row({})).snippet).toBe("Hello");
    expect(
      toCalendarPost(row({ approved_payload_snapshot: { payload: { title: "T", text: "body" } } })).snippet,
    ).toBe("T");
    const long = toCalendarPost(row({ approved_payload_snapshot: { payload: { text: "a".repeat(200) } } })).snippet;
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith("…")).toBe(true);
  });

  it("flags media and survives a null snapshot", () => {
    expect(toCalendarPost(row({ approved_payload_snapshot: { payload: { text: "x", image_path: "t/u.jpg" } } })).hasImage).toBe(true);
    expect(toCalendarPost(row({ approved_payload_snapshot: { payload: { text: "x", video_path: "t/u.mp4" } } })).hasVideo).toBe(true);
    expect(toCalendarPost(row({ approved_payload_snapshot: null })).snippet).toBe("");
  });
});

describe("bucketByDay", () => {
  it("groups by LOCAL day and orders within a day; 23:30 local stays on its day", () => {
    const late = new Date(2026, 8, 10, 23, 30).toISOString();
    const early = new Date(2026, 8, 10, 8, 0).toISOString();
    const next = new Date(2026, 8, 11, 0, 15).toISOString();
    const m = bucketByDay([
      toCalendarPost(row({ id: "late", scheduled_at: late })),
      toCalendarPost(row({ id: "next", scheduled_at: next })),
      toCalendarPost(row({ id: "early", scheduled_at: early })),
    ]);
    const keys = [...m.keys()];
    expect(keys).toHaveLength(2);
    expect(m.get(keys[0])!.map((p) => p.id)).toEqual(["early", "late"]);
    expect(m.get(keys[1])!.map((p) => p.id)).toEqual(["next"]);
  });
});

describe("status + error copy", () => {
  it("tones and editability", () => {
    expect(statusTone("published")).toBe("good");
    expect(statusTone("failed")).toBe("bad");
    expect(statusTone("publishing")).toBe("warn");
    expect(statusTone("scheduled")).toBe("neutral");
    expect(statusTone("cancelled")).toBe("neutral");
    expect(isEditable("approved")).toBe(true);
    expect(isEditable("scheduled")).toBe(true);
    expect(isEditable("publishing")).toBe(false);
    expect(isEditable("published")).toBe(false);
  });

  it("has copy for all six DB error codes and degrades for an unknown one", () => {
    expect(Object.keys(ERROR_COPY).sort()).toEqual(
      ["channel_disabled", "disconnected", "snapshot_changed", "transient_exhausted", "unauthorized_destination", "vendor_rejected"],
    );
    for (const c of Object.keys(ERROR_COPY)) expect(errorCopy(c)).toBe(ERROR_COPY[c]);
    expect(errorCopy("weird_code")).toBe("weird code");
    expect(errorCopy(null)).toBeNull();
  });
});
