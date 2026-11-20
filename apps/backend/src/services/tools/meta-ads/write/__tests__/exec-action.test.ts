
import { describe, it, expect, vi, beforeEach } from "vitest";

const switchedChannelForRun = vi.fn();
vi.mock("@/services/channels/channel-actions", () => ({
  switchedChannelForRun: (...a: unknown[]) => switchedChannelForRun(...a),
}));
const recordChannelExecAction = vi.fn(
  async (_input: Record<string, unknown>) => ({ id: "act-1", replayed: false }),
);
vi.mock("@/services/channels/exec-actions", () => ({
  recordChannelExecAction: (input: Record<string, unknown>) => recordChannelExecAction(input),
}));
const readMetaCardMoneyAtStake = vi.fn(async (..._a: unknown[]) => null as unknown);
vi.mock("../_stake-budget", async () => {
  const actual = await vi.importActual<typeof import("../_stake-budget")>("../_stake-budget");
  return {
    ...actual,
    readMetaCardMoneyAtStake: (...a: unknown[]) => readMetaCardMoneyAtStake(...a),
  };
});

import { buildMetaExecCardBody, metaExecActionType, resolveMetaAdsEmit } from "../_exec-action";
import { PENDING_STRATEGIST_CLASS } from "@/services/meta-ads/strategist-gate/constants";
import { moneyAtStakeUsd } from "@/services/channels/money-at-stake";
import { allowedActionTypes } from "@zavi/shared";

const BUDGET_CLASS = "meta_ads.update_ad_set_budget";
const BUDGET_BODY = {
  ad_set_id: "23851",
  daily_budget_usd: 150,
  expected_current_daily_budget_usd: 100,
  rationale: "It books at half the account cost per result.",
  over_cap: false,
  name: "Prospecting — Broad",
  about: "Cold traffic to the listings page.",
};

const PAUSE_CLASS = "meta_ads.set_status";
const PAUSE_BODY = {
  object_id: "23851",
  level: "adset",
  status: "PAUSED",
  rationale: "0 results in 14 days",
  over_cap: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  recordChannelExecAction.mockResolvedValue({ id: "act-1", replayed: false });
  readMetaCardMoneyAtStake.mockResolvedValue(null);
});

describe("a switched meta_ads run never writes `decisions`", () => {
  it("routes to the channel_actions writer and returns its id", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveMetaAdsEmit({
      tenant_id: "t-1",
      run_id: "run-1",
      emit_decision: emit,
    });
    const id = await wrapped!(BUDGET_CLASS, BUDGET_BODY);

    expect(emit).not.toHaveBeenCalled();
    expect(id).toBe("act-1");
    expect(recordChannelExecAction).toHaveBeenCalledTimes(1);
  });

  it("stores the UNCHANGED body as exec_payload under the class dispatch keys on", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    const wrapped = await resolveMetaAdsEmit({
      tenant_id: "t-1",
      run_id: "run-1",
      emit_decision: vi.fn(async () => "x"),
    });
    await wrapped!(BUDGET_CLASS, BUDGET_BODY);
    const arg = recordChannelExecAction.mock.calls[0]![0] as unknown as {
      execClass: string;
      execPayload: unknown;
      body: Record<string, unknown>;
      actionType: string;
    };
    expect(arg.execClass).toBe(BUDGET_CLASS);
    expect(arg.execPayload).toEqual(BUDGET_BODY);
    expect(arg.body).not.toEqual(BUDGET_BODY);
    expect(arg.body.exact_change).toBeTruthy();
    expect(arg.actionType).toBe("update_ad");
  });

  it("carries every executable class, so no propose tool is stranded", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    const cases: Array<[string, Record<string, unknown>]> = [
      [BUDGET_CLASS, BUDGET_BODY],
      ["meta_ads.update_ad_set_budget_review", BUDGET_BODY],
      [PAUSE_CLASS, PAUSE_BODY],
      ["meta_ads.set_status_review", { ...PAUSE_BODY, status: "ACTIVE" }],
      [
        "meta_ads.create_ad_set",
        {
          campaign_id: "9001",
          name: "Lookalike 1%",
          daily_budget_usd: 40,
          optimization_goal: "LINK_CLICKS",
          billing_event: "IMPRESSIONS",
          targeting: { geo_locations: { countries: ["US"] } },
          rationale: "",
        },
      ],
    ];
    for (const [cls, body] of cases) {
      recordChannelExecAction.mockClear();
      const wrapped = await resolveMetaAdsEmit({
        tenant_id: "t-1",
        run_id: "run-1",
        emit_decision: vi.fn(async () => "x"),
      });
      await wrapped!(cls, body);
      expect(recordChannelExecAction, cls).toHaveBeenCalledTimes(1);
      const arg = recordChannelExecAction.mock.calls[0]![0] as unknown as {
        execClass: string;
        body: Record<string, unknown>;
      };
      expect(arg.execClass, cls).toBe(cls);
      expect(arg.body.exact_change, cls).toBeTruthy();
    }
  });
});

describe("an unstamped run shares these tools and is NOT switched", () => {
  it("gets back the SAME emit closure, so its path is byte-identical", async () => {
    switchedChannelForRun.mockResolvedValue(null);
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveMetaAdsEmit({
      tenant_id: "t-1",
      run_id: "run-chat",
      emit_decision: emit,
    });
    expect(wrapped).toBe(emit);
  });

  it("emits the same class and the same body OBJECT it always did", async () => {
    switchedChannelForRun.mockResolvedValue(null);
    const emit = vi.fn(async (_cls: string, _body: unknown) => "decision-id");
    const wrapped = await resolveMetaAdsEmit({
      tenant_id: "t-1",
      run_id: "run-chat",
      emit_decision: emit,
    });
    const id = await wrapped!(BUDGET_CLASS, BUDGET_BODY);
    expect(id).toBe("decision-id");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toBe(BUDGET_CLASS);
    expect(emit.mock.calls[0]![1]).toBe(BUDGET_BODY);
    expect(recordChannelExecAction).not.toHaveBeenCalled();
    expect(readMetaCardMoneyAtStake).not.toHaveBeenCalled();
  });

  it("a chat turn with no run_id is untouched and never even reads the stamp", async () => {
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveMetaAdsEmit({ tenant_id: "t-1", emit_decision: emit });
    expect(wrapped).toBe(emit);
    expect(switchedChannelForRun).not.toHaveBeenCalled();
  });

  it("another switched channel's run does not steal meta's proposals", async () => {
    switchedChannelForRun.mockResolvedValue("google_ads");
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveMetaAdsEmit({
      tenant_id: "t-1",
      run_id: "run-g",
      emit_decision: emit,
    });
    expect(wrapped).toBe(emit);
  });
});

describe("an unreadable channel stamp FAILS the proposal instead of guessing a rail", () => {
  it("emits NO decision and surfaces an error the model can retry", async () => {
    switchedChannelForRun.mockRejectedValue(new Error("db down"));
    const emit = vi.fn(async () => "decision-id");

    await expect(
      resolveMetaAdsEmit({ tenant_id: "t-1", run_id: "run-1", emit_decision: emit }),
    ).rejects.toMatchObject({ code: "channel_stamp_unreadable" });

    expect(emit).not.toHaveBeenCalled();
    expect(recordChannelExecAction).not.toHaveBeenCalled();
  });
});

describe("a class this rail does not know is refused, not filed somewhere invisible", () => {
  it("writes neither rail and says so", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveMetaAdsEmit({
      tenant_id: "t-1",
      run_id: "run-1",
      emit_decision: emit,
    });
    await expect(wrapped!("meta_ads.something_new", { a: 1 })).rejects.toMatchObject({
      code: "channel_action_class_unknown",
    });
    expect(emit).not.toHaveBeenCalled();
    expect(recordChannelExecAction).not.toHaveBeenCalled();
  });
});

describe("the parked strategist review is the one row that stays on `decisions`", () => {
  it("passes straight through, because the gate reads it back by decision id", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    const emit = vi.fn(async () => "parked-decision-id");
    const parked = { strategist_gate: { kind: "create_ad_set_pending_strategist" } };
    const wrapped = await resolveMetaAdsEmit({
      tenant_id: "t-1",
      run_id: "run-1",
      emit_decision: emit,
    });
    const id = await wrapped!(PENDING_STRATEGIST_CLASS, parked);

    expect(id).toBe("parked-decision-id");
    expect(emit).toHaveBeenCalledWith(PENDING_STRATEGIST_CLASS, parked);
    expect(recordChannelExecAction).not.toHaveBeenCalled();
  });

  it("is named outside the meta_ads namespace, which is what keeps it off /approvals", () => {
    expect(PENDING_STRATEGIST_CLASS.startsWith("meta_ads.")).toBe(false);
  });
});

describe("writesSuppressed (shadow / best-of-N draft) writes NOTHING", () => {
  it("neither a channel_actions row nor a decision", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveMetaAdsEmit({
      tenant_id: "t-1",
      run_id: "run-1",
      writes_suppressed: true,
      emit_decision: emit,
    });
    const id = await wrapped!(BUDGET_CLASS, BUDGET_BODY);
    expect(recordChannelExecAction).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(id).toBe("channel_action_suppressed");
  });
});

describe("tenant isolation", () => {
  it("writes and prices with the run's tenant, never one named in the body", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    const wrapped = await resolveMetaAdsEmit({
      tenant_id: "tenant-A",
      run_id: "run-A",
      emit_decision: vi.fn(async () => "x"),
    });
    await wrapped!(PAUSE_CLASS, { ...PAUSE_BODY, tenant_id: "tenant-B", run_id: "run-B" });

    const arg = recordChannelExecAction.mock.calls[0]![0] as unknown as {
      tenantId: string;
      runId: string;
    };
    expect(arg.tenantId).toBe("tenant-A");
    expect(arg.runId).toBe("run-A");
    expect(readMetaCardMoneyAtStake.mock.calls[0]![0]).toBe("tenant-A");
  });

  it("asks the stamp about the run's own tenant", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    await resolveMetaAdsEmit({
      tenant_id: "tenant-A",
      run_id: "run-A",
      emit_decision: vi.fn(async () => "x"),
    });
    expect(switchedChannelForRun).toHaveBeenCalledWith("tenant-A", "run-A");
  });
});

describe("the action type of a Meta change", () => {
  it("is always one the paid-ads channel allows", () => {
    const allowed = allowedActionTypes("meta_ads");
    const classes: Array<[string, Record<string, unknown>]> = [
      ["meta_ads.update_ad_set_budget", {}],
      ["meta_ads.update_ad_set_budget_review", {}],
      ["meta_ads.set_status", { status: "PAUSED" }],
      ["meta_ads.set_status", { status: "ACTIVE" }],
      ["meta_ads.set_status_review", { status: "PAUSED" }],
      ["meta_ads.create_ad_set", {}],
    ];
    for (const [cls, body] of classes) {
      expect(allowed, cls).toContain(metaExecActionType(cls, body));
    }
  });

  it("a pause is a pause and a resume is not", () => {
    expect(metaExecActionType("meta_ads.set_status", { status: "PAUSED" })).toBe("pause_ad");
    expect(metaExecActionType("meta_ads.set_status", { status: "ACTIVE" })).toBe("update_ad");
    expect(metaExecActionType("meta_ads.create_ad_set", {})).toBe("create_ad");
  });
});

describe("the card the founder reads", () => {
  it("carries the server's exact-change rows, read off the body dispatch parses", () => {
    const { title, card } = buildMetaExecCardBody(BUDGET_CLASS, BUDGET_BODY);
    expect(title.length).toBeGreaterThan(2);
    const rows = (card.exact_change as { rows: Array<{ before: string; after: string }> }).rows;
    expect(rows.some((r) => r.before.includes("100") && r.after.includes("150"))).toBe(true);
    expect((card.step as { body: string }).body).toContain("cost per result");
  });

  it("a body dispatch would refuse draws no change rows rather than guessing", () => {
    const { card } = buildMetaExecCardBody(BUDGET_CLASS, { nonsense: true });
    expect(card.exact_change).toBeNull();
    expect(card.change_sentence).toBeNull();
  });

  it("invents no evidence: these tools do not write a decision_evidence block", () => {
    const { card } = buildMetaExecCardBody(PAUSE_CLASS, PAUSE_BODY);
    expect(card.decision_evidence).toBeNull();
    expect((card.step as { evidence: unknown[] }).evidence).toEqual([]);
  });
});

const STAKE = {
  daily_budget_usd: 24.35,
  scope: "adset" as const,
  object_id: "23851",
  source: "meta_ads.daily_budget" as const,
};

describe("the budget a Meta pause stops", () => {
  it("rides on the CARD BODY, never on exec_payload", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    readMetaCardMoneyAtStake.mockResolvedValue(STAKE);
    const emit = await resolveMetaAdsEmit({
      tenant_id: "t-1",
      run_id: "r-1",
      emit_decision: async () => "should-not-be-used",
    });
    await emit!(PAUSE_CLASS, PAUSE_BODY);

    const wrote = recordChannelExecAction.mock.calls[0]![0] as unknown as {
      execPayload: Record<string, unknown>;
      body: Record<string, unknown>;
    };
    expect(wrote.body.money_at_stake).toEqual(STAKE);
    expect(wrote.execPayload).toEqual(PAUSE_BODY);
    expect(Object.keys(wrote.execPayload)).not.toContain("money_at_stake");
  });

  it("leaves the card exactly as it was when nothing could be read", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    readMetaCardMoneyAtStake.mockResolvedValue(null);
    const emit = await resolveMetaAdsEmit({
      tenant_id: "t-1",
      run_id: "r-1",
      emit_decision: async () => "x",
    });
    await emit!(PAUSE_CLASS, PAUSE_BODY);

    const wrote = recordChannelExecAction.mock.calls[0]![0] as unknown as {
      body: Record<string, unknown>;
    };
    expect(wrote.body.money_at_stake).toBeUndefined();
    expect(wrote.body).toEqual(buildMetaExecCardBody(PAUSE_CLASS, PAUSE_BODY).card);
  });

  it("prices the card from the READ number, not from a figure written in the prose", () => {
    const cardWithProse = {
      ...buildMetaExecCardBody(PAUSE_CLASS, {
        ...PAUSE_BODY,
        rationale: "Pausing this frees $9,999 a month.",
      }).card,
      decision_evidence: { stats: [{ value: "$9,999", caption: "freed each month" }] },
      money_at_stake: STAKE,
    };
    const priced = moneyAtStakeUsd(PAUSE_CLASS, PAUSE_BODY, cardWithProse);
    expect(priced).toEqual({ monthly_usd: 740.24, basis: "live_daily_budget" });
  });

  it("a model-written block on the wrong object cannot price the change", () => {
    const card = {
      money_at_stake: { ...STAKE, object_id: "99999", daily_budget_usd: 5000 },
    };
    expect(moneyAtStakeUsd(PAUSE_CLASS, PAUSE_BODY, card)).toBeNull();
  });

  it("an ad-set pause cannot be priced with a CAMPAIGN's budget", () => {
    const card = { money_at_stake: { ...STAKE, scope: "campaign" as const } };
    expect(moneyAtStakeUsd(PAUSE_CLASS, PAUSE_BODY, card)).toBeNull();
  });

  it("a Google block cannot price a Meta change, or the other way round", () => {
    const googleBlock = {
      money_at_stake: {
        daily_budget_usd: 24.35,
        scope: "campaign",
        campaign_id: "23851",
        source: "google_ads.campaign_budget",
      },
    };
    expect(moneyAtStakeUsd(PAUSE_CLASS, PAUSE_BODY, googleBlock)).toBeNull();
  });

  it("a create moves no money on Approve, because the ad set starts paused", () => {
    const createBody = {
      campaign_id: "9001",
      name: "Lookalike 1%",
      daily_budget_usd: 400,
      optimization_goal: "LINK_CLICKS",
      billing_event: "IMPRESSIONS",
      targeting: {},
      rationale: "",
    };
    expect(moneyAtStakeUsd("meta_ads.create_ad_set", createBody, { money_at_stake: STAKE })).toBeNull();
  });

  it("a budget change prices itself from the payload, with no read at all", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    readMetaCardMoneyAtStake.mockResolvedValue(null);
    const emit = await resolveMetaAdsEmit({
      tenant_id: "t-1",
      run_id: "r-1",
      emit_decision: async () => "x",
    });
    await emit!(BUDGET_CLASS, BUDGET_BODY);
    expect(moneyAtStakeUsd(BUDGET_CLASS, BUDGET_BODY, {})).toEqual({
      monthly_usd: 1520,
      basis: "budget_delta",
    });
  });
});
