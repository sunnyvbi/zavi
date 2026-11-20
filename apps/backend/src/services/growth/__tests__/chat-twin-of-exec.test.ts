import { describe, it, expect } from "vitest";
import { chatTwinOfExec, twinDirection } from "@/services/growth/open-advice";

const step = (title: string, body = "") => ({ title, stepBody: body, evidence: [] });

describe("twinDirection", () => {
  it("reads the change off the payload, for classes the unattended classifier does not cover", () => {
    expect(twinDirection({ exec_class: "x_ads.set_status", exec_payload: { campaign_id: "123456789", status: "PAUSED" } })).toBe("down");
    expect(twinDirection({ exec_class: "linkedin_ads.set_status", exec_payload: { campaign_id: "123456789", status: "PAUSED" } })).toBe("down");
    expect(twinDirection({ exec_class: "linkedin_ads.resume_campaign", exec_payload: { campaign_id: "123456789" } })).toBe("up");
    expect(
      twinDirection({ exec_class: "google_ads.budget_change", exec_payload: { campaign_id: "123456789", origin: "user_initiated_chat", new_daily_budget: 40, current_daily_budget: 50 } }),
    ).toBe("down");
    expect(twinDirection({ exec_class: "linkedin_ads.launch_campaign", exec_payload: { name: "Spring launch" } })).toBe("create");
    expect(
      twinDirection({ exec_class: "x_ads.update_campaign", exec_payload: { campaign_id: "1", changes: { daily_budget: 40 }, before: { daily_budget: 50 } } }),
    ).toBe("down");
    expect(
      twinDirection({ exec_class: "x_ads.manage_objects", exec_payload: { request: { changes: { entity_status: "PAUSED" } } } }),
    ).toBe("down");
  });
});

describe("chatTwinOfExec", () => {
  const pause = { exec_class: "meta_ads.set_status", exec_payload: { object_id: "120000000000001", status: "PAUSED", name: "Brand Search" } };

  it("drops the step that repeats the proposed pause", () => {
    expect(chatTwinOfExec(step('Pause "Brand Search"', "No sales in 14 days."), pause)).toBe(true);
  });

  it("keeps a different change on the same object in the same direction", () => {
    expect(chatTwinOfExec(step('Lower the daily budget on "Brand Search" by 20%'), pause)).toBe(false);
  });

  it("keeps a step about another object, and one that says two things", () => {
    expect(chatTwinOfExec(step('Pause "Retargeting"'), pause)).toBe(false);
    expect(chatTwinOfExec(step('Pause "Brand Search" and cut its budget'), pause)).toBe(false);
  });

  it("matches an X pause and a founder-asked Google budget cut", () => {
    const x = { exec_class: "x_ads.set_status", exec_payload: { campaign_id: "987654321", status: "PAUSED", name: "Launch week" } };
    expect(chatTwinOfExec(step('Pause the "Launch week" campaign'), x)).toBe(true);
    const g = { exec_class: "google_ads.budget_change", exec_payload: { campaign_id: "555555555", name: "Search core", origin: "user_initiated_chat", new_daily_budget: 40, current_daily_budget: 50 } };
    expect(chatTwinOfExec(step('Lower the "Search core" daily budget to $40'), g)).toBe(true);
  });

  it("does not drop launches just because their campaign names match", () => {
    const launch = { exec_class: "meta_ads.launch_campaign", exec_payload: { campaign: { name: "Summer sale" } } };
    expect(chatTwinOfExec(step('Launch the "Summer sale" campaign'), launch)).toBe(false);
    expect(chatTwinOfExec(step('Launch the "Winter sale" campaign'), launch)).toBe(false);
  });

  it("matches an X budget cut written as changes/before", () => {
    const x = { exec_class: "x_ads.update_campaign", exec_payload: { campaign_id: "987654321", name: "Launch week", changes: { daily_budget: 40 }, before: { daily_budget: 50 } } };
    expect(chatTwinOfExec(step('Lower the "Launch week" daily budget to $40'), x)).toBe(true);
    expect(chatTwinOfExec(step('Pause the "Launch week" campaign'), x)).toBe(false);
  });
});

it.each(["x_ads", "tiktok_ads", "chatgpt_ads"])("%s does not collapse different budget values or targets", channel => {
  const exec = { exec_class: `${channel}.budget_change`, exec_payload: { campaign_id: "123456789", name: "Search core", current_daily_budget: 50, new_daily_budget: 40 } };
  expect(chatTwinOfExec(step('Lower "Search core" budget to $10'), exec)).toBe(false);
  expect(chatTwinOfExec(step('Lower "Search core" budget to $40'), exec)).toBe(true);
  expect(chatTwinOfExec(step('Lower "Search core" budget by 20%'), exec)).toBe(true);
  expect(chatTwinOfExec(step('Lower "Search core" budget by 40%'), exec)).toBe(false);
  expect(chatTwinOfExec(step('Lower campaign 999999999 "Search core" budget to $40'), exec)).toBe(false);
});

it("does not guess currency, period, percentages or minor-unit budgets", () => {
  const exec = { exec_class: "google_ads.budget_change", exec_payload: { name: "Search core", new_daily_budget: 40, current_daily_budget: 50 } };
  for (const title of ['Lower "Search core" budget to 40%', 'Lower "Search core" budget to $40 per week', 'Lower "Search core" budget to €40']) {
    expect(chatTwinOfExec(step(title), exec)).toBe(false);
  }
  expect(chatTwinOfExec(step('Lower "Search core" budget to $40'), { exec_class: "meta_ads.budget_change", exec_payload: { name: "Search core", daily_budget: 40, current_daily_budget: 50 } })).toBe(false);
});
