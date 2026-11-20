import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ resolve: vi.fn(), close: vi.fn(async () => undefined) }));
vi.mock("@/services/data-gateway", () => ({ resolveAttachedDb: h.resolve }));

import { rerunBaselineMetric } from "../roadmap-metric";

describe("pm baseline re-run through the gateway", () => {
  it("uses an agent caller with the run id and closes", async () => {
    const driver = {
      query_funnel_by_geo_category: vi.fn(async () => ({ ok: true, data: { rows: [], truncated: false, total_segments_seen: 0 } })),
      query_active_supply_by_geo_category: vi.fn(),
    };
    h.resolve.mockResolvedValue({ driver, cfg: {}, close: h.close });
    await rerunBaselineMetric({ tenant_id: "t1", runId: "run-7", agent: { slug: "pm" } } as never, "query_funnel_by_geo_category");
    expect(h.resolve).toHaveBeenCalledWith({
      tenant_id: "t1",
      caller: { kind: "agent", agent_slug: "pm", run_id: "run-7", tool_name: "operator_db__query_funnel_by_geo_category" },
    });
    expect(driver.query_funnel_by_geo_category).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
  });
});
