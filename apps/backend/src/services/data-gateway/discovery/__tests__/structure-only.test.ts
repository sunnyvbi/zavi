import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  pipelines: [] as unknown[][],
  results: [] as unknown[][],
  ddbCommands: [] as string[],
}));

vi.mock("mongodb", () => ({
  MongoClient: class {
    async connect() {}
    async close() {}
    db() {
      return {
        listCollections: () => ({ toArray: async () => [{ name: "users" }] }),
        collection: () => ({
          aggregate: (p: unknown[]) => {
            m.pipelines.push(p);
            return { toArray: async () => m.results.shift() ?? [] };
          },
        }),
      };
    }
  },
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: class {},
  ListTablesCommand: class {
    constructor(public input: unknown) {}
  },
  DescribeTableCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock("@/services/tools/operator-db/dynamodb-uri", () => ({ parseDynamodbUri: () => ({}) }));
vi.mock("../../direct/dynamo", () => ({
  makeDynamoClient: () => ({
    send: async (cmd: { constructor: { name: string } }) => {
      m.ddbCommands.push(cmd.constructor.name);
      if (cmd.constructor.name === "ListTablesCommand") return { TableNames: ["orders"] };
      return {
        Table: {
          AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "gsi1", AttributeType: "N" }],
          KeySchema: [{ AttributeName: "pk" }],
          GlobalSecondaryIndexes: [{ KeySchema: [{ AttributeName: "gsi1" }] }],
          ItemCount: 7,
        },
      };
    },
    destroy() {},
  }),
}));

import { introspectMongo } from "../mongo";
import { introspectDynamodb } from "../dynamodb";

beforeEach(() => {
  m.pipelines = [];
  m.results = [];
  m.ddbCommands = [];
});

describe("Mongo discovery is structure only", () => {
  it("sends exactly the $sample -> $project($objectToArray) -> $unwind -> $group($addToSet $type) pipeline", async () => {
    m.results = [[{ _id: "_id", types: ["objectId"], n: 200 }]];
    await introspectMongo("mongodb://h/app", 10, Date.now() + 5000);
    expect(m.pipelines[0]).toEqual([
      { $sample: { size: 200 } },
      { $project: { _id: 0, kv: { $objectToArray: "$$ROOT" } } },
      { $unwind: "$kv" },
      { $group: { _id: "$kv.k", types: { $addToSet: { $type: "$kv.v" } }, n: { $sum: 1 } } },
      { $limit: 500 },
    ]);
  });
  it("yields only names and types; no fixture value anywhere; nested keys as profile.email", async () => {
    m.results = [
      [
        { _id: "_id", types: ["objectId"], n: 200 },
        { _id: "email", types: ["string"], n: 150, leaked: "ceo@corp.com" },
        { _id: "profile", types: ["object"], n: 200 },
        { _id: "a@b.c", types: [{ v: "evil@x.y" }], n: 1 },
      ],
      [{ _id: "email", types: ["string", "null"], n: 90, sample: "x@y.z" }],
    ];
    const raw = await introspectMongo("mongodb://h/app", 10, Date.now() + 5000);
    const json = JSON.stringify(raw);
    for (const v of ["ceo@corp.com", "x@y.z", "evil@x.y"]) expect(json).not.toContain(v);
    const cols = raw.tables[0]!.columns;
    expect(cols.find((c) => c.name === "email")).toEqual({ name: "email", type: "String", nullable: true });
    expect(cols.find((c) => c.name === "profile.email")).toEqual({ name: "profile.email", type: "String", nullable: true });
    expect(m.pipelines[1]![1]).toEqual({ $match: { profile: { $type: "object" } } });
  });
});

describe("DynamoDB discovery is structure only", () => {
  it("issues no Scan; columns come from the key schema and index keys", async () => {
    const raw = await introspectDynamodb("dynamodb://x", 10, Date.now() + 5000);
    expect(m.ddbCommands).not.toContain("ScanCommand");
    expect(raw.tables[0]!.columns.map((c) => c.name)).toEqual(["pk", "gsi1"]);
    expect(raw.tables[0]!.rowEstimate).toBe(7);
  });
});

describe("Mongo views carry names only from the view definition", () => {
  it("viewRemovedFields reads a leading $project exclusion or $unset", async () => {
    const { viewRemovedFields } = await import("../mongo");
    expect(viewRemovedFields([{ $project: { email: 0, phone: false, city: 1 } }, { $match: {} }])).toEqual(["email", "phone"]);
    expect(viewRemovedFields([{ $unset: ["email"] }])).toEqual(["email"]);
    expect(viewRemovedFields([{ $match: {} }, { $project: { email: 0 } }])).toEqual([]);
    expect(viewRemovedFields(undefined)).toEqual([]);
  });
});
