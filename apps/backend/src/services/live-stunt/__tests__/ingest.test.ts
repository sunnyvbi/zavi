import { describe, it, expect } from "vitest";
import { parseIngestBody } from "../ingest";

const ok = { from: "2026-08-24T14:00:00.000Z", to: "2026-09-28T15:00:00.000Z", metrics: ["bookings", "new_hosts"], rows: [{ hour: "2026-09-28T13:00:00.000Z", metrics: { bookings: 2, new_hosts: 1 } }] };

describe("parseIngestBody (metrics map)", () => {
  it("accepts a well-formed push, including a metric the page does not use yet", () => {
    expect(parseIngestBody(ok)).toEqual(ok);
    const extra = { ...ok, metrics: ["bookings", "new_listings"], rows: [{ hour: ok.rows[0].hour, metrics: { bookings: 2, new_listings: 5 } }] };
    expect(parseIngestBody(extra)).toEqual(extra);
  });
  it("refuses non-hour times, reversed or oversized windows", () => {
    expect(parseIngestBody({ ...ok, from: "2026-08-24T14:30:00Z" })).toMatch(/on the hour/);
    expect(parseIngestBody({ ...ok, from: ok.to, to: ok.from })).toMatch(/window/);
    expect(parseIngestBody({ ...ok, from: "2026-07-01T00:00:00Z" })).toMatch(/window/);
  });
  it("refuses rows outside the window, duplicates, bad metric names and values", () => {
    expect(parseIngestBody({ ...ok, rows: [{ hour: "2026-10-01T00:00:00Z", metrics: { bookings: 1 } }] })).toMatch(/inside/);
    expect(parseIngestBody({ ...ok, rows: [ok.rows[0], ok.rows[0]] })).toMatch(/duplicate/);
    expect(parseIngestBody({ ...ok, rows: [{ hour: ok.rows[0].hour, metrics: { "Bad-Name": 1 } }] })).toMatch(/snake_case/);
    expect(parseIngestBody({ ...ok, rows: [{ hour: ok.rows[0].hour, metrics: { bookings: -1 } }] })).toMatch(/non-negative/);
    expect(parseIngestBody({ ...ok, rows: [{ hour: ok.rows[0].hour, metrics: { bookings: 1.5 } }] })).toMatch(/non-negative/);
    expect(parseIngestBody({ ...ok, rows: [{ hour: ok.rows[0].hour, metrics: [1] }] })).toMatch(/object/);
  });
  it("requires a reported-metrics list and every row key to be on it", () => {
    const { metrics: _m, ...noList } = ok;
    expect(parseIngestBody(noList)).toMatch(/reported metric names/);
    expect(parseIngestBody({ ...ok, metrics: ["bookings"] })).toMatch(/not in the reported metrics list/);
  });
  it("caps metrics per hour", () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`m${i}`, 1]));
    expect(parseIngestBody({ ...ok, metrics: Object.keys(many).slice(0, 20), rows: [{ hour: ok.rows[0].hour, metrics: many }] })).toMatch(/at most 20/);
  });
  it("an empty rows array is a valid 'nothing happened' push", () => {
    expect(parseIngestBody({ ...ok, rows: [] })).toEqual({ ...ok, rows: [] });
  });
});
