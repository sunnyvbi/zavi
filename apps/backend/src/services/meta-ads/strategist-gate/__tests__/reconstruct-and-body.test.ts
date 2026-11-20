import { describe, it, expect } from "vitest";
import { reconstructCreateBody, buildVerdictAnnotation } from "../reconstruct";
import {
  buildPendingStrategistBody,
  isPendingStrategistBody,
  pendingStrategistBodySchema,
} from "../pending-body";
import { estimateUsdFromDecisionBody } from "../../../../../workers/functions/dispatch-decision";

const CREATE = {
  campaign_id: "camp_1",
  name: "San Juan expansion",
  daily_budget_usd: 40,
  optimization_goal: "OFFSITE_CONVERSIONS",
  billing_event: "IMPRESSIONS",
  targeting: { geo: "PR" },
  rationale: "expand",
  promoted_object: { pixel_id: "1234567890", custom_event_type: "COMPLETE_REGISTRATION" },
};

describe("reconstructCreateBody — trust boundary", () => {
  it("returns only the whitelisted create fields, stripping hostile extras", () => {
    const parked = {
      kind: "create_ad_set_pending_strategist",
      create_ad_set: { ...CREATE, evil: 1, __proto__hack: true, approved_by: "x" },
    };
    const body = reconstructCreateBody(parked);
    expect(body).not.toBeNull();
    expect(Object.keys(body!).sort()).toEqual(
      [
        "billing_event",
        "campaign_id",
        "daily_budget_usd",
        "name",
        "optimization_goal",
        "promoted_object",
        "rationale",
        "targeting",
      ].sort(),
    );
    expect((body as Record<string, unknown>).evil).toBeUndefined();
    expect((body as Record<string, unknown>).approved_by).toBeUndefined();
  });

  it("returns null for a missing/invalid nested payload", () => {
    expect(reconstructCreateBody(null)).toBeNull();
    expect(reconstructCreateBody({})).toBeNull();
    expect(reconstructCreateBody({ create_ad_set: { campaign_id: "" } })).toBeNull();
  });

  it("bounds the verdict reason to 500 chars", () => {
    const ann = buildVerdictAnnotation("x".repeat(2000));
    expect(ann.reason.length).toBe(500);
    expect(ann.verdict).toBe("approve");
  });
});

describe("pending body — P1-6 spend-cap exemption", () => {
  it("nests the create so estimateUsdFromDecisionBody sees $0 (no stranded hidden row)", () => {
    const pending = buildPendingStrategistBody(CREATE);
    expect(estimateUsdFromDecisionBody(pending)).toBe(0);
  });

  it("a RAW create body (root budget) would be charged — proving the nesting is what exempts it", () => {
    expect(estimateUsdFromDecisionBody(CREATE)).toBe(40);
  });

  it("isPendingStrategistBody discriminates the parked kind", () => {
    expect(isPendingStrategistBody(buildPendingStrategistBody(CREATE))).toBe(true);
    expect(isPendingStrategistBody(CREATE)).toBe(false);
  });

  it("the pending body validates against its schema and round-trips the create", () => {
    const pending = buildPendingStrategistBody(CREATE, { promoted_event: "PR_Lead", cold_event: true });
    const parsed = pendingStrategistBodySchema.safeParse(pending);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.create_ad_set.campaign_id).toBe("camp_1");
    expect(parsed.success && parsed.data.cold_event).toBe(true);
  });
});
