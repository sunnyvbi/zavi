import { describe, expect, it } from "vitest";

import { interleaveByTime } from "./threadTimeline";

const row = (id: string, created_at: string) => ({ id, created_at });
const item = (id: string, at: string) => ({ id, at });

function order(entries: ReturnType<typeof interleaveByTime<{ id: string; created_at: string }, { id: string; at: string }>>) {
  return entries.map((e) => (e.kind === "row" ? e.row.id : e.item.id));
}

describe("interleaveByTime", () => {
  it("puts a change made after a chat turn below it, and an earlier one above it", () => {
    const rows = [
      row("forgot-password", "2026-10-02T09:57:00.000+00:00"),
      row("engineer-reply", "2026-10-02T09:57:20.000+00:00"),
    ];
    const extras = [
      item("show-website", "2026-10-02T12:34:00.000Z"),
      item("hero-darker", "2026-10-02T08:00:00.000Z"),
      item("owner-signin", "2026-10-02T12:40:00.000Z"),
    ];
    expect(order(interleaveByTime(rows, extras))).toEqual([
      "hero-darker",
      "forgot-password",
      "engineer-reply",
      "show-website",
      "owner-signin",
    ]);
  });

  it("compares instants, not strings, across +00:00 and Z offsets", () => {
    const rows = [row("chat", "2026-10-02T10:00:00.500+00:00")];
    const extras = [item("change", "2026-10-02T10:00:00.400Z")];
    expect(order(interleaveByTime(rows, extras))).toEqual(["change", "chat"]);
    const later = [item("change", "2026-10-02T15:30:00.000+05:30")];
    expect(order(interleaveByTime(rows, later))).toEqual(["change", "chat"]);
  });

  it("keeps a chat row ahead of a change stamped at the same instant, and keeps each list's own order", () => {
    const rows = [row("a", "2026-10-02T10:00:00Z"), row("b", "2026-10-02T10:00:00Z")];
    const extras = [item("x", "2026-10-02T10:00:00Z"), item("y", "2026-10-02T10:00:00Z")];
    expect(order(interleaveByTime(rows, extras))).toEqual(["a", "b", "x", "y"]);
  });

  it("reports each row's original index so per-row lookups stay aligned", () => {
    const rows = [row("a", "2026-10-02T10:00:00Z"), row("b", "2026-10-02T12:00:00Z")];
    const entries = interleaveByTime(rows, [item("x", "2026-10-02T11:00:00Z")]);
    expect(entries.map((e) => (e.kind === "row" ? e.index : -1))).toEqual([0, -1, 1]);
  });

  it("sends an unparseable change time to the end instead of the top", () => {
    const rows = [row("a", "2026-10-02T10:00:00Z")];
    expect(order(interleaveByTime(rows, [item("bad", "not a date")]))).toEqual(["a", "bad"]);
  });
});
