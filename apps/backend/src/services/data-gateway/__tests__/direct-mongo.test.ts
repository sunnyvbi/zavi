import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  handlers: {} as Record<string, (e: unknown) => void>,
  aggregate: vi.fn(),
  opts: null as unknown,
}));

vi.mock("mongodb", () => ({
  MongoClient: class {
    constructor(_uri: string, opts: unknown) {
      m.opts = opts;
    }
    on(ev: string, fn: (e: unknown) => void) {
      m.handlers[ev] = fn;
    }
    async connect() {}
    async close() {}
    db() {
      return {
        collection: () => ({
          aggregate: (p: unknown) => {
            m.aggregate(p);
            return { toArray: async () => [{ n: 1 }] };
          },
          countDocuments: async () => 3,
        }),
      };
    }
  },
}));

import { openMongoSession, mongoDbNameFromUri } from "../direct/mongo";

beforeEach(() => {
  m.handlers = {};
  m.aggregate.mockReset();
});

describe("direct Mongo session", () => {
  it("is secondaryPreferred, no retryable writes, command-monitored", async () => {
    await openMongoSession("mongodb://h/app");
    expect(m.opts).toMatchObject({ readPreference: "secondaryPreferred", retryWrites: false, monitorCommands: true });
  });
  it("refuses a pipeline with a write stage before sending it", async () => {
    const s = await openMongoSession("mongodb://h/app");
    await expect(s.mongo().aggregate("users", [{ $match: {} }, { $out: "x" }])).rejects.toThrow(/must not write/);
    await expect(s.mongo().aggregate("users", [{ $lookup: { from: "a", pipeline: [{ $merge: "x" }], as: "y" } }])).rejects.toThrow(/must not write/);
    expect(m.aggregate).not.toHaveBeenCalled();
  });
  it("a non-read command seen on the wire poisons the session", async () => {
    const s = await openMongoSession("mongodb://h/app");
    m.handlers.commandStarted!({ commandName: "insert", command: {} });
    await expect(s.mongo().countDocuments("users", {})).rejects.toThrow(/non-read Mongo command/);
  });
  it("exposes no SQL or DynamoDB reads, and the database name", async () => {
    const s = await openMongoSession("mongodb://h/app");
    await expect(s.query("SELECT 1")).rejects.toThrow(/not available/);
    expect(s.mongo().database).toEqual({ name: "app", explicit: true });
    expect(mongoDbNameFromUri("mongodb://h/")).toEqual({ name: "test", explicit: false });
  });
});
