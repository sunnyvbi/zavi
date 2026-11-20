import { beforeEach, describe, expect, it } from "vitest";
import { clearJwksCache } from "../jwt";
import { clearAnonCache, handleWithMetrics, type AnalyticsEngineLike } from "../worker";
import { HOST_A, NOW, REF, SITE_A, harness, req } from "./helpers";

beforeEach(() => {
  clearJwksCache();
  clearAnonCache();
});

function dataset(throws = false): AnalyticsEngineLike & { points: Array<Parameters<AnalyticsEngineLike["writeDataPoint"]>[0]> } {
  const points: Array<Parameters<AnalyticsEngineLike["writeDataPoint"]>[0]> = [];
  return {
    points,
    writeDataPoint(p) {
      if (throws) throw new Error("dataset down");
      points.push(p);
    },
  };
}

function clock() {
  let t = NOW;
  return () => (t += 7);
}

describe("gateway shard metrics", () => {
  it("one data point per resolved request: shard ref index, status class, site, total + shard-side ms", async () => {
    const ds = dataset();
    const h = await harness({ env: { SHARD_METRICS: ds } });
    const res = await handleWithMetrics(req(HOST_A, "/api/data/products"), h.env, { now: clock(), fetch: h.fetch });
    expect(res.status).toBe(200);
    expect(ds.points).toHaveLength(1);
    const p = ds.points[0];
    expect(p.indexes).toEqual([REF]);
    expect(p.blobs).toEqual([REF, "2xx", SITE_A]);
    const [total, upstream, calls] = p.doubles as number[];
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(upstream).toBeGreaterThan(0);
    expect(total).toBeGreaterThanOrEqual(upstream);
  });

  it("an error response is recorded with its class", async () => {
    const ds = dataset();
    const h = await harness({ env: { SHARD_METRICS: ds } });
    h.setResponse(() => new Response("boom", { status: 500 }));
    await handleWithMetrics(req(HOST_A, "/api/data/products"), h.env, { now: clock(), fetch: h.fetch });
    expect(ds.points[0].blobs?.[1]).toMatch(/^[45]xx$/);
  });

  it("an unknown hostname (no site, no shard) writes nothing", async () => {
    const ds = dataset();
    const h = await harness({ env: { SHARD_METRICS: ds } });
    const res = await handleWithMetrics(req("nope.zaviagent.com", "/api/data/products"), h.env, { now: clock(), fetch: h.fetch });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(ds.points).toEqual([]);
  });

  it("a failing dataset never fails the request; no binding = no metrics, same response", async () => {
    const h = await harness({ env: { SHARD_METRICS: dataset(true) } });
    expect((await handleWithMetrics(req(HOST_A, "/api/data/products"), h.env, { now: clock(), fetch: h.fetch })).status).toBe(200);
    const bare = await harness();
    expect((await handleWithMetrics(req(HOST_A, "/api/data/products"), bare.env, { now: clock(), fetch: bare.fetch })).status).toBe(200);
  });
});
