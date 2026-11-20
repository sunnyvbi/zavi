import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/services/channels/exec-actions", () => ({
  recordChannelExecAction: async (input: Record<string, unknown>) => {
    recorded.push(input);
    return { id: "card-1" };
  },
}));
vi.mock("@/services/channels/exec-emit", () => ({
  isUnstampedCgoRun: async () => false,
  readsAsCgoRun: async () => false,
  resolveChannelExecEmit: async (_channels: unknown, _ctx: unknown, write: (a: Record<string, unknown>) => Promise<string>) =>
    (decision_class: string, body: unknown) => write({ tenant_id: "t-1", run_id: "run-1", channel_slug: "linkedin_ads", decision_class, body }),
}));

import { resolveLinkedInAdsEmit } from "../_exec-action";

const END = Date.parse("2026-11-12T15:30:00Z");
const body = (extra: Record<string, unknown> = {}) => ({
  campaign_binding_id: "11111111-1111-4111-8111-111111111111",
  total_budget_cents: 20_000,
  end_time: END,
  rationale: "Founder asked for $200 over 14 days.",
  snapshot: "a".repeat(64),
  name: "Spring hiring",
  currency: "USD",
  total_budget_usd: 200,
  origin: "user_initiated_chat",
  ...extra,
});

async function cardFor(b: Record<string, unknown>) {
  recorded.length = 0;
  const emit = await resolveLinkedInAdsEmit({ tenant_id: "t-1", run_id: "run-1", emit_decision: async () => "legacy" } as never);
  expect(await emit!("linkedin_ads.launch_campaign", b)).toBe("card-1");
  expect(recorded).toHaveLength(1);
  return recorded[0].body as { change_sentence: string; step: { body: string }; exact_change: { rows: Array<{ item: string; before: string; after: string }> } };
}

describe("LinkedIn launch card a founder approves from chat or Autopilot", () => {
  beforeEach(() => {
    recorded.length = 0;
  });

  it("names the total budget, a readable end date and what counts against the monthly ad budget, with no raw timestamp or internal word", async () => {
    const card = await cardFor(body());
    expect(card.change_sentence).toBe(
      'Launches "Spring hiring" in LinkedIn Ads with a $200.00 total budget for the whole campaign, ending Nov 12, 2026, 3:30 PM UTC. It counts $200.00 against your Zavi monthly ad budget.',
    );
    const text = JSON.stringify(card);
    expect(text).not.toContain("2026-11-12T15:30:00.000Z");
    expect(text).not.toMatch(/snapshot|lifetime cap|Monthly budget: USD/i);
    expect(card.exact_change.rows).toEqual([
      { item: "Campaign", before: "Paused", after: "Active" },
      { item: "Total budget", before: "As set in LinkedIn", after: "$200.00" },
      { item: "End date", before: "As set in LinkedIn", after: "Nov 12, 2026, 3:30 PM UTC" },
    ]);
    expect(card.step.body).toContain("Founder asked for $200 over 14 days.");
  });

  it("shows daily budget, funding and spend so far, and counts only the new money on a relaunch", async () => {
    const card = await cardFor(body({ daily_budget_cents: 1500, funding_source: "wallet", spent_so_far_cents: 5_000 }));
    expect(card.exact_change.rows).toContainEqual({ item: "Daily budget", before: "$15.00", after: "$15.00 (not changed)" });
    expect(card.exact_change.rows).toContainEqual({ item: "Paid from", before: "Your Zavi wallet", after: "Your Zavi wallet" });
    expect(card.exact_change.rows).toContainEqual({ item: "Already spent", before: "$50.00", after: "$50.00" });
    expect(card.change_sentence).toContain("It counts $150.00 against your Zavi monthly ad budget. It has already spent $50.00");
  });

  it("shows a non-USD total in its own currency and the converted amount it counts", async () => {
    const card = await cardFor(body({ currency: "EUR", total_budget_cents: 50_000, total_budget_usd: 625 }));
    expect(card.change_sentence).toContain("with a €500.00 total budget");
    expect(card.change_sentence).toContain("It counts about $625.00, converted using ExchangeRate-API daily rates (https://www.exchangerate-api.com), against your Zavi monthly ad budget.");
    expect(card.exact_change.rows[1]).toEqual({ item: "Total budget", before: "As set in LinkedIn", after: "€500.00" });
  });
});
