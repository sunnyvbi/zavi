import { beforeEach, describe, expect, it, vi } from "vitest";

const getGeoMetrics = vi.hoisted(() => vi.fn());
const listPrompts = vi.hoisted(() => vi.fn());
vi.mock("@/services/tools/growth/geo/panel", () => ({ getGeoMetrics }));
vi.mock("@/services/tools/growth/geo/visibility/prompts", () => ({ listPrompts }));

import { build } from "./geo";
import type { DashboardContext } from "./_contract";

const ctx = (over: Partial<DashboardContext>): DashboardContext =>
  ({ tenantId: "t1", refresh: false, meteredRefresh: false, rangeDays: 30, requestedDays: 30, ...over }) as DashboardContext;

describe("geo dashboard builder", () => {
  beforeEach(() => {
    getGeoMetrics.mockReset().mockResolvedValue({ readiness: null, visibility: { error: true }, crawler_hits: { error: true } });
    listPrompts.mockReset().mockResolvedValue({ active: [], suggested: [] });
  });

  it("serves the 90-day window the route's 7/14/30 clamp drops", async () => {
    await build(ctx({ rangeDays: null, requestedDays: 90 }));
    expect(getGeoMetrics).toHaveBeenCalledWith("t1", expect.objectContaining({ days: 90 }));
  });

  it("does not re-crawl the site on a silent refresh, only on a human one", async () => {
    await build(ctx({ refresh: true, meteredRefresh: false }));
    expect(getGeoMetrics).toHaveBeenLastCalledWith("t1", expect.objectContaining({ refresh: false }));
    await build(ctx({ refresh: true, meteredRefresh: true }));
    expect(getGeoMetrics).toHaveBeenLastCalledWith("t1", expect.objectContaining({ refresh: true }));
  });
});
