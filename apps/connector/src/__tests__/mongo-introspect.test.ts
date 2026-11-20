import { describe, it, expect } from "vitest";
import { openMongo, type MongoFactory } from "../db/mongo";

function factory(aggregate: (coll: string, pipeline: Array<Record<string, unknown>>) => Promise<unknown[]>): MongoFactory {
  return (async () => ({
    on: () => undefined,
    connect: async () => undefined,
    close: async () => undefined,
    db: () => ({
      listCollections: () => ({ toArray: async () => [{ name: "orders" }, { name: "users" }] }),
      collection: (coll: string) => ({
        aggregate: (pipeline: Array<Record<string, unknown>>) => ({ toArray: () => aggregate(coll, pipeline) }),
        estimatedDocumentCount: async () => 10,
      }),
    }),
  })) as unknown as MongoFactory;
}
const timeout = () => Object.assign(new Error("operation exceeded time limit"), { code: 50 });
const URI = "mongodb://localhost:27017/shop";

describe("connector Mongo describe: any timeout marks the scan unfinished", () => {
  it("nested pass timeouts leave sub-fields out and mark the scan unfinished; every collection is still read", async () => {
    const d = openMongo(URI, factory(async (_c, pipeline) => {
      if (pipeline.some((st) => "$match" in st)) throw timeout();
      return [{ _id: "_id", types: ["objectId"], n: 200 }, { _id: "profile", types: ["object"], n: 200 }];
    }));
    const out = await d.introspect(Date.now() + 60_000);
    expect(out.tables.map((t) => t.name)).toEqual(["orders", "users"]);
    expect(out.deadlineHit).toBe(true);
  });

  it("a collection whose top-level read times out is skipped and the scan is unfinished", async () => {
    const d = openMongo(URI, factory(async (c) => {
      if (c === "orders") throw timeout();
      return [{ _id: "_id", types: ["objectId"], n: 200 }];
    }));
    const out = await d.introspect(Date.now() + 60_000);
    expect(out.tables.map((t) => t.name)).toEqual(["users"]);
    expect(out.deadlineHit).toBe(true);
  });
});
