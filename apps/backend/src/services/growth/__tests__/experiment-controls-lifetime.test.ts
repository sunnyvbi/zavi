import { describe, expect, it } from "vitest";
import { experimentScope, assessExperiment } from "@/services/growth/experiment-controls";

const obj = { platform: "chatgpt", account_id: "a", object_id: "cmpn_1", level: "campaign", campaign_id: null, name: "t", budget_kind: "lifetime", budget_usd: 58, status: "active", currency: "USD", as_of: new Date().toISOString() } as const;

describe("experiments on a ChatGPT lifetime campaign", () => {
  it("registration scope accepts a ChatGPT lifetime campaign", () => expect(experimentScope(obj as never, [obj as never])).toEqual([obj]));
  it("a lifetime cap within the test budget: exposure = spend, no early stop", () => {
    const e = { budget_usd: 58, ends_at: new Date(Date.now() + 86_400_000).toISOString(), state: "monitoring", stop_requested_at: null, reason: null } as never;
    const r = assessExperiment(e, obj as never, 10, { reporting_delay_hours: 3 } as never, new Date());
    expect(r.stop).toBe(false);
    expect(r.exposure_usd).toBe(10);
  });
  it("a lifetime cap above the test budget keeps the daily-rate exposure", () => {
    const e = { budget_usd: 40, ends_at: new Date(Date.now() + 86_400_000).toISOString(), state: "monitoring", stop_requested_at: null, reason: null } as never;
    const r = assessExperiment(e, obj as never, 10, { reporting_delay_hours: 3 } as never, new Date());
    expect(r.exposure_usd).toBeGreaterThan(10);
  });
  it("Meta lifetime stays refused", () => expect(() => experimentScope({ ...obj, platform: "meta" } as never, [])).toThrow(/lifetime/));
});
