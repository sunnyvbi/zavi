
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
const readCardMoneyAtStake = vi.fn(async () => null as unknown);
vi.mock("../_stake-budget", async () => {
  const actual = await vi.importActual<typeof import("../_stake-budget")>("../_stake-budget");
  return { ...actual, readCardMoneyAtStake: (...a: unknown[]) => readCardMoneyAtStake(...(a as [])) };
});

import {
  buildExecCardBody,
  execActionType,
  resolveGoogleAdsEmit,
} from "../_exec-action";
import { allowedActionTypes } from "@zavi/shared";

const BUDGET_CLASS = "google_ads.update_campaign_budget";
const BUDGET_BODY = {
  campaign_id: "123",
  daily_budget_usd: 150,
  expected_current_daily_budget_usd: 100,
  rationale: "It converts at half the account CPA.",
  decision_evidence: {
    reason_text: "It converts at half the account CPA.",
    evidence: ["$412.60: spent, 9 conversions"],
    stats: [{ value: "$412.60", caption: "spent, 9 conversions" }],
    window: { from: "2026-09-01", to: "2026-09-18" },
    reversibility: "reversible",
    blast_radius: "YELLOW",
    confidence: 0.6,
  },
  over_cap: false,
  name: "Brand — Exact",
};

beforeEach(() => {
  vi.clearAllMocks();
  recordChannelExecAction.mockResolvedValue({ id: "act-1", replayed: false });
  readCardMoneyAtStake.mockResolvedValue(null);
});

describe("a switched channel's propose_* never writes `decisions`", () => {
  it("routes to the channel_actions writer and returns its id", async () => {
    switchedChannelForRun.mockResolvedValue("google_ads");
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveGoogleAdsEmit({
      tenant_id: "t-1",
      run_id: "run-1",
      emit_decision: emit,
    });
    const id = await wrapped!(BUDGET_CLASS, BUDGET_BODY);

    expect(emit).not.toHaveBeenCalled();
    expect(id).toBe("act-1");
    expect(recordChannelExecAction).toHaveBeenCalledTimes(1);
  });

  it("stores the UNCHANGED body as exec_payload: the handler parses what it always did", async () => {
    switchedChannelForRun.mockResolvedValue("google_ads");
    const wrapped = await resolveGoogleAdsEmit({
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
});

describe("youtube_ads shares these tools and IS switched (2026-09-20)", () => {
  it("takes the card rail, like the platform's other channel", async () => {
    switchedChannelForRun.mockResolvedValue("youtube_ads");
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveGoogleAdsEmit({
      tenant_id: "t-1",
      run_id: "run-yt",
      emit_decision: emit,
    });
    await wrapped!(BUDGET_CLASS, BUDGET_BODY);
    expect(emit).not.toHaveBeenCalled();
    expect(recordChannelExecAction).toHaveBeenCalledTimes(1);
    const arg = recordChannelExecAction.mock.calls[0][0] as {
      execClass: string;
      execPayload: unknown;
    };
    expect(arg.execClass).toBe(BUDGET_CLASS);
    expect(arg.execPayload).toBe(BUDGET_BODY);
  });

  it("leaves a meta_ads-stamped run on its original closure", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveGoogleAdsEmit({
      tenant_id: "t-1",
      run_id: "run-meta",
      emit_decision: emit,
    });
    expect(wrapped).toBe(emit);
    expect(recordChannelExecAction).not.toHaveBeenCalled();
  });

  it("an unstamped run emits the same class and the same body object it always did", async () => {
    switchedChannelForRun.mockResolvedValue(null);
    const emit = vi.fn(async (_cls: string, _body: unknown) => "decision-id");
    const wrapped = await resolveGoogleAdsEmit({
      tenant_id: "t-1",
      run_id: "run-unstamped",
      emit_decision: emit,
    });
    const id = await wrapped!(BUDGET_CLASS, BUDGET_BODY);
    expect(id).toBe("decision-id");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toBe(BUDGET_CLASS);
    expect(emit.mock.calls[0]![1]).toBe(BUDGET_BODY);
    expect(recordChannelExecAction).not.toHaveBeenCalled();
  });

  it("a chat turn (no run_id) is untouched and never even reads the stamp", async () => {
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveGoogleAdsEmit({ tenant_id: "t-1", emit_decision: emit });
    expect(wrapped).toBe(emit);
    expect(switchedChannelForRun).not.toHaveBeenCalled();
  });

});

describe("an unreadable channel stamp FAILS the proposal instead of guessing a rail", () => {
  it("emits NO decision and surfaces an error the model can retry", async () => {
    switchedChannelForRun.mockRejectedValue(new Error("db down"));
    const emit = vi.fn(async () => "decision-id");

    await expect(
      resolveGoogleAdsEmit({ tenant_id: "t-1", run_id: "run-1", emit_decision: emit }),
    ).rejects.toMatchObject({ code: "channel_stamp_unreadable" });

    expect(emit).not.toHaveBeenCalled();
    expect(recordChannelExecAction).not.toHaveBeenCalled();
  });

  it("a SUCCESSFUL read saying 'not switched' still uses the legacy emit, unchanged", async () => {
    switchedChannelForRun.mockResolvedValue(null);
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveGoogleAdsEmit({
      tenant_id: "t-1",
      run_id: "run-yt",
      emit_decision: emit,
    });
    expect(wrapped).toBe(emit);
    expect(await wrapped!(BUDGET_CLASS, BUDGET_BODY)).toBe("decision-id");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(recordChannelExecAction).not.toHaveBeenCalled();
  });
});

describe("writesSuppressed (shadow / best-of-N draft) writes NOTHING", () => {
  it("neither a channel_actions row nor a decision", async () => {
    switchedChannelForRun.mockResolvedValue("google_ads");
    const emit = vi.fn(async () => "decision-id");
    const wrapped = await resolveGoogleAdsEmit({
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

describe("the action type of an ad change", () => {
  it("is always one the paid-ads channel allows", () => {
    const allowed = allowedActionTypes("google_ads");
    const classes: Array<[string, Record<string, unknown>]> = [
      ["google_ads.update_campaign_budget", {}],
      ["google_ads.update_campaign_budget_review", {}],
      ["google_ads.set_status", { status: "PAUSED" }],
      ["google_ads.set_status", { status: "ENABLED" }],
      ["google_ads.set_status_review", { status: "PAUSED" }],
      ["google_ads.create_campaign", {}],
      ["google_ads.create_ad_group", {}],
      ["google_ads.create_ad", {}],
      ["google_ads.add_keywords", {}],
      ["google_ads.update_campaign", {}],
      ["google_ads.update_ad_group", {}],
      ["google_ads.remove_resource", {}],
    ];
    for (const [cls, body] of classes) {
      expect(allowed, cls).toContain(execActionType(cls, body));
    }
  });

  it("a pause is a pause and an enable is not", () => {
    expect(execActionType("google_ads.set_status", { status: "PAUSED" })).toBe("pause_ad");
    expect(execActionType("google_ads.set_status", { status: "ENABLED" })).toBe("update_ad");
    expect(execActionType("google_ads.remove_resource", {})).toBe("pause_ad");
    expect(execActionType("google_ads.create_campaign", {})).toBe("create_ad");
  });
});

describe("the card the founder reads", () => {
  it("carries the server's exact-change rows and the run's evidence", () => {
    const { title, card } = buildExecCardBody(BUDGET_CLASS, BUDGET_BODY);
    expect(title.length).toBeGreaterThan(2);
    const rows = (card.exact_change as { rows: Array<{ item: string; before: string; after: string }> }).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.before.includes("100") && r.after.includes("150"))).toBe(true);
    expect(card.decision_evidence).toBe(BUDGET_BODY.decision_evidence);
    expect((card.step as { body: string }).body).toContain("CPA");
  });

  it("a body dispatch would refuse draws no change rows rather than guessing", () => {
    const { card } = buildExecCardBody(BUDGET_CLASS, { nonsense: true });
    expect(card.exact_change).toBeNull();
    expect(card.change_sentence).toBeNull();
  });
});

const PAUSE_BODY = {
  campaign_id: "123",
  level: "campaign",
  status: "PAUSED",
  rationale: "0 conversions in 30 days",
  over_cap: false,
};
const STAKE = {
  daily_budget_usd: 24.35,
  scope: "campaign" as const,
  campaign_id: "123",
  source: "google_ads.campaign_budget" as const,
};

describe("the budget a pause stops", () => {
  it("rides on the CARD BODY, never on exec_payload", async () => {
    switchedChannelForRun.mockResolvedValue("google_ads");
    readCardMoneyAtStake.mockResolvedValue(STAKE);
    const emit = await resolveGoogleAdsEmit({
      tenant_id: "t-1",
      run_id: "r-1",
      emit_decision: async () => "should-not-be-used",
    });
    await emit!("google_ads.set_status", PAUSE_BODY);

    const wrote = recordChannelExecAction.mock.calls[0][0] as {
      execPayload: Record<string, unknown>;
      body: Record<string, unknown>;
    };
    expect(wrote.body.money_at_stake).toEqual(STAKE);
    expect(wrote.execPayload).toEqual(PAUSE_BODY);
    expect(Object.keys(wrote.execPayload)).not.toContain("money_at_stake");
  });

  it("leaves the card exactly as it was when nothing could be read", async () => {
    switchedChannelForRun.mockResolvedValue("google_ads");
    readCardMoneyAtStake.mockResolvedValue(null);
    const emit = await resolveGoogleAdsEmit({
      tenant_id: "t-1",
      run_id: "r-1",
      emit_decision: async () => "x",
    });
    await emit!("google_ads.set_status", PAUSE_BODY);

    const wrote = recordChannelExecAction.mock.calls[0][0] as { body: Record<string, unknown> };
    expect(wrote.body.money_at_stake).toBeUndefined();
    expect(wrote.body).toEqual(buildExecCardBody("google_ads.set_status", PAUSE_BODY).card);
  });

  it("is never read for a run this platform does not own", async () => {
    switchedChannelForRun.mockResolvedValue("meta_ads");
    const emit_decision = async () => "dec-1";
    const emit = await resolveGoogleAdsEmit({ tenant_id: "t-1", run_id: "r-1", emit_decision });
    expect(emit).toBe(emit_decision);
    expect(readCardMoneyAtStake).not.toHaveBeenCalled();
  });
});
