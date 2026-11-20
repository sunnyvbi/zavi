
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PENDING_STRATEGIST_CLASS,
  FINAL_CREATE_CLASS,
} from "@/services/meta-ads/strategist-gate/constants";
import { createAdSetBodySchema } from "../_decision-bodies";

vi.mock("../_ad-set-bid", () => ({ resolveCreateAdSetBid: async (_t: string, d: unknown) => d }));
vi.mock("../_flag-check", () => ({
  isMetaAdsWriteEnabled: vi.fn(async () => true),
}));
vi.mock("../cap-reader", () => { const m = ({
  readTenantCapAndToday: vi.fn(async () => ({ cap: null, today_total_change_usd: 0, currency: "USD", units_per_usd: 1 })),
}); return { ...m, readTenantCapRowAndToday: m.readTenantCapAndToday }; });

import { metaProposeNewAdSetTool } from "../propose_new_ad_set";
import type { ToolContext } from "@/services/tools/types";

type Emitted = { class: string; body: unknown };

function makeCtx() {
  const emitted: Emitted[] = [];
  const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const ctx: ToolContext = {
    tenant_id: "tenant-1",
    log: (msg, meta) => logs.push({ msg, meta }),
    emit_decision: vi.fn(async (decision_class: string, body: unknown) => {
      emitted.push({ class: decision_class, body });
      return `decision-${emitted.length}`;
    }),
  };
  return { ctx, emitted, logs };
}

const VALID_INPUT = {
  campaign_id: "camp-123",
  name: "Prospecting — CA drivers",
  daily_budget_usd: 50,
  optimization_goal: "OFFSITE_CONVERSIONS",
  promoted_object: { pixel_id: "1234567890", custom_event_type: "COMPLETE_REGISTRATION" },
  billing_event: "IMPRESSIONS",
  targeting: { geo_locations: { regions: [{ key: "3847" }] } },
  rationale: "Cold prospecting test in CA.",
  promoted_event: "PR_Lead",
};

describe("propose_new_ad_set — goes straight to approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits the RAW meta_ads.create_ad_set, never the parked class", async () => {
    const { ctx, emitted } = makeCtx();
    const res = (await metaProposeNewAdSetTool.execute(ctx, VALID_INPUT)) as {
      decision_class: string;
    };
    expect(emitted).toHaveLength(1);
    expect(emitted[0].class).toBe(FINAL_CREATE_CLASS);
    expect(emitted[0].class).not.toBe(PENDING_STRATEGIST_CLASS);
    expect(res.decision_class).toBe(FINAL_CREATE_CLASS);
    expect(createAdSetBodySchema.safeParse(emitted[0].body).success).toBe(true);
    expect((emitted[0].body as { kind?: string }).kind).toBeUndefined();
    expect((emitted[0].body as { promoted_event?: string }).promoted_event).toBeUndefined();
  });

  it("dry_run previews with NO emit", async () => {
    const { ctx, emitted } = makeCtx();
    const res = (await metaProposeNewAdSetTool.execute(ctx, {
      ...VALID_INPUT,
      dry_run: true,
    })) as { dry_run: boolean };
    expect(res.dry_run).toBe(true);
    expect(emitted).toHaveLength(0);
  });
});
