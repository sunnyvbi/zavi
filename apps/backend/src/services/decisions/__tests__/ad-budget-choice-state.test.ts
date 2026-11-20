import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ answer: { data: null, error: null } as { data: unknown; error: unknown }, throws: false }));
vi.mock("@/services/tenant-client", () => ({
  globalClient: () => {
    if (h.throws) throw new Error("no client");
    const b = { select: () => b, eq: () => b, maybeSingle: async () => h.answer };
    return { from: () => b };
  },
}));

import { adBudgetChoiceEnabled, adBudgetChoiceState } from "../ad-budget-choice-flag";

beforeEach(() => {
  h.answer = { data: { blob: {} }, error: null };
  h.throws = false;
});

describe("adBudgetChoiceState", () => {
  it("absent or true is on; an explicit false is off", async () => {
    expect(await adBudgetChoiceState()).toBe("on");
    h.answer = { data: { blob: { ad_budget_choice_enabled: false } }, error: null };
    expect(await adBudgetChoiceState()).toBe("off");
  });

  it("must-catch: a read error or a thrown client is unreadable, while adBudgetChoiceEnabled keeps its fail-to-off answer", async () => {
    h.answer = { data: null, error: { message: "timeout" } };
    expect(await adBudgetChoiceState()).toBe("unreadable");
    expect(await adBudgetChoiceEnabled()).toBe(false);
    h.throws = true;
    expect(await adBudgetChoiceState()).toBe("unreadable");
  });
});
