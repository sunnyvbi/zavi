import { describe, it, expect } from "vitest";
import { adChangeMoney } from "./ad-change-headline";

const on = { object_id: "900", level: "adset", status: "ACTIVE", verified_name: "Zavi · Host Recommended Areas (copy) · zvf101c3e846" };

describe("adChangeMoney: the money a Meta/Google card moves, from its body only", () => {
  it("a switch-on with the object's own budget: $0 -> $60, clean name", () => {
    expect(adChangeMoney("meta_ads.set_status_review", { ...on, object_daily_budget: 60, object_status: "PAUSED", currency: "USD" })).toMatchObject({
      verb: "Turn on",
      name: "Host Recommended Areas (copy)",
      before: 0,
      after: 60,
      delta: 60,
    });
  });

  it("a pause: $100 -> $0", () => {
    const m = adChangeMoney("meta_ads.set_status_review", { object_id: "1", level: "adset", status: "PAUSED", verified_name: "Regular Leads - Ad set", object_daily_budget: 100, object_status: "ACTIVE" });
    expect(m).toMatchObject({ verb: "Pause", name: "Regular Leads - Ad set", before: 100, after: 0, delta: -100 });
  });

  it("must-not-invent: a status card without the object's budget has no amounts", () => {
    expect(adChangeMoney("meta_ads.set_status_review", on)).toMatchObject({ verb: "Turn on", before: null, after: null, delta: null });
  });

  it("a budget card reads its own amounts; Google switch-on is ENABLED", () => {
    expect(adChangeMoney("google_ads.update_campaign_budget_review", { campaign_id: "2", daily_budget_usd: 10, expected_current_daily_budget_usd: 20, verified_name: "Search B" })).toMatchObject({ verb: "Cut", before: 20, after: 10, delta: -10 });
    expect(adChangeMoney("google_ads.set_status_review", { campaign_id: "2", status: "ENABLED", verified_name: "Search B", object_daily_budget: 15, object_status: "PAUSED" })).toMatchObject({ verb: "Turn on", before: 0, after: 15 });
  });

  it("F3: an object already in the asked-for state moves nothing; a status not read shows no amount", () => {
    expect(adChangeMoney("meta_ads.set_status_review", { ...on, object_daily_budget: 60, object_status: "ACTIVE" })).toMatchObject({ before: 60, after: 60, delta: 0 });
    expect(adChangeMoney("google_ads.set_status_review", { campaign_id: "2", status: "ENABLED", verified_name: "S", object_daily_budget: 15, object_status: "ENABLED" })).toMatchObject({ delta: 0 });
    expect(adChangeMoney("meta_ads.set_status_review", { object_id: "1", level: "adset", status: "PAUSED", verified_name: "R", object_daily_budget: 100, object_status: "PAUSED" })).toMatchObject({ delta: 0 });
    expect(adChangeMoney("meta_ads.set_status_review", { ...on, object_daily_budget: 60 })).toMatchObject({ before: null, after: null, delta: null });
    expect(adChangeMoney("meta_ads.set_status_review", { ...on, object_daily_budget: 60, object_status: "ARCHIVED" })).toMatchObject({ delta: null });
  });

  it("any other class is not a money card", () => {
    expect(adChangeMoney("meta_ads.launch_campaign", { name: "x" })).toBeNull();
  });
});
