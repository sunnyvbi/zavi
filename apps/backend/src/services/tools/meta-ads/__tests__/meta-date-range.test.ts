
import { describe, it, expect } from "vitest";
import { metaDateRange } from "../_client";

const NOW = new Date("2026-09-28T15:00:00Z");

describe("metaDateRange", () => {
  it("last_7d is the 7 full days ending yesterday", () => {
    expect(metaDateRange("last_7d", NOW)).toEqual({ since: "2026-09-21", until: "2026-09-27" });
  });

  it("last_30d is the 30 full days ending yesterday", () => {
    expect(metaDateRange("last_30d", NOW)).toEqual({ since: "2026-08-29", until: "2026-09-27" });
  });

  it("crosses a month boundary", () => {
    expect(metaDateRange("last_14d", new Date("2026-03-02T13:00:00Z"))).toEqual({
      since: "2026-02-16",
      until: "2026-03-01",
    });
  });

  it("never includes a partial account-local day: 01:00 UTC is still yesterday evening in the US", () => {
    expect(metaDateRange("last_7d", new Date("2026-09-28T01:00:00Z"))).toEqual({ since: "2026-09-20", until: "2026-09-26" });
  });

  it("unknown preset falls back to 7 full days ending yesterday", () => {
    expect(metaDateRange("bogus", NOW)).toEqual({ since: "2026-09-21", until: "2026-09-27" });
  });

  it("month presets keep their bounds", () => {
    expect(metaDateRange("this_month", NOW)).toEqual({ since: "2026-09-01", until: "2026-09-28" });
    expect(metaDateRange("last_month", NOW)).toEqual({ since: "2026-08-01", until: "2026-08-31" });
  });
});
