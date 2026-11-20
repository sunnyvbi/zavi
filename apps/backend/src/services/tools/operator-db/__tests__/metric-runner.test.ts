import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/mcp/internal/operator-db", () => ({ callOperatorDbTool: vi.fn() }));
import { makeMongoRunner } from "../metric-runner";
import { callOperatorDbTool } from "@/services/mcp/internal/operator-db";

const callOpDb = callOperatorDbTool as unknown as ReturnType<typeof vi.fn>;

function envelope(rows: unknown[], truncated = false) {
  return { ok: true, is_error: false, content: JSON.stringify({ ok: true, data: { rows, truncated } }), ms: 1 };
}

function router(cfg: {
  srcColl: string; tgtColl: string;
  srcTypes: string[]; tgtTypes: string[];
  srcVals: string[]; tgtVals: string[];
  srcTruncated?: boolean; tgtTruncated?: boolean;
}) {
  return async (_t: string, _tool: string, args: { collection: string; pipeline: any[] }) => {
    const groupStage = args.pipeline.find((s) => s.$group)?.$group?._id;
    const isType = groupStage && typeof groupStage === "object" && "$type" in groupStage;
    const isConvert = groupStage && typeof groupStage === "object" && "$convert" in groupStage;
    const isSrc = args.collection === cfg.srcColl;
    if (isType) {
      const types = isSrc ? cfg.srcTypes : cfg.tgtTypes;
      return envelope(types.map((t) => ({ _id: t })));
    }
    if (isConvert) {
      const vals = isSrc ? cfg.srcVals : cfg.tgtVals;
      const trunc = isSrc ? cfg.srcTruncated : cfg.tgtTruncated;
      return envelope(vals.map((v) => ({ _id: v })), Boolean(trunc));
    }
    return envelope([{ n: 0 }]);
  };
}

describe("distinctJoinMatched — type-agnostic join", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("matches String refs against ObjectId ids after normalization (the real bug)", async () => {
    callOpDb.mockImplementation(router({
      srcColl: "trips", tgtColl: "carlistings",
      srcTypes: ["string"], tgtTypes: ["objectId"],
      srcVals: ["a1", "b2", "c3"],
      tgtVals: ["a1", "b2", "zz"],
    }));
    const r = makeMongoRunner("t");
    const out = await r.distinctJoinMatched("trips", "carId", "carlistings", "_id", { createdAt: { $gte: 1 } });
    expect(out.unavailable).toBeFalsy();
    expect(out.attempted).toBe(3);
    expect(out.matched).toBe(2);
  });

  it("abstains (unavailable) when a field carries a non-scalar-id type (e.g. array/date)", async () => {
    callOpDb.mockImplementation(router({
      srcColl: "trips", tgtColl: "carlistings",
      srcTypes: ["array"], tgtTypes: ["objectId"],
      srcVals: [], tgtVals: [],
    }));
    const r = makeMongoRunner("t");
    const out = await r.distinctJoinMatched("trips", "carId", "carlistings", "_id");
    expect(out.unavailable).toBe(true);
    expect(out.matched).toBe(0);
  });

  it("abstains (unavailable) when a distinct read truncates (>row cap)", async () => {
    callOpDb.mockImplementation(router({
      srcColl: "trips", tgtColl: "carlistings",
      srcTypes: ["string"], tgtTypes: ["objectId"],
      srcVals: ["a1"], tgtVals: ["a1"],
      tgtTruncated: true,
    }));
    const r = makeMongoRunner("t");
    const out = await r.distinctJoinMatched("trips", "carId", "carlistings", "_id");
    expect(out.unavailable).toBe(true);
  });

  it("abstains when join keys are PII-redacted (distinct ids collapse to a marker)", async () => {
    callOpDb.mockImplementation(router({
      srcColl: "trips", tgtColl: "carlistings",
      srcTypes: ["string"], tgtTypes: ["string"],
      srcVals: ["‹redacted:email›", "‹redacted:email›"],
      tgtVals: ["‹redacted:email›"],
    }));
    const r = makeMongoRunner("t");
    const out = await r.distinctJoinMatched("trips", "ownerEmailId", "carlistings", "ownerEmailId");
    expect(out.unavailable).toBe(true);
  });

  it("counts blank/null refs toward attempted (unmatched) so coverage still runs", async () => {
    callOpDb.mockImplementation(router({
      srcColl: "trips", tgtColl: "carlistings",
      srcTypes: ["string"], tgtTypes: ["objectId"],
      srcVals: ["a1", "", "b2"],
      tgtVals: ["a1"],
    }));
    const r = makeMongoRunner("t");
    const out = await r.distinctJoinMatched("trips", "carId", "carlistings", "_id");
    expect(out.unavailable).toBeFalsy();
    expect(out.attempted).toBe(3);
    expect(out.matched).toBe(1);
  });

  it("abstains when a redaction marker is EMBEDDED mid-string (not just prefix)", async () => {
    callOpDb.mockImplementation(router({
      srcColl: "trips", tgtColl: "carlistings",
      srcTypes: ["string"], tgtTypes: ["string"],
      srcVals: ["acct:‹redacted:email›", "acct2:‹redacted:email›"],
      tgtVals: ["acct:‹redacted:email›"],
    }));
    const r = makeMongoRunner("t");
    const out = await r.distinctJoinMatched("trips", "ownerRef", "carlistings", "ownerRef");
    expect(out.unavailable).toBe(true);
  });

  it("zero source keys → {0,0} WITHOUT scanning the target (large-tenant all-idle path)", async () => {
    const calls: { coll: string; convert: boolean }[] = [];
    callOpDb.mockImplementation(async (_t: string, _tool: string, args: { collection: string; pipeline: any[] }) => {
      const g = args.pipeline.find((s) => s.$group)?.$group?._id;
      const convert = g && typeof g === "object" && "$convert" in g;
      calls.push({ coll: args.collection, convert: Boolean(convert) });
      if (g && typeof g === "object" && "$type" in g) return envelope([{ _id: args.collection === "trips" ? "string" : "objectId" }]);
      if (convert) return envelope(args.collection === "trips" ? [] : [{ _id: "x" }]);
      return envelope([{ n: 0 }]);
    });
    const r = makeMongoRunner("t");
    const out = await r.distinctJoinMatched("trips", "carId", "carlistings", "_id", { createdAt: { $gte: 1 } });
    expect(out.unavailable).toBeFalsy();
    expect(out).toMatchObject({ matched: 0, attempted: 0 });
    expect(calls.some((c) => c.coll === "carlistings" && c.convert)).toBe(false);
  });

  it("abstains on numeric (int/long) id types — $convert+redactor would corrupt them (codex R4)", async () => {
    callOpDb.mockImplementation(router({
      srcColl: "orders", tgtColl: "products",
      srcTypes: ["long"], tgtTypes: ["long"],
      srcVals: ["12345678901", "22345678901"], tgtVals: ["22345678901"],
    }));
    const r = makeMongoRunner("t");
    const out = await r.distinctJoinMatched("orders", "product_id", "products", "id");
    expect(out.unavailable).toBe(true);
  });
});
