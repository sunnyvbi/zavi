import { describe, it, expect } from "vitest";
import { extractSourceDate, yearOlderThanMonths } from "../source-date";

describe("extractSourceDate", () => {
  it("extracts the year from a meta article:published_time", () => {
    const text = `<meta property="article:published_time" content="2022-09-14T10:00:00Z" />`;
    expect(extractSourceDate(text).year).toBe(2022);
  });

  it("extracts the year + month label from a cued dateline", () => {
    const r = extractSourceDate("Published June 4, 2021. The market grew steadily.");
    expect(r.year).toBe(2021);
    expect(r.label).toBe("Jun 2021");
  });

  it("extracts an 'updated' cue", () => {
    const r = extractSourceDate("Last updated 2023 by the editorial team.");
    expect(r.year).toBe(2023);
  });

  it("extracts a fiscal-year filing cue with an FY label", () => {
    const r = extractSourceDate("Per the FY2024 10-K, the fleet was ~360K vehicles.");
    expect(r.year).toBe(2024);
    expect(r.label).toBe("FY2024");
  });

  it("extracts a bare ISO date anywhere in the body", () => {
    const r = extractSourceDate("Report date: 2025-03-01. Findings below.");
    expect(r.year).toBe(2025);
  });

  it("returns null for a bare year with no publish/update cue", () => {
    expect(extractSourceDate("The company was founded in 2019 and is HQ'd in Austin.")).toEqual({
      year: null,
      label: null,
    });
  });

  it("returns null for a copyright footer year (no cue)", () => {
    expect(extractSourceDate("© 2020 Acme Inc. All rights reserved.").year).toBeNull();
  });

  it("returns null for empty / signal-free text", () => {
    expect(extractSourceDate("").year).toBeNull();
    expect(extractSourceDate("No date information here at all.").year).toBeNull();
  });
});

describe("yearOlderThanMonths", () => {
  it("is true when the source year is older than the threshold", () => {
    expect(yearOlderThanMonths(2021, new Date("2026-06-02T00:00:00Z"), 24)).toBe(true);
  });

  it("is false when the source year is within the threshold", () => {
    expect(yearOlderThanMonths(2025, new Date("2026-06-02T00:00:00Z"), 24)).toBe(false);
  });
});
