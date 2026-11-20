import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  flag: vi.fn(async () => "on" as "on" | "off" | "unreadable"),
  move: vi.fn(async () => null as unknown),
  side: vi.fn(() => "adds"),
  fit: vi.fn(async () => ({ kind: "fits" }) as unknown),
  group: vi.fn(() => null as string | null),
  legs: vi.fn(async () => [] as unknown[]),
}));
vi.mock("@/services/tenant-client", () => ({ asTenantId: (t: string) => t, tenantRpc: vi.fn() }));
vi.mock("@/services/decisions/ad-budget-choice-flag", () => ({ adBudgetChoiceState: h.flag }));
vi.mock("@/services/growth/move-card", () => ({ moveView: h.move }));
vi.mock("@/services/growth/move-group", () => ({ legSide: h.side, moveGroupOf: h.group, readMoveGroup: h.legs }));
vi.mock("@/services/decisions/ad-month-counter", () => ({ readRaiseFit: h.fit }));

import { budgetChoiceNote } from "../budget-choice";

const raise = { id: "d-1", decision_class: "google_ads.update_campaign_budget_review", body: {} };
const count = { budget_id: "b", month_start: "2026-10-01", monthly_usd: 27_000, month_cap_usd: 27_000, days_left: 8, spent_usd: 18_000, creator_usd: 0, running_daily_usd: 1_100, pending_daily_usd: 0, projection_usd: 26_800 };

beforeEach(() => {
  h.flag.mockResolvedValue("on");
  h.group.mockReturnValue(null);
  h.legs.mockResolvedValue([]);
  h.move.mockResolvedValue(null);
  h.side.mockReturnValue("adds");
  h.fit.mockResolvedValue({ kind: "fits" });
});

describe("budgetChoiceNote", () => {
  it("must-catch: an over-budget raise names the month's numbers and sends the founder to Zavi", async () => {
    h.fit.mockResolvedValue({ kind: "over", count, with_usd: 27_040, over_by_usd: 40, raise_to_usd: 27_100, daily_limit_usd: null, daily_limit_to_usd: null });
    const note = await budgetChoiceNote("t-1", raise);
    expect(note).toContain("$27,040");
    expect(note).toContain("$27,000");
    expect(note).toMatch(/in Zavi\.$/);
  });

  it("a line of a move of 2 or more says how many changes and sends the founder to Zavi", async () => {
    h.move.mockResolvedValue({ key: "g", still_filing: false, lines: [{}, {}, {}] });
    expect(await budgetChoiceNote("t-1", { ...raise, decision_class: "meta_ads.set_status_review" })).toContain("one of 3 changes");
  });

  it("an unreadable budget, or a failed read, never leaves an Approve that would be refused", async () => {
    h.fit.mockResolvedValue({ kind: "unreadable", why: "read" });
    expect(await budgetChoiceNote("t-1", raise)).toContain("can't check your ad budget");
    h.move.mockRejectedValue(new Error("db down"));
    expect(await budgetChoiceNote("t-1", raise)).toContain("can't check your ad budget");
  });

  it("must-not-touch: a raise that fits, a cut, another class, or the switch OFF approve as today", async () => {
    expect(await budgetChoiceNote("t-1", raise)).toBeNull();
    h.side.mockReturnValue("lowers");
    expect(await budgetChoiceNote("t-1", raise)).toBeNull();
    expect(await budgetChoiceNote("t-1", { ...raise, decision_class: "tiktok_ads.update_budget" })).toBeNull();
    h.side.mockReturnValue("adds");
    h.fit.mockResolvedValue({ kind: "over", count, with_usd: 27_040, over_by_usd: 40, raise_to_usd: 27_100, daily_limit_usd: null, daily_limit_to_usd: null });
    h.flag.mockResolvedValue("off");
    expect(await budgetChoiceNote("t-1", raise)).toBeNull();
  });

  it("must-catch (Codex F1): an unreadable switch is never OFF; the card says Zavi can't check, never Approve", async () => {
    h.flag.mockResolvedValue("unreadable");
    h.fit.mockResolvedValue({ kind: "over", count, with_usd: 27_040, over_by_usd: 40, raise_to_usd: 27_100, daily_limit_usd: null, daily_limit_to_usd: null });
    expect(await budgetChoiceNote("t-1", raise)).toContain("can't check your ad budget");
  });

  it("must-catch (Codex F2): a cut whose move has a channel-card leg (no move card) is still sent to Zavi", async () => {
    h.move.mockResolvedValue(null);
    h.side.mockReturnValue("lowers");
    h.group.mockReturnValue("run-root");
    h.legs.mockResolvedValue([
      { table: "decisions", id: "d-1", exec_class: "meta_ads.update_ad_set_budget_review" },
      { table: "channel_actions", id: "a-1", exec_class: "google_ads.update_campaign_budget" },
    ]);
    expect(await budgetChoiceNote("t-1", { ...raise, decision_class: "meta_ads.update_ad_set_budget_review" })).toBe("This is one of 2 changes in a move. Approve the move in Zavi.");
    expect(h.legs).toHaveBeenCalledWith("t-1", "run-root");
  });

  it("must-catch (Codex F3): in a budget's first, prorated month the sentence names this month's cap, not the monthly budget", async () => {
    h.fit.mockResolvedValue({ kind: "over", count: { ...count, month_cap_usd: 13_500 }, with_usd: 14_000, over_by_usd: 500, raise_to_usd: 27_100, daily_limit_usd: null, daily_limit_to_usd: null });
    const note = await budgetChoiceNote("t-1", raise);
    expect(note).toContain("$14,000");
    expect(note).toContain("$13,500 October budget");
    expect(note).not.toContain("$27,000");
  });
});
