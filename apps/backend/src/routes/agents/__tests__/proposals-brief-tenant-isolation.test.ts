
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ALL_OUTCOMES = [
  { tenant_id: TENANT_A, action_class: "meta_ads.set_status", decision_outcome: "approved", reconcile_status: "measured", delta_metrics: { spend_avoided_estimate: 100 } },
  { tenant_id: TENANT_A, action_class: "meta_ads.set_status", decision_outcome: "approved", reconcile_status: "measured", delta_metrics: { spend_avoided_estimate: 120 } },
  { tenant_id: TENANT_A, action_class: "meta_ads.set_status", decision_outcome: "approved", reconcile_status: "measured", delta_metrics: { spend_avoided_estimate: 90 } },
  { tenant_id: TENANT_B, action_class: "meta_ads.set_status", decision_outcome: "approved", reconcile_status: "measured", delta_metrics: { spend_avoided_estimate: 0 } },
  { tenant_id: TENANT_B, action_class: "meta_ads.set_status", decision_outcome: "approved", reconcile_status: "measured", delta_metrics: { spend_avoided_estimate: 0 } },
  { tenant_id: TENANT_B, action_class: "meta_ads.set_status", decision_outcome: "approved", reconcile_status: "measured", delta_metrics: { spend_avoided_estimate: 0 } },
];

function makeQuery() {
  const filters: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    },
    like: () => chain,
    limit: async () => {
      const tenant = filters.tenant_id;
      const data = ALL_OUTCOMES.filter(
        (o) => o.tenant_id === tenant && o.reconcile_status === "measured",
      ).map((o) => ({
        action_class: o.action_class,
        decision_outcome: o.decision_outcome,
        delta_metrics: o.delta_metrics,
      }));
      return { data, error: null };
    },
  };
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from: () => makeQuery() }),
  serverClientFromBearer: () => ({ from: () => makeQuery() }),
}));

vi.mock("@/services/tools/meta-ads/list_campaigns", () => ({
  metaListCampaignsTool: { execute: async () => ({ campaigns: [] }) },
}));

import { buildBriefs } from "../proposals";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildBriefs — cross-tenant isolation (E3)", () => {
  it("tenant A's track_record counts ONLY tenant A's measured outcomes", async () => {
    const briefs = await buildBriefs(TENANT_A, [
      { id: "d1", decision_class: "meta_ads.set_status", body: { status: "PAUSED" } },
    ]);
    const brief = briefs.get("d1");
    expect(brief).toBeTruthy();
    expect(brief!.track_record).not.toBeNull();
    expect(brief!.track_record!.n).toBe(3);
    expect(brief!.track_record!.right).toBe(3);
  });

  it("tenant B's track_record counts ONLY tenant B's measured outcomes (all wrong)", async () => {
    const briefs = await buildBriefs(TENANT_B, [
      { id: "d1", decision_class: "meta_ads.set_status", body: { status: "PAUSED" } },
    ]);
    const brief = briefs.get("d1");
    expect(brief!.track_record!.n).toBe(3);
    expect(brief!.track_record!.right).toBe(0);
  });

  it("a first-time tenant (no outcomes) → no track_record chip (no 0-of-0)", async () => {
    const briefs = await buildBriefs("cccccccc-cccc-4ccc-8ccc-cccccccccccc", [
      { id: "d1", decision_class: "meta_ads.set_status", body: { status: "PAUSED" } },
    ]);
    expect(briefs.get("d1")).toBeUndefined();
  });
});
