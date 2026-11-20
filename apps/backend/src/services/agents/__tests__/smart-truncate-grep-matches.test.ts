
import { describe, it, expect } from "vitest";
import { smartTruncateToolResult } from "../smart-truncate";

function grepPayload(matchCount = 40) {
  return {
    scanned_files: 29,
    candidate_files: 2073,
    complete: false,
    stopped_because: "candidate_cap",
    hint: "Scan was bounded (candidate_cap). Zero matches here is NOT proof the pattern is absent — narrow with path_glob and retry before concluding anything is missing.",
    matches: Array.from({ length: matchCount }, (_, i) => ({
      path: `apps/backend/src/services/cohostSplit/file${i}.ts`,
      line: 100 + i,
      text: `export const MAX_TOTAL_SPLIT_PERCENT_${i} = 50; // ${"x".repeat(60)}`,
    })),
  };
}

describe("github__grep matches survive truncation", () => {
  const cap = 2048;

  it("returns real match rows instead of eliding the only code-bearing field", () => {
    const raw = JSON.stringify(grepPayload());
    expect(Buffer.byteLength(raw)).toBeGreaterThan(cap);

    const parsed = JSON.parse(smartTruncateToolResult(raw, cap));

    expect(Array.isArray(parsed.matches)).toBe(true);
    expect(parsed.matches.length).toBeGreaterThan(0);
    expect(parsed.matches[0]).toHaveProperty("path");
    expect(parsed.matches[0]).toHaveProperty("line");
    expect(parsed.matches[0]).toHaveProperty("text");
  });

  it("stays inside the model budget while keeping matches", () => {
    const out = smartTruncateToolResult(JSON.stringify(grepPayload()), cap);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(cap);
  });

  it("says how many matches it dropped, so a short list is never read as the whole list", () => {
    const parsed = JSON.parse(
      smartTruncateToolResult(JSON.stringify(grepPayload()), cap),
    );
    expect(parsed._returned ?? parsed.matches.length).toBeLessThan(40);
    expect(JSON.stringify(parsed)).toMatch(/_total|_returned|_dropped/);
  });

  it("a grep small enough to fit is passed through untouched", () => {
    const raw = JSON.stringify(grepPayload(2));
    const out = smartTruncateToolResult(raw, cap);
    expect(out).toBe(raw);
  });
});

describe("github__grep next_cursor survives truncation", () => {
  it("keeps next_cursor next to the truncated matches", () => {
    const raw = JSON.stringify({ ...grepPayload(), next_cursor: "v1.0123456789ab.300", scanned_range: [0, 300] });
    const out = smartTruncateToolResult(raw, 2048);
    expect(out).toContain("v1.0123456789ab.300");
  });
});
