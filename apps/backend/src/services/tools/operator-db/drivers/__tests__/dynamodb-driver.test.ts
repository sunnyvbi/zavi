
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

type CapturedCall = { name: string; input: Record<string, unknown> };
const captured: CapturedCall[] = [];
let nextGetResponse: { Item?: Record<string, unknown> | null } = { Item: null };
let nextQueryResponse: { Items?: Record<string, unknown>[] } = { Items: [] };
let nextScanResponse: { Items?: Record<string, unknown>[] } = { Items: [] };
let forceQueryValidationException = false;

vi.mock("@aws-sdk/client-dynamodb", () => {
  return {
    DynamoDBClient: class {
      constructor(_cfg: Record<string, unknown>) {}
      destroy() {}
      async send(_cmd: unknown) {
        return {};
      }
    },
    GetItemCommand: class {
      constructor(public input: Record<string, unknown>) {}
    },
    QueryCommand: class {
      constructor(public input: Record<string, unknown>) {}
    },
    ScanCommand: class {
      constructor(public input: Record<string, unknown>) {}
    },
    ListTablesCommand: class {
      constructor(public input: Record<string, unknown>) {}
    },
    DescribeTableCommand: class {
      constructor(public input: Record<string, unknown>) {}
    },
  };
});

vi.mock("@aws-sdk/lib-dynamodb", () => {
  class GetCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class QueryCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class ScanCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  return {
    GetCommand,
    QueryCommand,
    ScanCommand,
    DynamoDBDocumentClient: {
      from(_low: unknown, _opts?: unknown) {
        return {
          async send(cmd: { input: Record<string, unknown> } & object) {
            const name = cmd.constructor.name;
            captured.push({ name, input: cmd.input });
            if (name === "GetCommand") return nextGetResponse;
            if (name === "QueryCommand") {
              if (forceQueryValidationException) {
                const err = new Error("ValidationException");
                (err as { name: string }).name = "ValidationException";
                throw err;
              }
              return nextQueryResponse;
            }
            if (name === "ScanCommand") return nextScanResponse;
            return {};
          },
        };
      },
    },
  };
});

import { dynamodbDriver, parseDynamodbUri } from "../dynamodb";
import type { SchemaMap } from "../../types";
import { attachSession } from "../../session-attach";
import { openDynamoSession } from "@/services/data-gateway/direct/dynamo";

async function attachConn(cfg: SchemaMap, conn: string): Promise<void> {
  attachSession(cfg, await openDynamoSession(conn));
}

const CONN = "dynamodb://AKIAEXAMPLE:secret123@us-east-1";

async function makeCfg(): Promise<SchemaMap> {
  const cfg: SchemaMap = {
    users: { table: "users", id_field: "user_id" },
    listings: { table: "listings", id_field: "listing_id" },
    transactions: { table: "transactions", id_field: "id" },
  };
  await attachConn(cfg, CONN);
  return cfg;
}

beforeEach(() => {
  captured.length = 0;
  nextGetResponse = { Item: null };
  nextQueryResponse = { Items: [] };
  nextScanResponse = { Items: [] };
  forceQueryValidationException = false;
});

describe("parseDynamodbUri", () => {
  it("parses region + credentials from a valid URI", () => {
    const p = parseDynamodbUri("dynamodb://AKIA:sk@eu-west-1");
    expect(p.region).toBe("eu-west-1");
    expect(p.accessKeyId).toBe("AKIA");
    expect(p.secretAccessKey).toBe("sk");
    expect(p.endpoint).toBeUndefined();
    expect(p.sessionToken).toBeUndefined();
  });

  it("parses optional endpoint + session_token query params", () => {
    const p = parseDynamodbUri(
      "dynamodb://AKIA:sk@us-east-1?endpoint=https://dynamodb.us-east-1.amazonaws.com&session_token=ST",
    );
    expect(p.endpoint).toBe("https://dynamodb.us-east-1.amazonaws.com");
    expect(p.sessionToken).toBe("ST");
  });

  it("rejects a non-dynamodb scheme", () => {
    expect(() => parseDynamodbUri("postgres://u:p@host/db")).toThrow(/dynamodb:\/\//);
  });

  it("rejects a URI missing credentials", () => {
    expect(() => parseDynamodbUri("dynamodb://us-east-1")).toThrow(/missing/i);
  });

  it("rejects a garbage URI", () => {
    expect(() => parseDynamodbUri("not a uri at all")).toThrow(/valid URI/i);
  });
});

describe("dynamodbDriver — read ops", () => {
  it("query_user queries by the partition key through the closed facade", async () => {
    nextQueryResponse = { Items: [{ user_id: "u_1", email: "e@x" }] };
    const drv = dynamodbDriver();
    const res = await drv.query_user("u_1", await makeCfg());
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ user_id: "u_1", email: "e@x" });
    const call = captured.find((c) => c.name === "QueryCommand");
    expect(call?.input).toMatchObject({
      TableName: "users",
      KeyConditionExpression: "#k0 = :v0",
      ExpressionAttributeNames: { "#k0": "user_id" },
      ExpressionAttributeValues: { ":v0": "u_1" },
      Limit: 1,
    });
  });

  it("query_user returns null when the item is missing", async () => {
    nextQueryResponse = { Items: [] };
    const drv = dynamodbDriver();
    const res = await drv.query_user("missing", await makeCfg());
    expect(res.data).toBeNull();
  });

  it("query_listing throws when schema_map.listings is missing", async () => {
    const drv = dynamodbDriver();
    const cfg: SchemaMap = { users: { table: "users", id_field: "id" } };
    await attachConn(cfg, CONN);
    await expect(drv.query_listing("l1", cfg)).rejects.toThrow(/schema_map\.listings/);
  });

  it("query_recent_transactions uses Query first with newest-first order", async () => {
    nextQueryResponse = { Items: [{ id: "t1", created_at: "2026-01-01" }] };
    const drv = dynamodbDriver();
    const res = await drv.query_recent_transactions("u_1", 1_700_000_000, await makeCfg());
    expect(res.ok).toBe(true);
    const qc = captured.find((c) => c.name === "QueryCommand");
    expect(qc?.input.TableName).toBe("transactions");
    expect(qc?.input.ScanIndexForward).toBe(false);
    expect(qc?.input.Limit).toBe(100);
    expect(captured.find((c) => c.name === "ScanCommand")).toBeUndefined();
  });

  it("query_recent_transactions falls back to Scan on ValidationException", async () => {
    forceQueryValidationException = true;
    nextScanResponse = { Items: [{ id: "t2", user_id: "u_1" }] };
    const drv = dynamodbDriver();
    const res = await drv.query_recent_transactions("u_1", 1_700_000_000, await makeCfg());
    expect(res.ok).toBe(true);
    expect((res.data as unknown[])?.length).toBe(1);
    const sc = captured.find((c) => c.name === "ScanCommand");
    expect(sc?.input.TableName).toBe("transactions");
    expect(sc?.input.Limit).toBe(100);
  });

  it("throws operator_db_no_conn when the schema_map has no connection attached", async () => {
    const drv = dynamodbDriver();
    const cfg: SchemaMap = { users: { table: "users", id_field: "id" } };
    await expect(drv.query_user("u_1", cfg)).rejects.toThrow(/no_conn|session not attached/);
  });

  it("rejects an unsafe table name (defense-in-depth)", async () => {
    const drv = dynamodbDriver();
    const cfg: SchemaMap = {
      users: { table: "users; DROP TABLE", id_field: "id" },
    };
    await attachConn(cfg, CONN);
    await expect(drv.query_user("u_1", cfg)).rejects.toThrow(/invalid_identifier|Bad DynamoDB/);
  });
});

describe("dynamodbDriver — aggregate ops throw a stable code", () => {
  const drv = dynamodbDriver();
  let cfg: SchemaMap;
  beforeAll(async () => {
    cfg = await makeCfg();
  });

  it("query_bookings_by_geo_category throws operator_db_aggregate_not_yet_implemented", async () => {
    await expect(
      drv.query_bookings_by_geo_category({ lookback_weeks: 4, top_n: 5 }, cfg),
    ).rejects.toThrow(/not_yet_implemented|not implemented/);
  });

  it("query_new_users_in_window throws operator_db_aggregate_not_yet_implemented", async () => {
    await expect(
      drv.query_new_users_in_window({ window_days: 7 }, cfg),
    ).rejects.toThrow(/not_yet_implemented|not implemented/);
  });

  it("query_verified_bookings_by_campaign throws operator_db_aggregate_not_yet_implemented", async () => {
    await expect(
      drv.query_verified_bookings_by_campaign({ window_days: 7 }, cfg),
    ).rejects.toThrow(/not_yet_implemented|not implemented/);
  });
});
