import { describe, it, expect } from "vitest";
import {
  validateFind,
  validateAggregate,
  pipelineHasLimit,
  MAX_PIPELINE_STAGES,
  MAX_ROWS_PER_READ,
  MAX_SKIP,
  type ValidationContext,
} from "../mongo-read-grammar";

const ctx: ValidationContext = {
  allowedCollections: new Set(["users", "listings", "bookings"]),
};

describe("mongo-read-grammar · validateFind", () => {
  it("accepts a simple equality filter", () => {
    expect(validateFind({ status: "active" }).ok).toBe(true);
  });
  it("accepts an empty / omitted filter (all docs, row-capped)", () => {
    expect(validateFind({}).ok).toBe(true);
    expect(validateFind(undefined).ok).toBe(true);
  });
  it("accepts nested $and / $or / $in within bounds", () => {
    expect(
      validateFind({
        $or: [{ status: "active" }, { tier: { $in: ["a", "b"] } }],
      }).ok,
    ).toBe(true);
  });
  it("rejects a non-object filter", () => {
    expect(validateFind([] as unknown).ok).toBe(false);
    expect(validateFind("x" as unknown).ok).toBe(false);
  });

  for (const banned of ["$where", "$function", "$accumulator", "$expr"]) {
    it(`rejects ${banned} in a find filter`, () => {
      const r = validateFind({ [banned]: "anything" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/banned_operator/);
    });
  }

  it("rejects an oversized $in array", () => {
    const huge = Array.from({ length: 2000 }, (_, i) => i);
    const r = validateFind({ id: { $in: huge } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/in_too_large/);
  });
  it("rejects too many $or branches", () => {
    const many = Array.from({ length: 100 }, () => ({ a: 1 }));
    const r = validateFind({ $or: many });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/branches_too_many/);
  });
  it("rejects an over-long $regex", () => {
    const r = validateFind({ name: { $regex: "x".repeat(1000) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/regex_too_long/);
  });
});

describe("mongo-read-grammar · validateAggregate allow/reject matrix", () => {
  it("accepts a valid $match → $group → $sort → $limit pipeline", () => {
    const r = validateAggregate(
      [
        { $match: { status: "active" } },
        { $group: { _id: "$city", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 10 },
      ],
      ctx,
    );
    expect(r.ok).toBe(true);
  });

  for (const banned of [
    "$out",
    "$merge",
    "$function",
    "$accumulator",
    "$where",
    "$graphLookup",
    "$unionWith",
    "$expr",
  ]) {
    it(`rejects ${banned} anywhere in a pipeline`, () => {
      const r = validateAggregate([{ $match: { [banned]: 1 } }], ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/banned/);
    });
  }

  it("rejects $out as a stage", () => {
    const r = validateAggregate([{ $out: "evil" }], ctx);
    expect(r.ok).toBe(false);
  });
  it("rejects $merge as a stage", () => {
    const r = validateAggregate([{ $merge: { into: "evil" } }], ctx);
    expect(r.ok).toBe(false);
  });

  it("rejects a mapReduce-style unknown $weird operator", () => {
    const r = validateAggregate([{ $weird: { x: 1 } }], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown_stage/);
  });

  it("rejects a $where smuggled into a $match", () => {
    const r = validateAggregate([{ $match: { $where: "this.x>1" } }], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/banned_operator/);
  });

  it("accepts a $lookup into an allowlisted collection", () => {
    const r = validateAggregate(
      [{ $lookup: { from: "listings", localField: "lid", foreignField: "_id", as: "l" } }],
      ctx,
    );
    expect(r.ok).toBe(true);
  });
  it("rejects a $lookup into a NON-allowlisted collection", () => {
    const r = validateAggregate(
      [{ $lookup: { from: "secrets_collection", localField: "x", foreignField: "_id", as: "s" } }],
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/lookup_not_allowlisted/);
  });

  it("rejects a banned op nested inside a $lookup.pipeline", () => {
    const r = validateAggregate(
      [
        {
          $lookup: {
            from: "listings",
            as: "l",
            pipeline: [{ $out: "evil" }],
          },
        },
      ],
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/banned/);
  });

  it("rejects a banned op nested inside a $facet sub-pipeline", () => {
    const r = validateAggregate(
      [
        {
          $facet: {
            a: [{ $match: { x: 1 } }],
            b: [{ $merge: { into: "evil" } }],
          },
        },
      ],
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/banned/);
  });

  it("rejects a pipeline with too many stages", () => {
    const pipe = Array.from({ length: MAX_PIPELINE_STAGES + 1 }, () => ({
      $match: { x: 1 },
    }));
    const r = validateAggregate(pipe, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too_many_stages/);
  });

  it("rejects a stage with more than one operator key", () => {
    const r = validateAggregate([{ $match: { x: 1 }, $limit: 5 } as unknown], ctx);
    expect(r.ok).toBe(false);
  });

  it("rejects a non-array pipeline", () => {
    const r = validateAggregate({ $match: {} } as unknown, ctx);
    expect(r.ok).toBe(false);
  });
});

describe("mongo-read-grammar · pipelineHasLimit (driver injects $limit + caps)", () => {
  it("detects an explicit $limit", () => {
    expect(pipelineHasLimit([{ $match: {} }, { $limit: 5 }])).toBe(true);
  });
  it("returns false when no $limit present (driver will inject one)", () => {
    expect(pipelineHasLimit([{ $match: {} }, { $group: { _id: "$x" } }])).toBe(false);
  });
});

describe("mongo-read-grammar · numeric-cap stages (P1 DoS — explicit values must be bounded)", () => {
  it("accepts a $limit within the row cap", () => {
    expect(validateAggregate([{ $limit: 100 }], ctx).ok).toBe(true);
    expect(validateAggregate([{ $limit: MAX_ROWS_PER_READ }], ctx).ok).toBe(true);
  });
  it("rejects $limit: 1e9 (DoS)", () => {
    const r = validateAggregate([{ $match: { x: 1 } }, { $limit: 1e9 }], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/limit_too_large/);
  });
  it("rejects $limit just over the row cap", () => {
    const r = validateAggregate([{ $limit: MAX_ROWS_PER_READ + 1 }], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/limit_too_large/);
  });
  it("rejects a negative $limit", () => {
    const r = validateAggregate([{ $limit: -5 }], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bad_limit/);
  });
  it("rejects a non-numeric $limit", () => {
    const r = validateAggregate([{ $limit: "5" as unknown }], ctx);
    expect(r.ok).toBe(false);
  });

  it("accepts a $skip within bounds", () => {
    expect(validateAggregate([{ $skip: 100 }], ctx).ok).toBe(true);
  });
  it("rejects a negative $skip", () => {
    const r = validateAggregate([{ $skip: -1 }], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bad_skip/);
  });
  it("rejects an absurdly large $skip", () => {
    const r = validateAggregate([{ $skip: MAX_SKIP + 1 }], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/skip_too_large/);
  });

  it("accepts a $sample size within the row cap", () => {
    expect(validateAggregate([{ $sample: { size: 50 } }], ctx).ok).toBe(true);
  });
  it("rejects $sample:{size:1e9} (DoS)", () => {
    const r = validateAggregate([{ $sample: { size: 1e9 } }], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/sample_too_large/);
  });
  it("rejects a negative $sample size", () => {
    const r = validateAggregate([{ $sample: { size: -1 } }], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bad_sample/);
  });
  it("rejects a malformed $sample (no size object)", () => {
    const r = validateAggregate([{ $sample: 50 as unknown }], ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bad_sample/);
  });
});
