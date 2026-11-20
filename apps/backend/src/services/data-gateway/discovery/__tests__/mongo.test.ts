import { describe, it, expect, vi, beforeEach } from "vitest";

const dbCalls: string[] = [];
const listCollections = vi.fn(() => ({
  toArray: async () => [] as Array<{ name: string }>,
}));
let aggregateFor: (coll: string, pipeline: Array<Record<string, unknown>>, opts?: { maxTimeMS?: number }) => Promise<unknown[]> = async () => [];
const dbImpl = vi.fn((name?: string) => {
  dbCalls.push(name ?? "<none>");
  return {
    listCollections,
    collection: (coll: string) => ({
      aggregate: (pipeline: Array<Record<string, unknown>>, opts?: { maxTimeMS?: number }) => ({ toArray: () => aggregateFor(coll, pipeline, opts) }),
    }),
  };
});

vi.mock("mongodb", () => {
  return {
    MongoClient: class {
      constructor(_uri: string, _opts?: unknown) {}
      async connect() {
        return this;
      }
      db(name?: string) {
        return dbImpl(name);
      }
      async close() {
        return undefined;
      }
    },
  };
});

vi.mock("mongodb-schema", () => ({
  parseSchema: async () => ({ fields: [] }),
}));

import { introspectMongo, structureTimeLeft, MONGO_STRUCTURE_MAX_TIME_MS, MONGO_COLLECTION_BUDGET_MS } from "../mongo";
import { mongoStructurePipeline, isMongoTimeout, readMongoStructure } from "@zavi/shared/db-guard";

describe("introspectMongo — db-name from URI (no silent 'test' fallback)", () => {
  beforeEach(() => {
    dbCalls.length = 0;
    listCollections.mockClear();
    dbImpl.mockClear();
  });

  it("rejects when the connection string has no database name in its path", async () => {
    await expect(
      introspectMongo("mongodb+srv://u:p@cluster.mongodb.net/?retryWrites=true"),
    ).rejects.toThrow(/no database name/);
    expect(listCollections).not.toHaveBeenCalled();
  });

  it("uses the path db name and proceeds to listCollections when one is present", async () => {
    const out = await introspectMongo(
      "mongodb+srv://u:p@cluster.mongodb.net/upcar?retryWrites=true",
    );
    expect(dbCalls).toContain("upcar");
    expect(dbImpl).toHaveBeenCalledWith("upcar");
    expect(listCollections).toHaveBeenCalled();
    expect(out.dialect).toBe("mongodb");
  });
});

describe("introspectMongo — one slow collection does not fail the scan", () => {
  const URI = "mongodb+srv://u:p@cluster.mongodb.net/shop";
  const timeout = () => Object.assign(new Error("PlanExecutor error during aggregation :: caused by :: operation exceeded time limit"), { code: 50, codeName: "MaxTimeMSExpired" });

  beforeEach(() => {
    listCollections.mockImplementation(() => ({
      toArray: async () => [{ name: "orders" }, { name: "events" }, { name: "users" }] as Array<{ name: string }>,
    }));
  });

  it("skips a collection whose structure read times out, keeps the others, and marks the scan incomplete", async () => {
    aggregateFor = async (coll, pipeline) => {
      if (coll === "events") throw timeout();
      const nested = pipeline.some((st) => "$match" in st);
      if (nested) throw timeout();
      return [
        { _id: "_id", types: ["objectId"], n: 200 },
        { _id: "profile", types: ["object"], n: 200 },
      ];
    };
    const out = await introspectMongo(URI);
    expect(out.tables.map((t) => t.name).sort()).toEqual(["orders", "users"]);
    expect(out.tables.find((t) => t.name === "orders")!.columns.map((c) => c.name)).toContain("profile");
    expect(out.deadlineHit).toBe(true);
  });

  it("still fails on an error that is not a timeout", async () => {
    aggregateFor = async (coll) => {
      if (coll === "events") throw Object.assign(new Error("not authorized"), { code: 13 });
      return [];
    };
    await expect(introspectMongo(URI)).rejects.toThrow(/not authorized/);
  });

  it("a scan with no timeouts is complete", async () => {
    aggregateFor = async () => [{ _id: "_id", types: ["objectId"], n: 200 }];
    const out = await introspectMongo(URI);
    expect(out.tables).toHaveLength(3);
    expect(out.deadlineHit).toBe(false);
  });

  it("recognises the server timeout shapes", () => {
    expect(isMongoTimeout({ code: 50 })).toBe(true);
    expect(isMongoTimeout({ codeName: "MaxTimeMSExpired" })).toBe(true);
    expect(isMongoTimeout(new Error("operation exceeded time limit"))).toBe(true);
    expect(isMongoTimeout(new Error("not authorized"))).toBe(false);
  });
});

describe("introspectMongo — bounded by the scan deadline and a per-collection budget", () => {
  const URI = "mongodb+srv://u:p@cluster.mongodb.net/shop";

  it("structureTimeLeft never passes the deadline and stops when no time is left", () => {
    expect(structureTimeLeft(1_000_000, 0)).toBe(MONGO_STRUCTURE_MAX_TIME_MS);
    expect(structureTimeLeft(2_000, 0)).toBe(2_000);
    expect(structureTimeLeft(100, 0)).toBeNull();
    expect(structureTimeLeft(0, 50)).toBeNull();
  });

  it("no aggregation is given more server time than the scan has left", async () => {
    listCollections.mockImplementation(() => ({ toArray: async () => [{ name: "orders" }] as Array<{ name: string }> }));
    const seen: number[] = [];
    aggregateFor = async (_coll, _p, opts) => {
      seen.push(opts?.maxTimeMS ?? -1);
      return [{ _id: "_id", types: ["objectId"], n: 200 }];
    };
    await introspectMongo(URI, 10, Date.now() + 1_500);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThanOrEqual(1_500);
  });

  it("a collection whose nested passes run past its budget keeps its top-level fields; the next collection still runs; the scan is incomplete", async () => {
    listCollections.mockImplementation(() => ({ toArray: async () => [{ name: "big" }, { name: "small" }] as Array<{ name: string }> }));
    let clock = 0;
    const realNow = Date.now;
    Date.now = () => clock;
    try {
      aggregateFor = async (coll, pipeline) => {
        const nested = pipeline.some((st) => "$match" in st);
        if (coll === "big" && nested) clock += MONGO_COLLECTION_BUDGET_MS;
        if (coll === "big" && !nested) {
          return Array.from({ length: 5 }, (_, i) => ({ _id: `obj${i}`, types: ["object"], n: 200 }));
        }
        return [{ _id: "_id", types: ["objectId"], n: 200 }];
      };
      const out = await introspectMongo(URI, 10, 10 * 60_000);
      expect(out.tables.map((t) => t.name)).toEqual(["big", "small"]);
      expect(out.tables[0]!.columns.map((c) => c.name)).toEqual(expect.arrayContaining(["obj0", "obj4"]));
      expect(out.deadlineHit).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("mongoStructurePipeline — nested pass samples before filtering", () => {
  it("puts a bounded $sample ahead of the object $match, so it never scans the whole collection", () => {
    const p = mongoStructurePipeline({ nestedKey: "profile" });
    expect(Object.keys(p[0])).toEqual(["$sample"]);
    expect(Object.keys(p[1])).toEqual(["$match"]);
    expect(p[2]).toEqual({ $limit: 200 });
  });
});

describe("readMongoStructure (shared by direct discovery and the connector)", () => {
  const coll = (fn: () => Promise<unknown[]>) => ({ aggregate: () => ({ toArray: fn }) });
  it("returns rows, returns null on a server timeout, rethrows anything else", async () => {
    expect(await readMongoStructure(coll(async () => [{ _id: "a" }]), [])).toEqual([{ _id: "a" }]);
    expect(await readMongoStructure(coll(async () => { throw Object.assign(new Error("x"), { code: 50 }); }), [])).toBeNull();
    await expect(readMongoStructure(coll(async () => { throw new Error("not authorized"); }), [])).rejects.toThrow(/not authorized/);
  });
});
