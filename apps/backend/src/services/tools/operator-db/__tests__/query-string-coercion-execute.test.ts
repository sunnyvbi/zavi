
import { describe, it, expect, vi, beforeEach } from "vitest";

const aggregateMock = vi.fn(async () => ({
  ok: true,
  data: { collection: "trips", row_count: 0, truncated: false, rows: [] },
}));
const queryCollectionMock = vi.fn();

vi.mock("@/services/data-gateway", () => ({
  withAttachedDriver: vi.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
    fn({
      driver: { aggregate: aggregateMock, query_collection: queryCollectionMock },
      cfg: {},
      access: {
        config: { type: "mongodb", schema_map: {} },
        catalog: { catalog: { tables: [{ name: "trips", columns: [], rowEstimate: 1 }] } },
      },
    }),
  ),
  loadDbAccess: vi.fn(),
  visibleCatalog: (c: unknown) => c,
}));

vi.mock("../catalog", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../catalog")>();
  return {
    ...orig,
    getCatalog: vi.fn(async () => ({
      dialect: "mongodb",
      catalog: { tables: [{ name: "trips", columns: [], rowEstimate: 1 }] },
      hints: {},
      discovery_error: null,
    })),
  };
});

import { operatorDbQueryTool } from "../tools";

const PROD_AGGREGATE_PIPELINE_STRING = `[
  {
    "$match": {
      "tripType": "subscription",
      "tripStartDate": {
        "$gte": {"$date": "2026-05-01T00:00:00.000Z"},
        "$lt": {"$date": "2026-08-01T00:00:00.000Z"}
      }
    }
  },
  {
    "$group": {
      "_id": {
        "year": {"$year": "$tripStartDate"},
        "month": {"$month": "$tripStartDate"}
      },
      "trip_count": {"$sum": 1}
    }
  }
]`;

const ctx = { tenant_id: "t1", log: () => undefined } as never;

describe("operator_db_query execute — stringified prod input", () => {
  beforeEach(() => {
    aggregateMock.mockClear();
  });

  it("passes parsed pipeline + BSON dates to aggregate()", async () => {
    const parsed = operatorDbQueryTool.input_schema.parse({
      collection: "trips",
      mode: "aggregate",
      pipeline: PROD_AGGREGATE_PIPELINE_STRING,
    });
    await operatorDbQueryTool.execute(ctx, parsed);

    expect(aggregateMock).toHaveBeenCalledTimes(1);
    const calls = aggregateMock.mock.calls as unknown as Array<
      [string, Record<string, unknown>[], ...unknown[]]
    >;
    const pipeline = calls[0][1];
    expect(Array.isArray(pipeline)).toBe(true);
    const match = (pipeline[0] as { $match: { tripStartDate: { $gte: Date } } }).$match;
    expect(match.tripStartDate.$gte).toBeInstanceOf(Date);
    expect(match.tripStartDate.$gte.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});
