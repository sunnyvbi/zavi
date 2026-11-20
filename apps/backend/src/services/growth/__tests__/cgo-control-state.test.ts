import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ budget: null as any, setting: vi.fn(), funding: vi.fn(), projection: vi.fn() }));
vi.mock("@/services/decisions/ad-month-counter", () => ({ readCountedProjection: m.projection }));
vi.mock("@/services/channels/chatgpt-ads/funding-context", () => ({ readChatgptFundingContext: m.funding }));
vi.mock("@/services/decisions/ad-budget", () => ({ readActiveAdBudget: async () => m.budget }));
vi.mock("@/services/settings", () => ({ getBoolSettingStrictResolved: m.setting }));

import { buildCgoControlStateBlock } from "../cgo-control-state";

beforeEach(() => { vi.clearAllMocks(); m.budget = null; m.setting.mockResolvedValue(false); m.funding.mockResolvedValue({ status: "unavailable" }); m.projection.mockResolvedValue(null); });

it("Autopilot off and no budget reads as exactly that — never unknown (the GS21 staging scenario)", async () => {
  const block = await buildCgoControlStateBlock("t1");
  expect(block).toContain("Autopilot: OFF");
  expect(block).toContain("Monthly ad budget: none active");
});

it("Autopilot on with an active budget renders the live numbers", async () => {
  m.setting.mockResolvedValue(true);
  m.budget = { monthly_usd: 25_000, month_cap_usd: 25_000, spent_usd: 2_811.08, held_usd: 5_259.8, creator_spent_usd: 1_000, creator_held_usd: 500, left_usd: 15_429.12, actual_read_at: "2026-10-06T12:07:00Z" };
  const block = await buildCgoControlStateBlock("t1");
  expect(block).toContain("Autopilot: ON");
  expect(block).toContain("$25,000 a month, active");
  expect(block).toContain("$2,811.08 spent");
  expect(block).toContain("$5,259.8 held on ads");
  expect(block).toContain("$1,000 spent and $500 held on creators");
  expect(block).toContain("$15,429.12 left of the $25,000 cap");
  expect(block).toContain("as of 2026-10-06T12:07:00Z");
  expect(block).toContain("reserved capacity, not delivered spend");
});

it("a budget with Autopilot off shows both honestly (they are separate controls)", async () => {
  m.budget = { monthly_usd: 2_400, month_cap_usd: 2_400, spent_usd: 0, held_usd: 0, creator_spent_usd: 0, creator_held_usd: 0, left_usd: 2_400, actual_read_at: null };
  const block = await buildCgoControlStateBlock("t1");
  expect(block).toContain("Autopilot: OFF");
  expect(block).toContain("$2,400 a month, active");
});

it("an unreadable setting soft-fails to null — the run keeps its old prompt", async () => {
  m.setting.mockRejectedValue(new Error("settings down"));
  expect(await buildCgoControlStateBlock("t1")).toBeNull();
});

it("does not mistake a fully reserved ChatGPT wallet for spent money or activation consent", async () => {
  m.funding.mockResolvedValue({ status: "read", balance_cents: 10000, reserved_cents: 10000, available_cents: 0, auto_refill_enabled: false, read_at: "2026-10-08T00:00:00Z" });
  const block = await buildCgoControlStateBlock("t1");
  expect(block).toContain("$100 balance, $100 reserved, $0 available");
  expect(block).toContain("Delivered spend counts in the Growth budget");
  expect(block).toContain("not paid consent");
  expect(m.funding).toHaveBeenCalledWith("t1");
});

it("keeps Growth control state available when ChatGPT wallet evidence is unavailable", async () => {
  expect(await buildCgoControlStateBlock("t1")).toContain("Wallet unreadable; do not infer zero funds");
});

describe("month pace beside left (incident 2026-10-22: \"$3,704 left\" while the brake said \"$186 over cap\")", () => {
  const budget = { monthly_usd: 27_000, month_cap_usd: 27_000, spent_usd: 20_000, held_usd: 3_296, creator_spent_usd: 0, creator_held_usd: 0, left_usd: 3_704, actual_read_at: "2026-10-22T15:00:00Z" };

  it("over the cap: shows where the month lands, by how much, and that Autopilot adds no spend", async () => {
    m.setting.mockResolvedValue(true);
    m.budget = budget;
    m.projection.mockResolvedValue({ budget_id: "b1", projection: { projected_usd: 27_186, month_cap_usd: 27_000, over: true } });
    const block = (await buildCgoControlStateBlock("t1"))!;
    expect(block).toContain("$3,704 left of the $27,000 cap");
    const pace = block.split("\n").find((l) => l.startsWith("- Month pace: "))!;
    expect(pace).toContain("$27,186");
    expect(pace).toContain("$186 over");
    expect(pace).toContain("$27,000 cap");
    expect(pace).toContain("growth__ad_budget_room");
    expect(m.projection).toHaveBeenCalledWith("t1");
  });

  it("under the cap: the room under the cap", async () => {
    m.budget = budget;
    m.projection.mockResolvedValue({ budget_id: "b1", projection: { projected_usd: 25_500.5, month_cap_usd: 27_000, over: false } });
    const pace = (await buildCgoControlStateBlock("t1"))!.split("\n").find((l) => l.startsWith("- Month pace: "))!;
    expect(pace).toContain("$25,500.5");
    expect(pace).toContain("$1,499.5 under");
    expect(pace).not.toContain("over");
  });

  it("an unreadable projection reads as unknown and keeps the rest of the block", async () => {
    m.budget = budget;
    m.projection.mockRejectedValue(new Error("ad_campaigns read failed"));
    const block = (await buildCgoControlStateBlock("t1"))!;
    expect(block).toContain("- Month pace: unknown (the projection could not be read).");
    expect(block).toContain("$3,704 left");
  });

  it("no budget: no pace line and no projection read", async () => {
    expect(await buildCgoControlStateBlock("t1")).not.toContain("Month pace");
    expect(m.projection).not.toHaveBeenCalled();
  });
});
