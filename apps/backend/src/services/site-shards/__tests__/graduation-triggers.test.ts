import { describe, expect, it } from "vitest";
import { graduationTriggerSweep, sitesOverThreshold, type GraduationThresholds } from "../graduation-triggers";
import { APP_SETTINGS } from "@/services/settings/registry";

const S = "11111111-1111-4111-8111-111111111111";
const shard = { id: "x", name: "zavi-shard-dev-1", project_ref: "shardref", state: "open" };

function deps(t: GraduationThresholds, rows: unknown[]) {
  const alerts: string[] = [];
  const requested: Array<[string, string]> = [];
  const queries: string[] = [];
  return {
    alerts,
    requested,
    queries,
    d: {
      registry: { list: async () => [shard] as never },
      sql: { query: async (_r: string, q: string) => (queries.push(q), rows) },
      store: { requestBySite: async (s: string, r: "load" | "size") => (requested.push([s, r]), { site_id: s } as never) },
      thresholds: async () => t,
      alert: async (m: string) => void alerts.push(m),
    },
  };
}

describe("load / size graduation triggers", () => {
  it("thresholds come from settings (registry defaults), auto-move defaults OFF", () => {
    expect(APP_SETTINGS.site_graduation_auto.defaultValue).toBe(false);
    for (const k of ["site_graduation_records_threshold", "site_graduation_bytes_threshold", "site_graduation_writes_per_min_threshold", "site_graduation_grace_days"] as const) {
      expect(APP_SETTINGS[k].type).toBe("number");
    }
  });

  it("the metric query uses the thresholds it is given (no number in code)", async () => {
    const x = deps({ records: 1234, bytes: 5678, writes_per_min: 91, auto: false }, []);
    await sitesOverThreshold(x.d.sql as never, "shardref", { records: 1234, bytes: 5678, writes_per_min: 91, auto: false });
    expect(x.queries[0]).toMatch(/u\.records >= 1234 or u\.bytes >= 5678/);
    expect(x.queries[0]).toMatch(/u\.window_writes >= 91/);
    expect(x.queries[0]).toMatch(/s\.status = 'active'/);
    await expect(sitesOverThreshold(x.d.sql as never, "r", { records: 0, bytes: 1, writes_per_min: 1, auto: false })).rejects.toThrow();
  });

  it("auto OFF: alerts only, never requests a move", async () => {
    const x = deps({ records: 10, bytes: 10, writes_per_min: 10, auto: false }, [{ site_id: S, records: 50, bytes: 1, writes_per_min: 0 }]);
    expect(await graduationTriggerSweep(x.d as never, "dev")).toEqual({ over: 1, requested: 0, failed: 0 });
    expect(x.requested).toEqual([]);
    expect(x.alerts[0]).toMatch(/past its graduation threshold \(size: records=50.*automatic move is off/);
  });

  it("auto ON: requests the graduation (load vs size) and alerts", async () => {
    const x = deps({ records: 100, bytes: 100, writes_per_min: 10, auto: true }, [{ site_id: S, records: 1, bytes: 1, writes_per_min: 50 }]);
    expect(await graduationTriggerSweep(x.d as never, "dev")).toEqual({ over: 1, requested: 1, failed: 0 });
    expect(x.requested).toEqual([[S, "load"]]);
    expect(x.alerts[0]).toMatch(/graduation requested/);
  });
});
