import { describe, it, expect } from "vitest";
import { parseConnectorResult, ConnectorOp } from "@zavi/shared/db-guard";

const rows = (r: unknown[][]) => ({ status: "done", data: { kind: "rows", columns: ["a"], rows: r, truncated: false, removed_columns: [], rule: "rows_without_blocked_columns" } });

describe("parseConnectorResult", () => {
  it("rejects a 1.1 MB result", () => {
    const big = Array.from({ length: 300 }, () => ["x".repeat(4000)]);
    expect(parseConnectorResult(rows(big)).ok).toBe(false);
  });
  it("rejects a depth-9 doc", () => {
    let d: unknown = 1;
    for (let i = 0; i < 9; i++) d = { n: d };
    expect(parseConnectorResult({ status: "done", data: { kind: "docs", docs: [d], truncated: false, removed_columns: [], rule: "rows_without_blocked_columns" } }).ok).toBe(false);
  });
  it("rejects a 5,000-char cell", () => {
    expect(parseConnectorResult(rows([["x".repeat(5000)]])).ok).toBe(false);
  });
  it("rejects an unknown status", () => {
    expect(parseConnectorResult({ status: "maybe" }).ok).toBe(false);
  });
  it.each([
    rows([["a"], [1], [null], [true]]),
    { status: "done", data: { kind: "docs", docs: [{ a: { b: 1 } }], truncated: true, removed_columns: ["email"], rule: "rows_without_blocked_columns" } },
    { status: "done", data: { kind: "count", count: 12 } },
    {
      status: "done",
      data: {
        kind: "describe",
        introspection: { dialect: "postgres", tables: [{ name: "users", columns: [{ name: "id", type: "integer", nullable: false }], rowEstimate: 3 }], skippedUnsafeNames: 0, namesSeenTotal: 1, deadlineHit: false, listingTruncated: false },
      },
    },
    { status: "refused", reason: "users is not allowed by your connector" },
    { status: "failed", reason: "timeout" },
  ])("accepts valid result %#", (v) => {
    expect(parseConnectorResult(v).ok).toBe(true);
  });
});

describe("describe results keep partition info", () => {
  it("a partitioned parent and its partitions survive parsing", () => {
    const r = parseConnectorResult({
      status: "done",
      data: {
        kind: "describe",
        introspection: { dialect: "postgres", tables: [{ name: "events", columns: [{ name: "id", type: "integer", nullable: false }], rowEstimate: null, partitioned: true, partitions: ["events_2026"] }], skippedUnsafeNames: 0, namesSeenTotal: 1, deadlineHit: false, listingTruncated: false },
      },
    });
    expect(r.ok && r.value.status === "done" && r.value.data.kind === "describe" && r.value.data.introspection.tables[0]).toMatchObject({ partitioned: true, partitions: ["events_2026"] });
  });
});

describe("ConnectorOp", () => {
  it("accepts the four ops and rejects others", () => {
    expect(ConnectorOp.safeParse({ op: "sql", text: "SELECT 1", max_rows: 10 }).success).toBe(true);
    expect(ConnectorOp.safeParse({ op: "mongo", action: "find", collection: "u", max_rows: 10 }).success).toBe(true);
    expect(ConnectorOp.safeParse({ op: "summary", request: { table: "u", measures: [{ fn: "count" }] } }).success).toBe(true);
    expect(ConnectorOp.safeParse({ op: "describe" }).success).toBe(true);
    expect(ConnectorOp.safeParse({ op: "mongo", action: "deleteMany", collection: "u", max_rows: 1 }).success).toBe(false);
    expect(ConnectorOp.safeParse({ op: "sql", text: "SELECT 1", max_rows: 5000 }).success).toBe(false);
  });
});

describe("pairing / heartbeat / completion schemas (S4)", () => {
  it("heartbeat accepts a reported rules summary and refuses junk", async () => {
    const { ConnectorHeartbeat } = await import("@zavi/shared/db-guard");
    const rules = { allowed_tables: ["bookings"], blocked_fields: ["users.email"], what_can_leave: "totals_and_counts_only", max_rows: 200 };
    const src = "0123456789abcdef0123456789abcdef";
    expect(ConnectorHeartbeat.safeParse({ machine: "m", version: "1.0", dialect: "postgres", source_instance_id: src, rules, rules_hash: "a".repeat(64) }).success).toBe(true);
    expect(ConnectorHeartbeat.safeParse({ machine: "m", version: "1.0", source_instance_id: null }).success).toBe(true);
    expect(ConnectorHeartbeat.safeParse({ machine: "m", version: "1.0" }).success).toBe(false);
    expect(ConnectorHeartbeat.safeParse({ machine: "m", version: "1.0", source_instance_id: "not-hex" }).success).toBe(false);
    expect(ConnectorHeartbeat.safeParse({ machine: "m", version: "1.0", dialect: "dynamodb" }).success).toBe(false);
    expect(ConnectorHeartbeat.safeParse({ machine: "m", version: "1.0", rules: { ...rules, max_rows: 5000 } }).success).toBe(false);
    expect(ConnectorHeartbeat.safeParse({ machine: "x".repeat(121), version: "1" }).success).toBe(false);
  });
  it("completion needs a uuid execution token and a valid result", async () => {
    const { parseConnectorCompletion } = await import("@zavi/shared/db-guard");
    const token = "99999999-8888-4777-8666-555555555555";
    expect(parseConnectorCompletion({ execution_token: token, status: "refused", reason: "no" })).toMatchObject({ ok: true, execution_token: token });
    expect(parseConnectorCompletion({ execution_token: "x", status: "refused", reason: "no" }).ok).toBe(false);
    expect(parseConnectorCompletion({ execution_token: token, status: "done", data: { kind: "count", count: -1 } }).ok).toBe(false);
    expect(parseConnectorCompletion(null).ok).toBe(false);
  });
  it("a data result must echo the generation and the source instance", async () => {
    const { parseConnectorCompletion } = await import("@zavi/shared/db-guard");
    const token = "99999999-8888-4777-8666-555555555555";
    const done = { status: "done", data: { kind: "count", count: 1 } };
    expect(parseConnectorCompletion({ execution_token: token, ...done }).ok).toBe(false);
    expect(parseConnectorCompletion({ execution_token: token, generation: 3, ...done }).ok).toBe(false);
    expect(parseConnectorCompletion({ execution_token: token, generation: 3, source_instance_id: "0123456789abcdef0123456789abcdef", ...done })).toMatchObject({
      ok: true,
      generation: 3,
      source_instance_id: "0123456789abcdef0123456789abcdef",
    });
    expect(parseConnectorCompletion({ execution_token: token, generation: -1, source_instance_id: null, ...done }).ok).toBe(false);
  });
  it("sql op carries only a safe time zone", async () => {
    const { ConnectorOp } = await import("@zavi/shared/db-guard");
    expect(ConnectorOp.safeParse({ op: "sql", text: "SELECT 1", max_rows: 1, time_zone: "America/New_York" }).success).toBe(true);
    expect(ConnectorOp.safeParse({ op: "sql", text: "SELECT 1", max_rows: 1, time_zone: "UTC'; DROP" }).success).toBe(false);
  });
});

describe("heartbeat rules travel with their hash (review finding 9)", () => {
  it("rules without rules_hash (or the reverse) are refused", async () => {
    const { ConnectorHeartbeat } = await import("@zavi/shared/db-guard");
    const rules = { allowed_tables: [], blocked_fields: [], what_can_leave: "totals_and_counts_only", max_rows: 10 };
    const s = { source_instance_id: null };
    expect(ConnectorHeartbeat.safeParse({ machine: "m", version: "1", rules, ...s }).success).toBe(false);
    expect(ConnectorHeartbeat.safeParse({ machine: "m", version: "1", rules_hash: "a".repeat(64), ...s }).success).toBe(false);
    expect(ConnectorHeartbeat.safeParse({ machine: "m", version: "1", rules, rules_hash: "a".repeat(64), ...s }).success).toBe(true);
  });
});
