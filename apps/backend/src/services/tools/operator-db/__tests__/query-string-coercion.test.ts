
import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { operatorDbQueryTool } from "../tools";
import {
  coerceMongoExtendedJson,
  coerceOperatorDbQueryInput,
} from "../query-input-coerce";

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
      "trip_count": {"$sum": 1},
      "total_trip_days": {"$sum": "$tripDays"}
    }
  },
  {
    "$sort": {"_id.year": 1, "_id.month": 1}
  }
]`;

describe("operator_db_query stringified JSON coercion", () => {
  it("coerces stringified aggregate pipeline from prod run 6b6c6eb8", () => {
    const parsed = operatorDbQueryTool.input_schema.parse({
      collection: "trips",
      mode: "aggregate",
      pipeline: PROD_AGGREGATE_PIPELINE_STRING,
    }) as {
      collection: string;
      mode: string;
      pipeline: Record<string, unknown>[];
    };
    expect(parsed.mode).toBe("aggregate");
    expect(Array.isArray(parsed.pipeline)).toBe(true);
    expect(parsed.pipeline).toHaveLength(3);
    expect(parsed.pipeline[0]).toHaveProperty("$match");
    const match = (parsed.pipeline[0] as { $match: Record<string, unknown> }).$match;
    expect(match.tripType).toBe("subscription");
  });

  it("coerces stringified find filter + string limit from prod run 6b6c6eb8", () => {
    const parsed = operatorDbQueryTool.input_schema.parse({
      collection: "trips",
      mode: "find",
      filter: '{"tripType": "subscription"}',
      limit: "2",
    }) as {
      filter: Record<string, unknown>;
      limit: number;
    };
    expect(parsed.filter).toEqual({ tripType: "subscription" });
    expect(parsed.limit).toBe(2);
  });

  it("still rejects non-JSON strings for filter/pipeline", () => {
    expect(() =>
      operatorDbQueryTool.input_schema.parse({
        collection: "trips",
        mode: "find",
        filter: "not-an-object",
      }),
    ).toThrow();
    expect(() =>
      operatorDbQueryTool.input_schema.parse({
        collection: "trips",
        mode: "aggregate",
        pipeline: "not-an-array",
      }),
    ).toThrow();
  });

  it("coerces skip from numeric string", () => {
    const parsed = operatorDbQueryTool.input_schema.parse({
      collection: "trips",
      mode: "find",
      skip: "10",
    }) as { skip: number };
    expect(parsed.skip).toBe(10);
  });
});

describe("coerceMongoExtendedJson", () => {
  it("converts {$date: iso} wrappers to Date", () => {
    const out = coerceMongoExtendedJson({
      tripStartDate: {
        $gte: { $date: "2026-05-01T00:00:00.000Z" },
        $lt: { $date: "2026-08-01T00:00:00.000Z" },
      },
    }) as {
      tripStartDate: { $gte: Date; $lt: Date };
    };
    expect(out.tripStartDate.$gte).toBeInstanceOf(Date);
    expect(out.tripStartDate.$gte.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(out.tripStartDate.$lt).toBeInstanceOf(Date);
  });

  it("converts {$oid: hex} wrappers to ObjectId", () => {
    const hex = "507f1f77bcf86cd799439011";
    const out = coerceMongoExtendedJson({ _id: { $oid: hex } }) as { _id: ObjectId };
    expect(out._id).toBeInstanceOf(ObjectId);
    expect(out._id.toHexString()).toBe(hex);
  });

  it("leaves nested Mongo null query syntax untouched", () => {
    expect(coerceMongoExtendedJson({ status: null })).toEqual({ status: null });
  });
});

describe("coerceOperatorDbQueryInput composes with null stripping", () => {
  it("strips nulls then coerces stringified fields", () => {
    const out = coerceOperatorDbQueryInput({
      collection: "trips",
      mode: "find",
      filter: null,
      limit: "5",
    }) as Record<string, unknown>;
    expect("filter" in out).toBe(false);
    expect(out.limit).toBe(5);
  });
});
