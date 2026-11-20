import { describe, it, expect, vi } from "vitest";

vi.mock("@zavi/shared/db-guard", async (orig) => {
  const real = await orig<typeof import("@zavi/shared/db-guard")>();
  const spy = <F extends (...a: never[]) => unknown>(f: F) => vi.fn(f);
  return {
    ...real,
    checkReadOnly: spy(real.checkReadOnly),
    guardSql: spy(real.guardSql),
    compileSummary: spy(real.compileSummary),
    guardMongoFind: spy(real.guardMongoFind),
    guardMongoAggregate: spy(real.guardMongoAggregate),
    policyFromRules: spy(real.policyFromRules),
  };
});

import * as shared from "@zavi/shared/db-guard";
import { checkRequest } from "../check";
import { parseRulesText } from "../rules";
import type { Introspection } from "../db/types";

const intro: Introspection = {
  dialect: "postgres",
  database: null,
  tables: [{ name: "orders", rowEstimate: 10, columns: [{ name: "id", type: "integer", nullable: false }, { name: "city", type: "text", nullable: true }, { name: "total", type: "numeric", nullable: true }] }],
  skippedUnsafeNames: 0,
  namesSeenTotal: 1,
  deadlineHit: false,
  listingTruncated: false,
};
const ctx = (yaml: string, i: Introspection = intro) => ({ rules: parseRulesText(yaml), dialect: i.dialect, database: i.database, catalog: i, maxStatementMs: 30_000 });

describe("guard parity", () => {
  it("SQL goes through the shared read-only check, policy and default-deny guard", () => {
    checkRequest({ op: "sql", text: "SELECT city FROM orders", max_rows: 5 }, ctx("allowed_tables: [orders]\nwhat_can_leave: rows_without_blocked_columns\n"));
    expect(vi.mocked(shared.policyFromRules)).toHaveBeenCalled();
    expect(vi.mocked(shared.checkReadOnly)).toHaveBeenCalledWith("SELECT city FROM orders", "postgres");
    expect(vi.mocked(shared.guardSql)).toHaveBeenCalled();
  });
  it("summaries go through the shared compiler in totals-only mode", () => {
    checkRequest({ op: "summary", request: { table: "orders", measures: [{ fn: "count" }], group_by: [{ field: "city" }] } }, ctx("allowed_tables: [orders]\n"));
    expect(vi.mocked(shared.compileSummary).mock.calls.at(-1)?.[3]).toBe("totals_only");
  });
  it("Mongo goes through the shared recursive guard", () => {
    const m: Introspection = { ...intro, dialect: "mongodb", database: "app", tables: [{ name: "orders", rowEstimate: 1, columns: [{ name: "_id", type: "ObjectId", nullable: false }, { name: "city", type: "String", nullable: true }] }] };
    checkRequest({ op: "mongo", action: "find", collection: "orders", max_rows: 5 }, ctx("allowed_collections: [orders]\nwhat_can_leave: rows_without_blocked_columns\n", m));
    checkRequest({ op: "mongo", action: "aggregate", collection: "orders", pipeline: [{ $match: {} }], max_rows: 5 }, ctx("allowed_collections: [orders]\nwhat_can_leave: rows_without_blocked_columns\n", m));
    expect(vi.mocked(shared.guardMongoFind)).toHaveBeenCalled();
    expect(vi.mocked(shared.guardMongoAggregate)).toHaveBeenCalled();
  });
});
