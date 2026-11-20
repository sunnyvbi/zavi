
import { describe, it, expect } from "vitest";
import { smartTruncateToolResult, toolResultCapBytes } from "../smart-truncate";

function pixelRow(id: string, events: number, name?: string) {
  return {
    pixel_id: id,
    name: name ?? `Pixel ${id}`,
    last_fired_time: events > 0 ? "2026-09-17T10:00:00+0000" : null,
    last_fired_age_days: events > 0 ? 0 : null,
    total_events_in_window: events,
    server_events_in_window: events > 0 ? Math.floor(events / 4) : 0,
    event_coverage:
      events > 0
        ? Array.from({ length: 8 }, (_, i) => ({
            start_time: "2026-09-10T17:35:25+0000",
            aggregation: "event_total_counts",
            value: { [`Event${i}`]: events },
          }))
        : [{ start_time: "2026-09-10T17:35:25+0000", aggregation: "event_total_counts" }],
    source_split: events > 0 ? [{ value: { website: events } }] : [],
    match_keys: { present: events > 0 ? ["em", "ph", "fbp", "external_id", "fn", "ln"] : [], unrecognised: 0 },
    status: events > 0 ? "healthy" : "degraded",
  };
}

const LIMITATION =
  "Event Match Quality (EMQ) is not exposed via Meta's Graph API (Events-Manager-UI-only). This tool reports event coverage, last-fired recency, the web-vs-server (CAPI) split and which match_keys are present as the available programmatic proxies — it does not return an EMQ score, and match_keys is NOT an EMQ substitute: it says which parameters are being sent, never how well they matched. overall_status is driven by event VOLUME and recency only, so a pixel firing thousands of events with NO Purchase event still reports `healthy` — read event_coverage yourself before trusting any ROAS.";

function payload(pixels: ReturnType<typeof pixelRow>[]): string {
  return JSON.stringify({
    connected: true,
    pixels_found: pixels.length,
    pixels_reported: pixels.length,
    pixel_ids: pixels.map((p) => p.pixel_id),
    overall_status: "degraded",
    lookback_days: 7,
    pixels,
    limitation: LIMITATION,
  });
}

describe("pixel_health cap — the whole measurement picture reaches the model", () => {
  it("gives meta_ads:pixel_health its own budget (8KB in the original fix, 24KB after the 2026-09-17 measurement)", () => {
    expect(toolResultCapBytes("meta_ads", "pixel_health")).toBe(24 * 1024);
  });

  it("the 3-pixel account that broke would now arrive whole", () => {
    const live = pixelRow("7411390000000001", 2411);
    const dead = pixelRow("7412019000000002", 0, "7411390000000001");
    const other = pixelRow("7413110000000003", 0);
    const raw = payload([live, dead, other]);
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(2 * 1024);
    const out = smartTruncateToolResult(raw, toolResultCapBytes("meta_ads", "pixel_health"));
    expect(out).toContain("7411390000000001");
    expect(out).toContain("7412019000000002");
    expect(out).toContain("7413110000000003");
    expect(out).not.toContain("_truncated");
  });

  it("when even 8KB cannot hold them, the surviving row is the one with events and the loss is counted", () => {
    const pixels = [pixelRow("7411390000000001", 2411), ...Array.from({ length: 30 }, (_, i) => pixelRow(`900000000000${i}`, 0))];
    const out = smartTruncateToolResult(payload(pixels), toolResultCapBytes("meta_ads", "pixel_health"));
    expect(out).toContain("7411390000000001");
    expect(out).toMatch(/_truncated|_returned|_total/);
  });

  it("at the old default the same payload lost pixels — the regression this pins", () => {
    const live = pixelRow("7411390000000001", 2411);
    const dead = pixelRow("7412019000000002", 0, "7411390000000001");
    const other = pixelRow("7413110000000003", 0);
    const out = smartTruncateToolResult(payload([live, dead, other]), 2 * 1024);
    expect(out).not.toBe(payload([live, dead, other]));
  });
});
