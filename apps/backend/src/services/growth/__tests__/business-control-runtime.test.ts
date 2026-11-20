import { beforeEach, describe, it, expect, vi } from "vitest";
import { BUSINESS_CONTROL_DEFAULTS } from "../business-control-policy";
import type { AdObject } from "../ad-spend-controller";
import type { UnattendedAction } from "../unattended-policy";
import {
  checkBusinessControl,
  monitorExperiments,
  readBusinessInventory,
} from "../business-control-runtime";
const now = new Date("2026-10-09T12:00:00Z");
let policy: Record<string, unknown> | null;
let rows: Record<string, any[]>;
let objects: AdObject[];
let tracking = true;
let googleInv: Record<string, unknown> = { objects: [] };
const submit = vi.fn(),
  rpc = vi.fn();
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantRpc: (...a: unknown[]) => rpc(...a),
  tenantClient: () => ({
    from: (table: string) => {
      const q: any = {};
      for (const method of ["select", "eq", "gte", "in", "or", "order", "lte"])
        q[method] = () => q;
      q.maybeSingle = async () => ({
        data:
          table === "growth_business_policies" && policy
            ? { policy, revision: 1, updated_at: now.toISOString() }
            : null,
        error: null,
      });
      q.limit = async () => ({ data: rows[table] ?? [], error: null });
      q.range = async () => ({ data: rows[table] ?? [], error: null });
      return q;
    },
  }),
}));
vi.mock("../ad-spend-controller", async (importOriginal) => ({
  applyGoalBasis: (await importOriginal<typeof import("../ad-spend-controller")>()).applyGoalBasis,
  readMetaInventory: async () => ({ objects }),
  readGoogleInventory: async () => googleInv,
}));
vi.mock("../ad-goal-match", () => ({
  loadAdGoalMode: async () => ({ ok: true, mode: "count" }),
  loadGoalMatchContext: async () => ({ mode: "count" }),
  withGoalMatch: (objects: unknown[]) => objects,
}));
vi.mock("../unattended-policy", () => ({
  loadTracking: async () => ({ ok: tracking }),
}));
vi.mock("../cgo-ad-orders", () => ({
  submitCgoAdAction: (...a: unknown[]) => submit(...a),
}));
const action = (
  payload: Record<string, unknown>,
  exec_class = "meta_ads.update_ad_set_budget",
): UnattendedAction => ({
  kind: "ad",
  exec_class,
  payload,
  source: { table: "channel_actions", id: "a1", run_id: "r1" },
  title: "test",
});
const evidenceFacts = {
  openAdvice: "clear" as const,
  trackingOk: true,
  objects: [
    {
      id: "s1",
      learning: false,
      daysSinceEdit: 20,
      lockDays: 7,
      conversionObjective: true,
      objective: "purchase",
      conversionEventFiring: true,
      resultsMatchGoal: true,
      brand: false,
      spend7dUsd: 250,
      conversions7d: 0,
      targetCpaUsd: 25,
    },
  ],
};
beforeEach(() => {
  policy = {
    ...BUSINESS_CONTROL_DEFAULTS,
    enabled: true,
    automatic_stops: true,
  };
  tracking = true;
  rpc.mockReset().mockResolvedValue({ error: null });
  submit.mockReset().mockResolvedValue({ ok: true, action_id: "stop1" });
  objects = [
    {
      platform: "meta",
      id: "s1",
      level: "ad_set",
      spend7d_usd: 250,
      purchases7d: 10,
      purchase_value7d_usd: 250,
      result_kind: "conversions",
      created_at: "2026-09-01T00:00:00Z",
    } as AdObject,
  ];
  rows = {
    ad_campaigns: [
      {
        platform: "meta",
        account_id: "act_1",
        object_id: "s1",
        level: "ad_set",
        campaign_id: "c1",
        budget_kind: "daily",
        budget_usd: 10,
        status: "ACTIVE",
        currency: "USD",
        as_of: now.toISOString(),
      },
    ],
  };
});
const envelope = () => ({
  id: "e1",
  platform: "meta",
  account_id: "act_1",
  object_id: "s1",
  level: "ad_set",
  name: "test",
  budget_usd: 100,
  spent_usd: 0,
  exposure_usd: 0,
  spend_highwater: {},
  baseline: { date: "2026-10-08", amounts: {} },
  started_at: "2026-10-08T00:00:00Z",
  ends_at: "2026-10-15T00:00:00Z",
  state: "monitoring",
  stopped_at: null,
  stop_requested_at: null,
  stop_on_loss: false,
});
describe("execution-time business gate", () => {
  it("leaves Reddit to its own policy instead of treating it as ChatGPT", async () => {
    expect(await checkBusinessControl("t", action({ campaign_id: "reddit-1", status: "PAUSED" }, "reddit_ads.set_status"), {}, now)).toEqual({});
  });
  it("applies the founder's saved controls to an Autopilot LinkedIn launch, which has no measured purchases to prove it", async () => {
    const launch = action(
      { campaign_binding_id: "s1", status: "ACTIVE", origin: "agent", total_budget_usd: 6000 },
      "linkedin_ads.launch_campaign",
    );
    rows.growth_experiment_controls = [envelope()];
    expect(await checkBusinessControl("t", launch, { openAdvice: "clear", trackingOk: true }, now)).toEqual({
      hold: "business_controls_no_linkedin",
    });
    policy = { ...policy!, enabled: false };
    expect(await checkBusinessControl("t", launch, {}, now)).toEqual({});
    policy = null;
    expect(await checkBusinessControl("t", launch, {}, now)).toEqual({});
  });
  it("preserves legacy authority when the owner has not enabled controls", async () => {
    policy = null;
    expect(
      await checkBusinessControl(
        "t",
        action({
          ad_set_id: "s1",
          daily_budget_usd: 100,
          expected_current_daily_budget_usd: 10,
        }),
        {},
        now,
      ),
    ).toEqual({});
  });
  it("checks the current owner ceiling again on an already prepared raise", async () => {
    const a = action({
      ad_set_id: "s1",
      daily_budget_usd: 12,
      expected_current_daily_budget_usd: 10,
    });
    expect(await checkBusinessControl("t", a, {}, now)).toEqual({});
    policy!.max_cpa_usd = 20;
    expect((await checkBusinessControl("t", a, {}, now)).hold).toBe(
      "business_evidence_or_experiment_required",
    );
  });
  it("blocks stale tracking even when the legacy budget gate only warns", async () => {
    tracking = false;
    expect(
      (
        await checkBusinessControl(
          "t",
          action({
            ad_set_id: "s1",
            daily_budget_usd: 12,
            expected_current_daily_budget_usd: 10,
          }),
          { spendUpUnderBudget: true },
          now,
        )
      ).hold,
    ).toBeTruthy();
  });
  it.each([15, 7])(
    "enforces the owner step for a raise or cut: %s",
    async (to) =>
      expect(
        (
          await checkBusinessControl(
            "t",
            action({
              ad_set_id: "s1",
              daily_budget_usd: to,
              expected_current_daily_budget_usd: 10,
            }),
            {},
            now,
          )
        ).hold,
      ).toBe("business_step_exceeded"),
  );
  it("permits paused preparation but not an unbound launch", async () => {
    expect(
      await checkBusinessControl(
        "t",
        action({ status: "PAUSED" }, "meta_ads.create_campaign"),
        {},
        now,
      ),
    ).toEqual({});
    expect(
      (
        await checkBusinessControl(
          "t",
          action({ status: "ACTIVE" }, "meta_ads.create_campaign"),
          {},
          now,
        )
      ).hold,
    ).toBe("business_prepare_paused_experiment");
  });
  it("delegates a proven no-result stop only while permission and event evidence hold", async () => {
    objects[0]!.purchases7d = 0;
    const a = action(
      { object_id: "s1", status: "PAUSED" },
      "meta_ads.set_status",
    );
    expect(await checkBusinessControl("t", a, evidenceFacts, now)).toEqual({
      delegatedStop: true,
    });
    policy!.automatic_stops = false;
    expect(
      (await checkBusinessControl("t", a, evidenceFacts, now)).hold,
    ).toBeTruthy();
    policy!.automatic_stops = true;
    expect(
      (
        await checkBusinessControl(
          "t",
          a,
          {
            ...evidenceFacts,
            objects: [
              { ...evidenceFacts.objects[0]!, conversionEventFiring: false },
            ],
          },
          now,
        )
      ).hold,
    ).toBe("business_stop_evidence_unverified");
  });
  it("allows evidence-gathering inside a registered envelope and blocks a latched stop", async () => {
    objects[0]!.purchases7d = 0;
    rows.growth_experiment_controls = [envelope()];
    const a = action(
      { object_id: "s1", status: "ACTIVE" },
      "meta_ads.set_status",
    );
    expect(await checkBusinessControl("t", a, {}, now)).toEqual({});
    rows.growth_experiment_controls[0].stop_requested_at = now.toISOString();
    expect((await checkBusinessControl("t", a, {}, now)).hold).toBe(
      "experiment_stop_required",
    );
  });
});
it("holds an untrusted goal despite the legacy budgeted-spend exception", async () => {
  expect(
    (
      await checkBusinessControl(
        "t",
        action({
          ad_set_id: "s1",
          daily_budget_usd: 12,
          expected_current_daily_budget_usd: 10,
        }),
        {
          spendUpUnderBudget: true,
          goal: { present: true, numberTrusted: false },
        },
        now,
      )
    ).hold,
  ).toBe("goal_number_untrusted");
});
describe("hourly experiment monitor", () => {
  it("queues the stop, records its action id and does not claim it is stopped", async () => {
    rows.growth_experiment_controls = [
      { ...envelope(), ends_at: now.toISOString() },
    ];
    await monitorExperiments("t", now);
    expect(submit).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]![2].p_check).toMatchObject({
      state: "stopping",
      pause_action_id: "stop1",
      stop: true,
    });
  });
  it("retains budget and reports a failed pause", async () => {
    rows.growth_experiment_controls = [
      { ...envelope(), ends_at: now.toISOString() },
    ];
    submit.mockResolvedValue({ ok: false, why: "provider unavailable" });
    await monitorExperiments("t", now);
    expect(rpc.mock.calls[0]![2].p_check).toMatchObject({
      state: "stop_failed",
      reason: "provider unavailable",
    });
  });
  it("stops issuing pauses immediately when the owner revokes permission", async () => {
    rows.growth_experiment_controls = [
      { ...envelope(), ends_at: now.toISOString() },
    ];
    policy!.automatic_stops = false;
    await monitorExperiments("t", now);
    expect(submit).not.toHaveBeenCalled();
    expect(rpc.mock.calls[0]![2].p_check.state).toBe("needs_attention");
  });
  it("waits for an existing queued pause rather than issuing another", async () => {
    rows.growth_experiment_controls = [
      { ...envelope(), state: "stopping", pause_action_id: "stop1" },
    ];
    rows.channel_actions = [
      {
        id: "stop1",
        exec_status: "queued",
        exec_payload: { object_id: "s1" },
        executed_at: null,
        exec_claimed_at: null,
      },
    ];
    await monitorExperiments("t", now);
    expect(submit).not.toHaveBeenCalled();
    expect(rpc.mock.calls[0]![2].p_check.state).toBe("stopping");
  });
});

describe("a failed Google brand read in the business gate", () => {
  it("must not catch: Performance Max stays judged; must catch: the held Search campaign is left out", async () => {
    googleInv = {
      objects: [
        { platform: "google", id: "g-search", level: "campaign", brand: true, spend7d_usd: 100, result_kind: "conversions", created_at: "2026-09-01T00:00:00Z" },
        { platform: "google", id: "g-pmax", level: "campaign", spend7d_usd: 100, result_kind: "conversions", created_at: "2026-09-01T00:00:00Z" },
      ],
      brand_unread: true,
    };
    const inv = await readBusinessInventory("t", now);
    expect(inv.objects.map((o) => o.id)).toContain("g-pmax");
    expect(inv.objects.map((o) => o.id)).not.toContain("g-search");
    googleInv = { objects: [] };
  });
});
