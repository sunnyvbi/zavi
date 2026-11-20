import { describe, it, expect, vi } from "vitest";
import { effectivePolicy, type CatalogLike } from "@zavi/shared/db-guard";
import { guardedDynamoFacade, rawDynamoFacade } from "../direct/dynamo";

const catalog: CatalogLike = {
  tables: [
    { name: "orders", columns: [{ name: "pk" }, { name: "status" }] },
    { name: "archive", columns: [{ name: "pk" }] },
  ],
};
const base = { auto_hide: true, hidden_fields: [] as string[], unhidden_fields: [] as string[], disabled_tables: ["archive"] };

function setup(items: Record<string, unknown>[], row = base) {
  const send = vi.fn(async (_cmd: unknown) => ({ Items: items }));
  const facade = guardedDynamoFacade(rawDynamoFacade({ send }), effectivePolicy(row, catalog, "dynamodb"));
  return { send, facade };
}

describe("closed DynamoDB facade", () => {
  it("switched-off table is refused and the client is never called", async () => {
    const { send, facade } = setup([]);
    await expect(facade.scan({ table: "archive", limit: 10 })).rejects.toThrow(/not a table Zavi may read/);
    expect(send).not.toHaveBeenCalled();
  });
  it("a table not in the catalog (or wrong case) is refused", async () => {
    const { send, facade } = setup([]);
    await expect(facade.scan({ table: "users", limit: 10 })).rejects.toThrow(/not a table/);
    await expect(facade.scan({ table: "Orders", limit: 10 })).rejects.toThrow(/not a table/);
    expect(send).not.toHaveBeenCalled();
  });
  it("sensitive-named attributes are stripped at any depth with no policy entry for them", async () => {
    const { facade } = setup([{ pk: "1", email: "a@b.c", profile: { phone: "555" } }]);
    expect(await facade.scan({ table: "orders", limit: 10 })).toEqual([{ pk: "1", profile: {} }]);
  });
  it("a hidden non-sensitive attribute is stripped", async () => {
    const { facade } = setup([{ pk: "1", note: "x", status: "ok" }], { ...base, hidden_fields: ["orders.note"] });
    expect(await facade.scan({ table: "orders", limit: 10 })).toEqual([{ pk: "1", status: "ok" }]);
  });
  it("requesting a sensitive field is refused", async () => {
    const { send, facade } = setup([]);
    await expect(facade.scan({ table: "orders", fields: ["email"], limit: 10 })).rejects.toThrow(/hidden/);
    expect(send).not.toHaveBeenCalled();
  });
  it("fields: ['status'] sends a ProjectionExpression with attribute names", async () => {
    const { send, facade } = setup([{ status: "ok" }]);
    await facade.scan({ table: "orders", fields: ["status"], limit: 10 });
    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({ TableName: "orders", ProjectionExpression: "#f0", ExpressionAttributeNames: { "#f0": "status" }, Limit: 10 });
  });
  it("must-not-catch: an explicitly un-hidden sensitive attribute is returned", async () => {
    const { facade } = setup([{ pk: "1", email: "a@b.c" }], { ...base, unhidden_fields: ["orders.email"] });
    expect(await facade.scan({ table: "orders", limit: 10 })).toEqual([{ pk: "1", email: "a@b.c" }]);
  });
  it("query by key goes through the same checks", async () => {
    const { send, facade } = setup([{ pk: "1", ssn: "x" }]);
    expect(await facade.query({ table: "orders", key: { pk: "1" }, limit: 5 })).toEqual([{ pk: "1" }]);
    await expect(facade.query({ table: "orders", key: { email: "a" }, limit: 5 })).rejects.toThrow(/hidden/);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
