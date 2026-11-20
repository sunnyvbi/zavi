
import { describe, it, expect } from "vitest";
import {
  truncateErrors,
  normalizeErrorSignature,
  aggregateErrors,
  type ErrorRunRow,
} from "../errors";

function mkRow(over: Partial<ErrorRunRow> = {}): ErrorRunRow {
  return {
    id: "r1",
    tenant_id: "t1",
    agent_slug: "cto",
    status: "failed",
    started_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:01:00Z",
    error: "boom",
    ...over,
  };
}

describe("truncateErrors", () => {
  it("empty input → empty list", () => {
    expect(truncateErrors([])).toEqual([]);
  });

  it("passes through short error text and all other fields unchanged", () => {
    const row = mkRow({ error: "short error" });
    expect(truncateErrors([row])).toEqual([row]);
  });

  it("truncates error text to 500 chars", () => {
    const long = "x".repeat(1200);
    const out = truncateErrors([mkRow({ error: long })]);
    expect(out[0].error).toHaveLength(500);
    expect(out[0].error).toBe("x".repeat(500));
  });

  it("keeps null error as null (does not coerce to empty string)", () => {
    const out = truncateErrors([mkRow({ error: null })]);
    expect(out[0].error).toBeNull();
  });

  it("error exactly 500 chars is unchanged", () => {
    const exact = "y".repeat(500);
    const out = truncateErrors([mkRow({ error: exact })]);
    expect(out[0].error).toBe(exact);
  });

  it("does not mutate the input rows (returns new objects)", () => {
    const row = mkRow({ error: "z".repeat(600) });
    const out = truncateErrors([row]);
    expect(row.error).toHaveLength(600);
    expect(out[0]).not.toBe(row);
  });
});

describe("normalizeErrorSignature", () => {
  it("null / blank → stable '(no error text)' bucket", () => {
    expect(normalizeErrorSignature(null)).toBe("(no error text)");
    expect(normalizeErrorSignature("")).toBe("(no error text)");
    expect(normalizeErrorSignature("   ")).toBe("(no error text)");
  });

  it("strips UUIDs so per-run ids don't scatter identical failures", () => {
    const a = normalizeErrorSignature(
      "run 11111111-2222-3333-4444-555555555555 timed out",
    );
    const b = normalizeErrorSignature(
      "run aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee timed out",
    );
    expect(a).toBe(b);
    expect(a).toBe("run <uuid> timed out");
  });

  it("strips ISO timestamps", () => {
    const a = normalizeErrorSignature("failed at 2026-05-24T03:34:00.000Z");
    const b = normalizeErrorSignature("failed at 2026-01-01T00:00:00Z");
    expect(a).toBe(b);
    expect(a).toBe("failed at <ts>");
  });

  it("strips bare numbers (line numbers, ports, ms)", () => {
    const a = normalizeErrorSignature("ECONNREFUSED 127.0.0.1:4000 after 5000ms");
    const b = normalizeErrorSignature("ECONNREFUSED 10.0.0.2:3001 after 250ms");
    expect(a).toBe(b);
  });

  it("strips long hex blobs and 0x addresses", () => {
    const a = normalizeErrorSignature("hash deadbeefcafe1234 segfault at 0xff");
    const b = normalizeErrorSignature("hash 0123456789abcdef segfault at 0x10");
    expect(a).toBe(b);
  });

  it("collapses quoted literals so embedded slugs/ids cluster", () => {
    const a = normalizeErrorSignature("tool 'gmail.send' not found");
    const b = normalizeErrorSignature("tool 'slack.post' not found");
    expect(a).toBe(b);
    expect(a).toBe("tool '<v>' not found");
  });

  it("lowercases and collapses whitespace", () => {
    expect(normalizeErrorSignature("  BOOM\t\nBOOM ")).toBe("boom boom");
  });

  it("caps signature length", () => {
    expect(normalizeErrorSignature("z".repeat(800)).length).toBeLessThanOrEqual(300);
  });
});

describe("aggregateErrors", () => {
  it("empty input → empty summary", () => {
    expect(aggregateErrors([])).toEqual([]);
  });

  it("groups failures with the same signature + agent, stripping volatile tokens", () => {
    const rows: ErrorRunRow[] = [
      mkRow({ id: "r1", agent_slug: "cto", error: "timeout after 5000ms" }),
      mkRow({ id: "r2", agent_slug: "cto", error: "timeout after 12000ms" }),
      mkRow({ id: "r3", agent_slug: "cto", error: "timeout after 300ms" }),
    ];
    const out = aggregateErrors(rows);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
    expect(out[0].agent_slug).toBe("cto");
    expect(out[0].run_ids).toEqual(["r1", "r2", "r3"]);
  });

  it("same signature on a different agent is a separate group", () => {
    const rows: ErrorRunRow[] = [
      mkRow({ id: "r1", agent_slug: "cto", error: "boom" }),
      mkRow({ id: "r2", agent_slug: "ads", error: "boom" }),
    ];
    expect(aggregateErrors(rows)).toHaveLength(2);
  });

  it("sorts by count descending, then most-recent last_seen", () => {
    const rows: ErrorRunRow[] = [
      mkRow({ id: "a", error: "rare", finished_at: "2026-01-09T00:00:00Z" }),
      mkRow({ id: "b", error: "common", finished_at: "2026-01-01T00:00:00Z" }),
      mkRow({ id: "c", error: "common", finished_at: "2026-01-05T00:00:00Z" }),
    ];
    const out = aggregateErrors(rows);
    expect(out.map((g) => g.signature)).toEqual(["common", "rare"]);
    expect(out[0].count).toBe(2);
    expect(out[0].last_seen).toBe("2026-01-05T00:00:00Z");
  });

  it("ties on count break by most-recent last_seen", () => {
    const rows: ErrorRunRow[] = [
      mkRow({ id: "a", error: "older", finished_at: "2026-01-01T00:00:00Z" }),
      mkRow({ id: "b", error: "newer", finished_at: "2026-01-05T00:00:00Z" }),
    ];
    const out = aggregateErrors(rows);
    expect(out.map((g) => g.signature)).toEqual(["newer", "older"]);
  });

  it("collects distinct statuses + tenants and keeps a sample error", () => {
    const rows: ErrorRunRow[] = [
      mkRow({ id: "r1", tenant_id: "t1", status: "failed", error: "db down 1" }),
      mkRow({ id: "r2", tenant_id: "t2", status: "dispatch_error", error: "db down 2" }),
      mkRow({ id: "r3", tenant_id: "t1", status: "failed", error: "db down 3" }),
    ];
    const out = aggregateErrors(rows);
    expect(out).toHaveLength(1);
    expect(out[0].statuses.sort()).toEqual(["dispatch_error", "failed"]);
    expect(out[0].tenants.sort()).toEqual(["t1", "t2"]);
    expect(out[0].sample_error).toBe("db down 1");
  });

  it("null-error rows cluster under the '(no error text)' signature", () => {
    const rows: ErrorRunRow[] = [
      mkRow({ id: "r1", error: null }),
      mkRow({ id: "r2", error: null }),
    ];
    const out = aggregateErrors(rows);
    expect(out).toHaveLength(1);
    expect(out[0].signature).toBe("(no error text)");
    expect(out[0].count).toBe(2);
    expect(out[0].sample_error).toBeNull();
  });

  it("caps run_ids per group at 5 (flood protection)", () => {
    const rows: ErrorRunRow[] = Array.from({ length: 12 }, (_, i) =>
      mkRow({ id: `r${i}`, error: "same failure" }),
    );
    const out = aggregateErrors(rows);
    expect(out[0].count).toBe(12);
    expect(out[0].run_ids).toHaveLength(5);
  });

  it("truncates the sample error to 500 chars", () => {
    const out = aggregateErrors([mkRow({ error: "x".repeat(900) })]);
    expect(out[0].sample_error).toHaveLength(500);
  });
});
