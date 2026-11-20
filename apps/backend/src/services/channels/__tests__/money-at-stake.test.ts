
import { describe, expect, it } from "vitest";
import { DAYS_PER_MONTH, maxMoneyAtStake, moneyAtStakeUsd } from "../money-at-stake";
import { scoreAction, type ScoreInput } from "../score-action";

const base: ScoreInput = {
  impact: null,
  position: 1,
  run_of: 5,
  channel_in_plan: false,
  metric_matches_goal: false,
  previously_rejected: false,
};

const execRow = (over: Partial<ScoreInput>): ScoreInput => ({
  ...base,
  position: 900,
  run_of: 900,
  ...over,
});

const budget = (from: number, to: number) => ({
  campaign_id: "123",
  daily_budget_usd: to,
  expected_current_daily_budget_usd: from,
  rationale: "r",
  over_cap: false,
});

const pause = (over: Record<string, unknown> = {}) => ({
  campaign_id: "123",
  level: "campaign",
  status: "PAUSED",
  rationale: "0 conversions in 30 days",
  over_cap: false,
  ...over,
});

const stakeCard = (daily: number, campaign_id = "123") => ({
  step: { title: "Pause it" },
  money_at_stake: {
    daily_budget_usd: daily,
    scope: "campaign",
    campaign_id,
    source: "google_ads.campaign_budget",
  },
});

describe("moneyAtStakeUsd", () => {
  it("prices a budget change as the monthly delta, either direction", () => {
    expect(moneyAtStakeUsd("google_ads.update_campaign_budget", budget(10, 60))).toEqual({
      monthly_usd: 50 * DAYS_PER_MONTH,
      basis: "budget_delta",
    });
    const cut = moneyAtStakeUsd("google_ads.update_campaign_budget", budget(25, 0.66));
    expect(cut?.monthly_usd).toBeCloseTo(740, 0);
    expect(moneyAtStakeUsd("google_ads.update_campaign_budget_review", budget(10, 11))?.monthly_usd).toBeCloseTo(
      30.4,
      2,
    );
  });

  it("is null when nothing is at stake or the body would not dispatch", () => {
    expect(moneyAtStakeUsd("google_ads.update_campaign_budget", budget(20, 20))).toBeNull();
    expect(
      moneyAtStakeUsd("google_ads.update_campaign_budget", { campaign_id: "1", daily_budget_usd: 50 }),
    ).toBeNull();
    expect(moneyAtStakeUsd("google_ads.update_campaign_budget", null)).toBeNull();
    expect(moneyAtStakeUsd(null, budget(10, 60))).toBeNull();
    expect(moneyAtStakeUsd("", budget(10, 60))).toBeNull();
  });

  it("prices a pause from the campaign's live daily budget, read at propose time", () => {
    const m = moneyAtStakeUsd("google_ads.set_status", pause(), stakeCard(24.35));
    expect(m?.monthly_usd).toBeCloseTo(740, 0);
    expect(m?.basis).toBe("live_daily_budget");
    expect(moneyAtStakeUsd("google_ads.set_status", pause({ status: "ENABLED" }), stakeCard(24.35))?.monthly_usd).toBeCloseTo(740, 0);
    expect(moneyAtStakeUsd("google_ads.set_status_review", pause(), stakeCard(24.35))?.monthly_usd).toBeCloseTo(740, 0);
    expect(
      moneyAtStakeUsd("google_ads.remove_resource", { level: "campaign", campaign_id: "123", rationale: "r" }, stakeCard(24.35))
        ?.monthly_usd,
    ).toBeCloseTo(740, 0);
  });

  it("a pause with no stored number gets nothing — a failed read is not an amount", () => {
    expect(moneyAtStakeUsd("google_ads.set_status", pause(), undefined)).toBeNull();
    expect(moneyAtStakeUsd("google_ads.set_status", pause(), {})).toBeNull();
    expect(moneyAtStakeUsd("google_ads.set_status", pause(), { step: { title: "Pause it" } })).toBeNull();
  });

  it("RE-GATES the stored number: it cannot price a change narrower than a campaign", () => {
    expect(
      moneyAtStakeUsd("google_ads.set_status", pause({ level: "ad_group", ad_group_id: "7" }), stakeCard(24.35)),
    ).toBeNull();
    expect(moneyAtStakeUsd("google_ads.set_status", pause(), stakeCard(24.35, "999"))).toBeNull();
  });

  it("refuses a stake block that is not the shape the server writes", () => {
    const bad = (over: Record<string, unknown>) => ({
      step: {},
      money_at_stake: { daily_budget_usd: 24.35, scope: "campaign", campaign_id: "123", source: "google_ads.campaign_budget", ...over },
    });
    expect(moneyAtStakeUsd("google_ads.set_status", pause(), bad({ source: "the model said so" }))).toBeNull();
    expect(moneyAtStakeUsd("google_ads.set_status", pause(), bad({ scope: "ad_group" }))).toBeNull();
    expect(moneyAtStakeUsd("google_ads.set_status", pause(), bad({ daily_budget_usd: "24.35" }))).toBeNull();
    expect(moneyAtStakeUsd("google_ads.set_status", pause(), bad({ daily_budget_usd: 0 }))).toBeNull();
    expect(moneyAtStakeUsd("google_ads.set_status", pause(), bad({ campaign_id: 123 }))).toBeNull();
  });

  it("is null for a class whose executed body carries no dollar figure", () => {
    expect(moneyAtStakeUsd("google_ads.set_status", pause())).toBeNull();
    expect(
      moneyAtStakeUsd("google_ads.remove_resource", { level: "campaign", campaign_id: "123", rationale: "r" }),
    ).toBeNull();
    expect(
      moneyAtStakeUsd(
        "google_ads.add_keywords",
        { level: "campaign", campaign_id: "123", negative: true, keywords: [{ text: "free", match_type: "BROAD" }], rationale: "r" },
        stakeCard(24.35),
      ),
    ).toBeNull();
    expect(
      moneyAtStakeUsd(
        "google_ads.create_campaign",
        { name: "New", channel_type: "SEARCH", daily_budget_usd: 100, bidding: { strategy: "MANUAL_CPC" }, rationale: "r" },
        stakeCard(100),
      ),
    ).toBeNull();
  });

  it("cannot be moved by anything the model wrote on the card", () => {
    const withProse = {
      ...budget(10, 11),
      decision_evidence: {
        stats: [{ value: "$99,000", caption: "at stake" }],
        estimate: [{ value: "$99,000", caption: "freed each month" }],
        headline: "Huge",
      },
    };
    expect(moneyAtStakeUsd("google_ads.update_campaign_budget", withProse)?.monthly_usd).toBeCloseTo(30.4, 2);
  });

  it("maxMoneyAtStake ignores the unpriced rows", () => {
    expect(
      maxMoneyAtStake([null, { monthly_usd: 740, basis: "budget_delta" }, null, { monthly_usd: 50, basis: "budget_delta" }]),
    ).toBe(740);
    expect(maxMoneyAtStake([])).toBeNull();
    expect(maxMoneyAtStake([null, null])).toBeNull();
  });
});

describe("money at stake in the score", () => {
  const MAX = 740;

  it("a $740/month pause outranks a $50/month raise", () => {
    const big = scoreAction(execRow({ money_at_stake_usd: 740, money_at_stake_max_usd: MAX }));
    const small = scoreAction(execRow({ money_at_stake_usd: 50, money_at_stake_max_usd: MAX }));
    expect(big.score).toBeGreaterThan(small.score);
    expect(big.score_inputs.rank_n).toBe(1);
    expect(small.score_inputs.rank_n).toBeCloseTo(50 / 740, 6);
  });

  it("an unparseable amount does not jump the queue: it keeps today's rank_n of 0", () => {
    const unpriced = scoreAction(execRow({ money_at_stake_usd: null, money_at_stake_max_usd: MAX }));
    const priced = scoreAction(execRow({ money_at_stake_usd: 50, money_at_stake_max_usd: MAX }));
    expect(unpriced.score_inputs.rank_n).toBe(0);
    expect(unpriced.score).toBeLessThan(priced.score);
    expect(unpriced.score).toBe(scoreAction(execRow({})).score);
  });

  it("a list with no priced action leaves every exec row where it was", () => {
    expect(
      scoreAction(execRow({ money_at_stake_usd: 740, money_at_stake_max_usd: null })).score_inputs.rank_n,
    ).toBe(0);
  });

  it("advisory steps are unaffected", () => {
    const before = scoreAction({ ...base, impact: 4, position: 2, run_of: 5 });
    const after = scoreAction({
      ...base,
      impact: 4,
      position: 2,
      run_of: 5,
      money_at_stake_usd: null,
      money_at_stake_max_usd: 740,
    });
    expect(after.score).toBe(before.score);
    expect(after.score_inputs.rank_n).toBe(0.75);
  });

  it("records both inputs so the card can say why it is #1", () => {
    const s = scoreAction(execRow({ money_at_stake_usd: 740, money_at_stake_max_usd: MAX }));
    expect(s.score_inputs).toMatchObject({ money_at_stake_usd: 740, money_at_stake_max_usd: 740 });
  });

  it("blocking still wins, and the money term is capped at the rank weight", () => {
    const zero = scoreAction(execRow({ money_at_stake_usd: null, money_at_stake_max_usd: null })).score;
    const max = scoreAction(execRow({ money_at_stake_usd: 10_000_000, money_at_stake_max_usd: MAX })).score;
    expect(max - zero).toBe(15);
  });
});
