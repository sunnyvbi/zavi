import { describe, it, expect } from "vitest";
import { DAYS_PER_MONTH } from "@/services/channels/money-at-stake";
import { computeAlarms, isOffPace, isoWeek, clampNextReviewDays, channelViews, channelActionActor, type WatchState, type WatchGoal } from "../cgo-watch";

const NOW = new Date("2026-09-26T14:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function goal(over: Partial<WatchGoal> = {}): WatchGoal {
  return {
    id: "g1",
    objective: "Get 20 signups",
    target_metric: "signups",
    target_value: 20,
    current_value: 10,
    baseline_value: 0,
    due_date: "2026-10-26",
    status: "active",
    priority: 50,
    measurement_mode: "manual_reported",
    current_value_at: daysAgo(1),
    created_at: daysAgo(30),
    ...over,
  };
}

function state(over: Partial<WatchState> = {}): WatchState {
  return {
    goals: [goal()],
    pending: [],
    recent: [],
    channels: [],
    notes: [
      {
        id: "n1",
        kind: "scheduled",
        saw: [],
        changed: [],
        would_change: [],
        need: [],
        alarm_keys: [],
        next_review_at: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(),
        created_at: daysAgo(4),
      },
    ],
    founder_last_active_at: daysAgo(1),
    last_check_run_at: null,
    approvals_14d: 0,
    rejections_14d: 0,
    metrics: [],
    ...over,
  };
}

describe("computeAlarms", () => {
  it("a healthy tenant whose check-in is days away is not woken", () => {
    expect(computeAlarms(state(), NOW)).toMatchObject({ wake: false, reasons: [] });
  });

  it("no note yet, or the check-in date reached: a scheduled review", () => {
    expect(computeAlarms(state({ notes: [] }), NOW)).toMatchObject({ wake: true, kind: "scheduled", reasons: ["review_due"] });
    const due = state();
    due.notes[0].next_review_at = daysAgo(0.1);
    expect(computeAlarms(due, NOW)).toMatchObject({ wake: true, kind: "scheduled" });
  });

  it("2-hourly budget-review notes never push the founder's check-in out", () => {
    const s = state();
    s.notes[0].next_review_at = daysAgo(0.1);
    s.notes.unshift({
      id: "nb",
      kind: "alarm",
      saw: [],
      changed: [],
      would_change: [],
      need: [],
      alarm_keys: ["ad_budget_review"],
      next_review_at: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
      created_at: daysAgo(0.05),
    });
    expect(computeAlarms(s, NOW)).toMatchObject({ wake: true, kind: "scheduled", reasons: ["review_due"] });
  });

  it("a card untouched 5+ days wakes cgo once: not again once a note recorded it", () => {
    const s = state({ pending: [{ id: "a1", channel_slug: "reddit_organic", status: "pending", proposed_at: daysAgo(6) }] });
    const first = computeAlarms(s, NOW);
    expect(first).toMatchObject({ wake: true, kind: "alarm", reasons: ["cards_untouched"] });
    s.notes[0].alarm_keys = first.keys;
    expect(computeAlarms(s, NOW).wake).toBe(false);
    expect(computeAlarms(state({ pending: [{ id: "a2", channel_slug: "seo", status: "pending", proposed_at: daysAgo(4) }] }), NOW).wake).toBe(false);
  });

  it("a NEW card in a channel already alarmed this week does not wake cgo again (per channel per week, not per card)", () => {
    const s = state({ pending: [{ id: "a1", channel_slug: "reddit_organic", status: "pending", proposed_at: daysAgo(6) }] });
    const first = computeAlarms(s, NOW);
    expect(first.keys).toEqual(["untouched:reddit_organic:2026-W39"]);
    s.notes[0].alarm_keys = first.keys;
    s.pending.push({ id: "a2", channel_slug: "reddit_organic", status: "pending", proposed_at: daysAgo(5) });
    expect(computeAlarms(s, NOW)).toMatchObject({ wake: false, keys: ["untouched:reddit_organic:2026-W39"] });
    s.pending.push({ id: "a3", channel_slug: "seo", status: "pending", proposed_at: daysAgo(5) });
    expect(computeAlarms(s, NOW)).toMatchObject({ wake: true, reasons: ["cards_untouched"] });
    const nextWeek = new Date(NOW.getTime() + 7 * 86_400_000);
    s.notes[0].next_review_at = new Date(nextWeek.getTime() + 86_400_000).toISOString();
    s.notes[0].alarm_keys = ["untouched:reddit_organic:2026-W39", "untouched:seo:2026-W39"];
    expect(computeAlarms(s, nextWeek).keys).toContain("untouched:reddit_organic:2026-W40");
  });

  it("a channel or goal cgo already has an open question about does not wake it", () => {
    const pending = [1, 2, 3].map((i) => ({ id: `a${i}`, channel_slug: "reddit_organic", status: "pending", proposed_at: daysAgo(6) }));
    expect(computeAlarms(state({ pending }), NOW).reasons).toEqual(["cards_untouched"]);
    expect(computeAlarms(state({ pending, open_topics: ["channel:reddit-organic"] }), NOW).wake).toBe(false);
    expect(computeAlarms(state({ goals: [goal({ current_value: 2 })] }), NOW).reasons).toEqual(["goal_off_pace"]);
    expect(computeAlarms(state({ goals: [goal({ current_value: 2 })], open_topics: ["goal:g1"] }), NOW).wake).toBe(false);
  });

  it("channelViews marks a channel the founder rejected cards on, not one only cgo rejected", () => {
    const s = state({ channels: [{ channel_slug: "seo", plan_selected: true, plan_selected_set_by: "plan", autorun: false, last_run_at: null, founder_seen_at: null, cgo_reason: null, cgo_set_at: null }], founder_rejected_channels: ["seo"] });
    expect(channelViews(s, NOW)[0].founder_rejected).toBe(true);
    expect(channelViews({ ...s, founder_rejected_channels: [] }, NOW)[0].founder_rejected).toBe(false);
  });

  it("channelViews leaves a retired channel out of the plan cgo reviews", () => {
    const ch = (channel_slug: string) => ({ channel_slug, plan_selected: true, plan_selected_set_by: "founder", autorun: false, last_run_at: null, founder_seen_at: null, cgo_reason: null, cgo_set_at: null });
    const views = channelViews(state({ channels: [ch("blog"), ch("seo")] }), NOW);
    expect(views.map((v) => v.channel_slug)).toEqual(["seo"]);
    const pending = [{ id: "b1", channel_slug: "blog", status: "pending", proposed_at: daysAgo(1) }];
    const blog = channelViews(state({ channels: [{ ...ch("blog"), autorun: true }], pending, autopilot: { enabled: true, on_at: "2026-10-12T09:00:00Z" } }), NOW)[0];
    expect(blog).toMatchObject({ channel_slug: "blog", in_plan: false, cgo_may_run: false });
  });

  it("channelViews: cgo_may_run is the shared rule (Ravi 2026-10-12), not the stored column", () => {
    const ch = (channel_slug: string, over: Record<string, unknown> = {}) => ({ channel_slug, plan_selected: true, plan_selected_set_by: "plan", autorun: false, last_run_at: null, founder_seen_at: null, cgo_reason: null, cgo_set_at: null, ...over });
    const channels = [
      ch("seo", { autorun_set_by: "plan" }),
      ch("email_marketing", { autorun_set_by: "founder", autorun_set_at: "2026-10-12T10:00:00Z" }),
      ch("meta_ads", { autorun_set_by: "founder", autorun_set_at: "2026-10-01T10:00:00Z" }),
    ];
    const may = (autopilot: WatchState["autopilot"]) => Object.fromEntries(channelViews(state({ channels, autopilot }), NOW).map((v) => [v.channel_slug, v.cgo_may_run]));
    expect(may({ enabled: true, on_at: "2026-10-12T09:00:00Z" })).toEqual({ seo: true, email_marketing: false, meta_ads: true });
    expect(may({ enabled: false, on_at: null })).toEqual({ seo: false, email_marketing: false, meta_ads: false });
    const storedOn = [ch("seo", { autorun: true, autorun_set_by: "founder" })];
    expect(channelViews(state({ channels: storedOn, autopilot: { enabled: false, on_at: null } }), NOW)[0].cgo_may_run).toBe(false);
    expect(may(null)).toEqual({ seo: false, email_marketing: false, meta_ads: false });
  });

  it("channelViews marks a channel cgo is waiting on the founder about", () => {
    const s = state({ channels: [{ channel_slug: "seo", plan_selected: true, plan_selected_set_by: "plan", autorun: false, last_run_at: null, founder_seen_at: null, cgo_reason: null, cgo_set_at: null }], open_topics: ["channel:seo"] });
    expect(channelViews(s, NOW)[0].blocked_on_you).toBe(true);
    expect(channelViews({ ...s, open_topics: [] }, NOW)[0].blocked_on_you).toBe(false);
  });

  it("isoWeek: Monday-start ISO weeks, across a year boundary", () => {
    expect(isoWeek(new Date("2026-09-26T14:00:00Z"))).toBe("2026-W39");
    expect(isoWeek(new Date("2026-09-28T00:00:00Z"))).toBe("2026-W40");
    expect(isoWeek(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
  });

  it("a channel cgo paused never wakes cgo: its old cards are ignored (a founder-paused one still counts)", () => {
    const pending = [1, 2, 3].map((i) => ({ id: `p${i}`, channel_slug: "reddit_organic", status: "pending", proposed_at: daysAgo(6) }));
    const chan = (cgo_reason: string | null) => [
      { channel_slug: "reddit_organic", plan_selected: false, plan_selected_set_by: "plan", autorun: false, last_run_at: null, founder_seen_at: daysAgo(1), cgo_reason, cgo_set_at: cgo_reason ? daysAgo(2) : null },
    ];
    expect(computeAlarms(state({ pending, channels: chan("Nothing acted on.") }), NOW).wake).toBe(false);
    expect(computeAlarms(state({ pending, channels: chan(null) }), NOW).reasons).toEqual(["cards_untouched", "seen_not_acted"]);
  });

  it("3 cards opened and not acted on is an alarm; 2 is not; opened BEFORE they arrived does not count", () => {
    const pending = [1, 2, 3].map((i) => ({ id: `a${i}`, channel_slug: "seo", status: "pending", proposed_at: daysAgo(2) }));
    const chan = (seenDaysAgo: number) => [{ channel_slug: "seo", plan_selected: true, plan_selected_set_by: "plan", autorun: false, last_run_at: null, founder_seen_at: daysAgo(seenDaysAgo), cgo_reason: null, cgo_set_at: null }];
    expect(computeAlarms(state({ pending, channels: chan(1) }), NOW).reasons).toEqual(["seen_not_acted"]);
    expect(computeAlarms(state({ pending: pending.slice(0, 2), channels: chan(1) }), NOW).wake).toBe(false);
    expect(computeAlarms(state({ pending, channels: chan(3) }), NOW).wake).toBe(false);
  });

  it("a founder quiet for 7+ days; with no activity at all the clock starts at the oldest goal", () => {
    expect(computeAlarms(state({ founder_last_active_at: daysAgo(8) }), NOW).reasons).toEqual(["founder_silent"]);
    expect(computeAlarms(state({ founder_last_active_at: null }), NOW).reasons).toEqual(["founder_silent"]);
    expect(computeAlarms(state({ founder_last_active_at: daysAgo(6) }), NOW).wake).toBe(false);
  });

  it("goal behind pace or over", () => {
    expect(computeAlarms(state({ goals: [goal({ current_value: 2 })] }), NOW).reasons).toEqual(["goal_off_pace"]);
    expect(computeAlarms(state({ goals: [goal({ current_value: 20 })] }), NOW).reasons).toEqual(["goal_over"]);
  });

  it("autopilot off: only the check-in date wakes cgo, never an alarm", () => {
    const s = state({ founder_last_active_at: daysAgo(20), pending: [{ id: "a1", channel_slug: "seo", status: "pending", proposed_at: daysAgo(9) }] });
    expect(computeAlarms(s, NOW, { autopilot: false }).wake).toBe(false);
    expect(computeAlarms({ ...s, notes: [] }, NOW, { autopilot: false })).toMatchObject({ wake: true, reasons: ["review_due"] });
  });
});

describe("a review the check started but that wrote no note", () => {
  it("is waited for (up to a week) instead of paid for again every day", () => {
    const due = state({ notes: [] });
    expect(computeAlarms({ ...due, last_check_run_at: daysAgo(2) }, NOW).wake).toBe(false);
    expect(computeAlarms({ ...due, last_check_run_at: daysAgo(8) }, NOW).wake).toBe(true);
    const done = state();
    done.notes[0].next_review_at = daysAgo(0.1);
    expect(computeAlarms({ ...done, last_check_run_at: daysAgo(5) }, NOW).wake).toBe(true);
  });
});

describe("isOffPace", () => {
  it("judges only after a quarter of the time, toward the target from the baseline (either direction)", () => {
    expect(isOffPace(goal({ created_at: daysAgo(2), current_value: 0 }), NOW)).toBe(false);
    expect(isOffPace(goal({ current_value: 6 }), NOW)).toBe(true);
    expect(isOffPace(goal({ current_value: 9 }), NOW)).toBe(false);
    expect(isOffPace(goal({ target_metric: "churn", baseline_value: 10, target_value: 4, current_value: 9 }), NOW)).toBe(true);
    expect(isOffPace(goal({ target_metric: "churn", baseline_value: 10, target_value: 4, current_value: 7 }), NOW)).toBe(false);
  });
  it("a typed goal that could be a running number or a period total is off pace only when off on both lines", () => {
    const twoWay = { baseline_value: 100, target_value: 200 };
    expect(isOffPace(goal({ ...twoWay, current_value: 120 }), NOW)).toBe(false);
    expect(isOffPace(goal({ ...twoWay, current_value: 40 }), NOW)).toBe(true);
    expect(isOffPace(goal({ ...twoWay, current_value: 120, value_kind: "gauge" }), NOW)).toBe(true);
  });
  it("an old typed number raises no alarm, and a number is judged as of the day it describes", () => {
    expect(isOffPace(goal({ current_value: 6, current_value_at: daysAgo(10) }), NOW)).toBe(false);
    const atRead = goal({ measurement_mode: "auto", created_at: "2026-09-16T08:00:00Z", due_date: "2026-09-29", current_value: 10, current_value_at: daysAgo(2) });
    expect(isOffPace(atRead, NOW)).toBe(false);
  });
});

describe("clampNextReviewDays / channelViews", () => {
  it("clamps to 2-14, 7 by default", () => {
    expect([clampNextReviewDays(3), clampNextReviewDays(40), clampNextReviewDays(0), clampNextReviewDays(undefined), clampNextReviewDays(4.6)]).toEqual([3, 14, 2, 7, 5]);
  });

  it("per channel: what it produced and what the founder did with it", () => {
    const v = channelViews(
      state({
        channels: [{ channel_slug: "seo", plan_selected: true, plan_selected_set_by: "plan", autorun: false, last_run_at: daysAgo(1), founder_seen_at: daysAgo(1), cgo_reason: null, cgo_set_at: null }],
        pending: [{ id: "p1", channel_slug: "seo", status: "pending", proposed_at: daysAgo(3) }],
        recent: [
          { id: "p1", channel_slug: "seo", status: "pending", proposed_at: daysAgo(3) },
          { id: "r1", channel_slug: "seo", status: "acted", proposed_at: daysAgo(5) },
          { id: "r2", channel_slug: "seo", status: "rejected", proposed_at: daysAgo(6) },
        ],
      }),
      NOW,
    );
    expect(v).toEqual([
      expect.objectContaining({
        channel_slug: "seo",
        in_plan: true,
        last_14_days: { proposed: 3, acted: 1, rejected: 1, snoozed: 0, still_waiting: 1 },
        oldest_waiting_days: 3,
        opened_but_not_acted: 1,
      }),
    ]);
  });
});

describe("channelViews: the channel's own open cards (open_cards)", () => {
  it("shows up to 5 per channel, oldest first, with what each is about and a one-line step", () => {
    const pending = Array.from({ length: 7 }, (_, i) => ({
      id: `a-${i}`,
      channel_slug: "meta_ads",
      status: "pending",
      proposed_at: daysAgo(10 - i),
      title: i === 0 ? "Rebuild “40% to Turo” as a conversion campaign" : `Card ${i}`,
      action_type: "fix",
      exec_class: i === 1 ? "meta_ads.set_status" : null,
      exec_payload: i === 1 ? { object_id: "120259468814150059", name: "40% to Turo" } : null,
      step_body: "x".repeat(400),
      subject_refs: null,
    }));
    const [v] = channelViews(state({ pending, channels: [] }), NOW);
    expect(v.open_cards).toHaveLength(5);
    expect(v.open_cards![0]).toMatchObject({ action_id: "a-0", executable: false, about: ['"40% to Turo"'], waiting_days: 10 });
    expect(v.open_cards![0].step.length).toBeLessThanOrEqual(160);
    expect(v.open_cards![1]).toMatchObject({ action_id: "a-1", executable: true, about: ['"40% to Turo"', "120259468814150059"] });
  });
});

describe("open_cards carry exec state and money at stake", () => {
  const REFUSAL = `Google Ads googleAds:mutate failed: 400 {"error":{"status":"INVALID_ARGUMENT","details":[{"errors":[{"errorCode":{"mutateError":"MUTATE_NOT_ALLOWED"}}]}]}}`;
  const card = (over: Record<string, unknown>) => ({
    id: "c1", channel_slug: "google_ads", status: "pending", proposed_at: daysAgo(1), title: "t", action_type: "update_ad",
    step_body: "s", subject_refs: null, exec_class: null, exec_payload: null, exec_status: null, exec_result: null, stake: null, ...over,
  });
  const view = (over: Record<string, unknown>) => channelViews(state({ pending: [card(over)], channels: [] }), NOW)[0]!.open_cards![0]!;

  it("a failed create shows the bucket and the platform code, and no money", () => {
    expect(view({ exec_class: "google_ads.create_campaign", exec_payload: { name: "x" }, exec_status: "failed", exec_result: { error: REFUSAL } }))
      .toMatchObject({ exec: { status: "failed", bucket: "blocked_on_us", code: "MUTATE_NOT_ALLOWED" }, money_at_stake_usd: null });
  });
  it("a stamped verdict is read as stamped; a machine code stands in when there is no platform code", () => {
    expect(view({ exec_class: "meta_ads.set_status", exec_payload: {}, exec_status: "failed", exec_result: { error: "x", code: "meta_ads_token_expired", bucket: "needs_founder", fix: "reconnect", platform_code: null } }).exec)
      .toEqual({ status: "failed", bucket: "needs_founder", code: "meta_ads_token_expired" });
  });
  it("a fresh budget raise: no exec state, money is the monthly delta", () => {
    const v = view({
      exec_class: "google_ads.update_campaign_budget",
      exec_payload: { campaign_id: "1", daily_budget_usd: 40, expected_current_daily_budget_usd: 25, rationale: "r", over_cap: false },
    });
    expect(v.exec).toBeNull();
    expect(v.money_at_stake_usd).toBe(Math.round(15 * DAYS_PER_MONTH));
  });
  it("an in-flight change shows its status with no bucket", () => {
    expect(view({ exec_class: "meta_ads.set_status", exec_payload: {}, exec_status: "dispatching" }).exec).toEqual({ status: "dispatching", bucket: null, code: null });
  });
});

describe("blocked_on_us: cards the platform refused stay visible to cgo", () => {
  it("lists the channel's refused cards, newest first, with the code; absent when none", () => {
    const recent = [
      { id: "r1", channel_slug: "youtube_ads", status: "stale", proposed_at: daysAgo(3), title: "Create the Bay Area YouTube campaign", exec_status: "failed", exec_bucket: "blocked_on_us", exec_code: "UNKNOWN,MUTATE_NOT_ALLOWED,RESOURCE_NOT_FOUND" },
      { id: "r2", channel_slug: "youtube_ads", status: "stale", proposed_at: daysAgo(1), title: "Create it again", exec_status: "failed", exec_bucket: "blocked_on_us", exec_code: null },
      { id: "r3", channel_slug: "youtube_ads", status: "pending", proposed_at: daysAgo(1), title: "Temp", exec_status: "failed", exec_bucket: "temporary", exec_code: null },
      { id: "r4", channel_slug: "meta_ads", status: "acted", proposed_at: daysAgo(1), title: "Done", exec_status: "executed", exec_bucket: null, exec_code: null },
    ];
    const views = channelViews(state({ pending: [], recent, channels: [] }), NOW);
    const yt = views.find((v) => v.channel_slug === "youtube_ads")!;
    expect(yt.blocked_on_us).toEqual([
      { action_id: "r2", title: "Create it again", code: null },
      { action_id: "r1", title: "Create the Bay Area YouTube campaign", code: "UNKNOWN,MUTATE_NOT_ALLOWED,RESOURCE_NOT_FOUND" },
    ]);
    expect(yt.open_cards).toEqual([]);
    expect(views.find((v) => v.channel_slug === "meta_ads")).not.toHaveProperty("blocked_on_us");
  });
});

describe("who closed a channel card (attribution)", () => {
  it("a card closed by a system event is never the founder's", () => {
    expect(channelActionActor({ approved_by: null, approved_by_source: null }, "system")).toBe("system");
    expect(channelActionActor({ approved_by: "owner-uid", approved_by_source: "cgo" }, "founder")).toBe("cgo");
    expect(channelActionActor({}, "founder")).toBe("founder");
    expect(channelActionActor({}, "channel_run")).toBe("channel");
    expect(channelActionActor({ approved_by: "u1" }, null)).toBe("founder");
    expect(channelActionActor({}, undefined)).toBe("unknown");
  });

  it("the channel view counts closed cards by who closed them", () => {
    const [v] = channelViews(
      state({
        recent: [
          { id: "r1", channel_slug: "meta_ads", status: "acted", proposed_at: daysAgo(2), by: "system" },
          { id: "r2", channel_slug: "meta_ads", status: "rejected", proposed_at: daysAgo(3), by: "founder" },
          { id: "r3", channel_slug: "meta_ads", status: "acted", proposed_at: daysAgo(3) },
          { id: "r4", channel_slug: "meta_ads", status: "pending", proposed_at: daysAgo(1) },
        ],
      }),
      NOW,
    );
    expect(v.closed_by).toEqual({ system: 1, founder: 1, unknown: 1 });
  });
});
