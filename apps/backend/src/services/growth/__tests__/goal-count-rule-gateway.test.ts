import { describe, it, expect, vi, beforeEach } from "vitest";
import { gatewayHarness } from "@/services/data-gateway/__tests__/harness";

const h = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("@/services/data-gateway/__tests__/harness").gatewayHarness>, reserve: vi.fn() }));
vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: h.reserve,
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));
vi.mock("@/services/data-gateway", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  withReadSession: (ctx: never, fn: never) => h.current!.withReadSession(ctx, fn),
}));

import { defaultCountDeps } from "../goal-count-rule";

const catalog = { tables: [{ name: "users", columns: [{ name: "id" }, { name: "email" }, { name: "role" }] }] };

beforeEach(() => {
  h.reserve.mockReset().mockResolvedValue("log-1");
});

describe("goal count reads through the gateway (both branches)", () => {
  it("SQL: background 'Goal count'; a count that names a hidden field is refused before the DB", async () => {
    h.current = gatewayHarness({ dialect: "postgres", catalog, hidden: ["users.email"], rows: [{ n: 12 }] });
    const out = await defaultCountDeps.sqlRead("t1", "SELECT count(*) AS n FROM users");
    expect(out.rows).toEqual([{ n: 12 }]);
    expect(h.current.contexts[0]).toEqual({ tenant_id: "t1", caller: { kind: "background", feature: "Goal count" } });
    await expect(defaultCountDeps.sqlRead("t1", "SELECT count(DISTINCT email) AS n FROM users")).rejects.toMatchObject({ code: "data_access_refused" });
    expect(h.current.fake.calls.sql).toHaveLength(1);
  });
  it("SQL: a model-proposed count over a transformed personal-data column keeps its number (lineage masking is not skipped)", async () => {
    h.current = gatewayHarness({ dialect: "mysql", catalog: { tables: [{ name: "users", columns: [{ name: "id" }, { name: "full_name" }] }] }, rows: [{ n: "42", label: "x" }] });
    const out = await defaultCountDeps.sqlRead("t1", "SELECT count(DISTINCT lower(full_name)) AS n, 'x' AS label FROM users");
    expect(out.rows).toEqual([{ n: "42", label: "‹redacted›" }]);
  });
  it("Mongo: a pipeline that moves a personal-data field under another name comes back masked (review F4)", async () => {
    h.current = gatewayHarness({ dialect: "mongodb", catalog: { tables: [{ name: "users", columns: [{ name: "id" }, { name: "full_name" }] }] }, docs: [{ label: "Ada Lovelace", n: 4 }] });
    const out = await defaultCountDeps.mongoAggregate("t1", "users", [{ $project: { label: "$full_name", n: 1 } }]);
    expect(out.rows).toEqual([{ label: "‹redacted›", n: 4 }]);
  });
  it("Mongo: aggregate through the session facade with the hidden field unset", async () => {
    h.current = gatewayHarness({ dialect: "mongodb", catalog, hidden: ["users.email"], docs: [{ _id: null, n: 4 }] });
    const out = await defaultCountDeps.mongoAggregate("t1", "users", [{ $match: { role: "host" } }, { $count: "n" }]);
    expect(out).toEqual({ rows: [{ _id: null, n: 4 }], truncated: false });
    const pipeline = h.current.fake.calls.mongo[0]!.args[1] as unknown[];
    expect(pipeline[0]).toEqual({ $unset: ["email"] });
    expect(h.current.contexts[0]!.caller).toEqual({ kind: "background", feature: "Goal count" });
  });
});
