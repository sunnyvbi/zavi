import { describe, expect, it } from "vitest";
import { chatTwinOfExec } from "../open-advice";
describe("channel chat audit: dedup edge cases", () => {
  const pause = { exec_class: "meta_ads.set_status", exec_payload: { object_id: "120000000000001", status: "PAUSED", name: "Brand Search" } };
  it("drops a duplicate pause when its explanation mentions wasted spend", () => {
    expect(chatTwinOfExec({ title: 'Pause "Brand Search"', stepBody: "Stop wasting spend on this campaign.", evidence: [] }, pause)).toBe(true);
  });
  it("keeps different budget amounts", () => {
    const budget = { exec_class: "google_ads.budget_change", exec_payload: { campaign_id: "555555555", name: "Search core", origin: "user_initiated_chat", new_daily_budget: 40, current_daily_budget: 50 } };
    expect(chatTwinOfExec({ title: 'Lower the "Search core" daily budget to $10', evidence: [] }, budget)).toBe(false);
  });
  it("keeps a card that names another campaign as well as the already proposed one", () => {
    expect(chatTwinOfExec({ title: "Pause campaigns 120000000000001 and 120000000000002", evidence: [] }, pause)).toBe(false);
    expect(chatTwinOfExec({ title: 'Pause "Brand Search" and "Retargeting"', evidence: [] }, pause)).toBe(false);
    expect(chatTwinOfExec({ title: "Pause Brand Search and Retargeting", evidence: [] }, pause)).toBe(false);
  });
  it("does not equate a dollar request with a nested non-USD account budget", () => {
    const budget = { exec_class: "x_ads.update_campaign", exec_payload: { campaign_id: "555555555", name: "Search core", changes: { daily_budget: 40 }, before: { daily_budget: 50, currency: "GBP" } } };
    expect(chatTwinOfExec({ title: 'Lower "Search core" budget to $40', evidence: [] }, budget)).toBe(false);
  });
  it("does not equate a mixed-currency amount with a USD budget", () => {
    const budget = { exec_class: "google_ads.budget_change", exec_payload: { campaign_id: "555555555", name: "Search core", new_daily_budget: 40, current_daily_budget: 50, currency: "USD" } };
    expect(chatTwinOfExec({ title: 'Lower "Search core" budget to $40 CAD', evidence: [] }, budget)).toBe(false);
  });
});
