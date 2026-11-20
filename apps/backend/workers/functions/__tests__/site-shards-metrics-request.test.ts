import { describe, expect, it, vi } from "vitest";

vi.mock("../../client", () => ({ inngest: { createFunction: (_o: unknown, triggers: unknown, handler: unknown) => ({ triggers, handler }), send: vi.fn() } }));
vi.mock("@/services/site-shards/registry", () => ({ shardEnv: () => "dev" }));
vi.mock("@/services/site-shards/metrics", () => ({ runShardMetricsSweep: vi.fn() }));

import { requestShardMetricsSweep, siteShardsMetricsFn, SITE_SHARDS_METRICS_REQUESTED } from "../site-shards-metrics";

describe("site-shards-metrics on demand", () => {
  it("runs on its cron AND on the request event", () => {
    expect((siteShardsMetricsFn as unknown as { triggers: unknown }).triggers).toEqual([
      { cron: "*/10 * * * *" },
      { event: SITE_SHARDS_METRICS_REQUESTED },
    ]);
  });

  it("a request for another fleet's env is ignored; the cron and a matching request sweep", async () => {
    const fn = siteShardsMetricsFn as unknown as { handler: (ctx: unknown) => Promise<unknown> };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const { runShardMetricsSweep } = await import("@/services/site-shards/metrics");
    const sweep = runShardMetricsSweep as unknown as ReturnType<typeof vi.fn>;
    sweep.mockResolvedValue({ env: "dev", measured: 0, failed: 0, sources: {}, stale: [], over: [] });
    expect(await fn.handler({ event: { name: SITE_SHARDS_METRICS_REQUESTED, data: { env: "prod" } }, logger })).toEqual({ skipped: "other_env" });
    expect(sweep).not.toHaveBeenCalled();
    await fn.handler({ event: { name: SITE_SHARDS_METRICS_REQUESTED, data: { env: "dev" } }, logger });
    await fn.handler({ event: { name: "inngest/scheduled.timer", data: {} }, logger });
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("dedupes requests per env per minute (event id), and carries no tenant data", async () => {
    const send = vi.fn(async () => undefined);
    const t = 1_700_000_000_000;
    await requestShardMetricsSweep({ env: "prod", reason: "readiness_stale" }, send, () => t);
    await requestShardMetricsSweep({ env: "prod", reason: "boot" }, send, () => t + 30_000);
    await requestShardMetricsSweep({ env: "prod", reason: "boot" }, send, () => t + 61_000);
    const ids = send.mock.calls.map((c) => (c as unknown as [{ id: string }])[0].id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect((send.mock.calls[0] as unknown as [{ name: string; data: unknown }])[0]).toMatchObject({
      name: SITE_SHARDS_METRICS_REQUESTED,
      data: { env: "prod", reason: "readiness_stale" },
    });
  });
});
