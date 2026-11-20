import { describe, it, expect, vi, beforeEach } from "vitest";
import { gatewayHarness } from "@/services/data-gateway/__tests__/harness";
import { postgresDriver } from "../drivers/postgres";

const h = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("@/services/data-gateway/__tests__/harness").gatewayHarness>, reserve: vi.fn() }));
vi.mock("@/services/data-gateway/audit", () => ({
  reserveAudit: h.reserve,
  finalizeAudit: vi.fn(async () => undefined),
  writeRefusalAudit: vi.fn(async () => null),
}));
vi.mock("@/services/data-gateway", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  withAttachedDriver: async (ctx: never, fn: (db: unknown) => unknown) => fn(await h.current!.resolveAttachedDb(ctx, postgresDriver)),
}));

import { readTableRows } from "../row-browser";

const catalog = {
  tables: [
    { name: "users", columns: [{ name: "id", type: "int" }, { name: "email", type: "text" }, { name: "role", type: "text" }] },
    { name: "audit", columns: [{ name: "id", type: "int" }] },
  ],
};

beforeEach(() => {
  h.reserve.mockReset().mockResolvedValue("log-1");
});

describe("table browser through the gateway (person read)", () => {
  it("enforces hidden fields and logs the person + feature", async () => {
    h.current = gatewayHarness({ dialect: "postgres", catalog, hidden: ["users.email"], disabled: ["audit"], rows: [{ id: 1, email: "a@b.c", role: "host" }] });
    const r = await readTableRows({ tenantId: "t1", userId: "u-9", table: "users", limit: 10, offset: 0 });
    expect(r.columns.map((c) => c.name)).toEqual(["id", "role"]);
    expect(JSON.stringify(r.rows)).not.toContain("a@b.c");
    expect(h.current.contexts[0]).toEqual({ tenant_id: "t1", caller: { kind: "person", user_id: "u-9", feature: "Table browser" } });
    expect(h.reserve.mock.calls[0]![0]).toMatchObject({ ctx: { caller: { kind: "person", feature: "Table browser" } } });
  });
  it("a switched-off table is refused", async () => {
    h.current = gatewayHarness({ dialect: "postgres", catalog, disabled: ["audit"] });
    await expect(readTableRows({ tenantId: "t1", userId: "u-9", table: "audit", limit: 10, offset: 0 })).rejects.toMatchObject({ code: "operator_db_bad_table" });
    expect(h.current.fake.calls.sql).toHaveLength(0);
  });
});
