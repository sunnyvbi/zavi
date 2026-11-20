import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { evaluateXAd } from "./x-ad-policy";
import type { UnattendedAction, UnattendedFacts } from "./unattended-policy";

const body = {
  account_id: "a1",
  funding_instrument_id: "f1",
  name: "Bounded test",
  currency: "USD",
  objective: "REACH",
  daily_budget: 5,
  total_budget: 25,
  tweet_ids: ["123"],
  locations: [{ id: "abc", name: "United States" }],
  start_time: "2099-01-01T00:00:00Z",
  end_time: "2099-01-06T00:00:00Z",
  launch: "ACTIVE",
  rationale: "Test existing post",
  summary: "Create test",
  exact_change: { rows: [] },
};
const action: Extract<UnattendedAction, { kind: "ad" }> = {
  kind: "ad",
  exec_class: "x_ads.create_campaign",
  payload: body,
  source: { table: "channel_actions", id: "action1", run_id: "run1" },
};
const facts: UnattendedFacts = {
  channelAutorun: true,
  spendUpUnderBudget: true,
  refsResolved: true,
  openAdvice: "clear",
  goal: { present: true, numberTrusted: true },
  x: { ready: true },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});
describe("X Ads bounded autopilot", () => {
  it("requires the founder for a measured organic-trial winner even with Autopilot enabled", () => {
    const verdict = evaluateXAd({ ...action, payload: { ...body, origin: "x_organic_trial" } }, facts);
    expect(verdict.verdict).toBe("ask_founder");
    expect(verdict.reasons).toContain("organic_trial_needs_founder");
  });
  it("permits a bounded new campaign only with all governing facts", () =>
    expect(evaluateXAd(action, facts)).toEqual({
      verdict: "allow",
      reasons: [],
    }));
  it("holds a generated promoted-only post for the founder, however bounded the campaign", () =>
    expect(evaluateXAd({ ...action, payload: { ...body, tweet_ids: [], new_post: { text: "Book a car in two taps." } } }, facts)).toEqual({
      verdict: "ask_founder",
      reasons: ["x_new_post_needs_founder"],
    }));
  it.each([
    "delete_campaign",
    "delete_ad_group",
    "remove_promoted_ad",
    "remove_target",
  ])("never automates destructive operation %s", (operation) =>
    expect(
      evaluateXAd(
        {
          ...action,
          exec_class: "x_ads.manage_objects",
          payload: { request: { operation } },
        },
        facts,
      ).verdict,
    ).toBe("ask_founder"),
  );
  it.each(["spendUpUnderBudget", "channelAutorun", "refsResolved"] as const)(
    "fails closed when %s is missing",
    (key) =>
      expect(evaluateXAd(action, { ...facts, [key]: null }).verdict).toBe(
        "ask_founder",
      ),
  );
  it.each([
    { total_budget: null },
    { end_time: null },
    { end_time: "2099-02-02T00:00:00Z" },
    { locations: [] },
    { currency: "INR" },
    { origin: "user_initiated_chat" },
    { objective: "WEBSITE_CLICKS" },
  ])("holds incomplete or unsafe launch %j", (change) =>
    expect(
      evaluateXAd({ ...action, payload: { ...body, ...change } }, facts)
        .verdict,
    ).toBe("ask_founder"),
  );
  it("requires fresh permissions, funding and a trusted goal", () => {
    expect(evaluateXAd(action, { ...facts, x: { ready: false } }).verdict).toBe(
      "ask_founder",
    );
    expect(evaluateXAd(action, { ...facts, goal: null }).verdict).toBe(
      "ask_founder",
    );
  });
});
