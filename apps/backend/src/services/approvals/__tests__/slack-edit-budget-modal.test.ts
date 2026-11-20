import { describe, it, expect } from "vitest";
import {
  isEditableBudgetClass,
  readProposedDailyBudget,
  buildEditBudgetModal,
  buildApprovalBlocks,
  EDIT_CALLBACK_ID,
  EDIT_BUDGET_ACTION_ID,
  SLACK_ACTION_EDIT,
} from "../slack-approval-blocks";

describe("isEditableBudgetClass", () => {
  it("true for the two meta_ads budget classes only", () => {
    expect(isEditableBudgetClass("meta_ads.update_ad_set_budget")).toBe(true);
    expect(isEditableBudgetClass("meta_ads.update_ad_set_budget_review")).toBe(true);
    expect(isEditableBudgetClass("meta_ads.resume_campaign")).toBe(false);
    expect(isEditableBudgetClass("engineer.ship-pr")).toBe(false);
    expect(isEditableBudgetClass(null)).toBe(false);
  });
});

describe("readProposedDailyBudget", () => {
  it("reads daily_budget_usd when numeric, else null", () => {
    expect(readProposedDailyBudget({ daily_budget_usd: 25 })).toBe(25);
    expect(readProposedDailyBudget({ daily_budget_usd: "25" })).toBeNull();
    expect(readProposedDailyBudget({})).toBeNull();
    expect(readProposedDailyBudget(null)).toBeNull();
  });
});

describe("buildEditBudgetModal", () => {
  it("builds an edit_decision modal carrying ONLY decision_id in private_metadata, prefilled", () => {
    const view = buildEditBudgetModal("dec-7", 10) as {
      callback_id: string;
      private_metadata: string;
      blocks: Array<{ block_id?: string; element?: { action_id?: string; initial_value?: string } }>;
    };
    expect(view.callback_id).toBe(EDIT_CALLBACK_ID);
    expect(JSON.parse(view.private_metadata)).toEqual({ decision_id: "dec-7" });
    const field = view.blocks.find((b) => b.element?.action_id === EDIT_BUDGET_ACTION_ID);
    expect(field).toBeTruthy();
    expect(field!.element!.initial_value).toBe("10");
  });
  it("tolerates a null current budget (empty prefill)", () => {
    const view = buildEditBudgetModal("dec-7", null) as {
      blocks: Array<{ element?: { action_id?: string; initial_value?: string } }>;
    };
    const field = view.blocks.find((b) => b.element?.action_id === EDIT_BUDGET_ACTION_ID);
    expect(field!.element!.initial_value).toBe("");
  });
});

describe("buildApprovalBlocks — Edit button rendering", () => {
  function actionIds(blocks: unknown[]): string[] {
    const actions = (blocks as Array<{ type: string; elements?: Array<{ action_id?: string }> }>).find(
      (b) => b.type === "actions",
    );
    return (actions?.elements ?? []).map((e) => e.action_id).filter(Boolean) as string[];
  }
  it("renders Edit for a meta_ads budget class", () => {
    const blocks = buildApprovalBlocks({
      id: "d1",
      decision_class: "meta_ads.update_ad_set_budget",
      body: { daily_budget_usd: 10 },
    });
    expect(actionIds(blocks)).toContain(SLACK_ACTION_EDIT);
  });
  it("does NOT render Edit for a non-budget class", () => {
    const blocks = buildApprovalBlocks({
      id: "d1",
      decision_class: "meta_ads.resume_campaign",
      body: {},
    });
    expect(actionIds(blocks)).not.toContain(SLACK_ACTION_EDIT);
  });
});

describe("buildEditBudgetModal currency label", () => {
  const label = (m: Record<string, unknown>) =>
    ((m.blocks as Array<{ label?: { text?: string } }>)[0].label?.text ?? "");
  it("labels an INR body in rupees and a USD or legacy body in dollars", () => {
    expect(label(buildEditBudgetModal("d1", 2000, "INR"))).toBe("Daily budget (₹/day)");
    expect(label(buildEditBudgetModal("d1", 20, "USD"))).toBe("Daily budget ($/day)");
    expect(label(buildEditBudgetModal("d1", 20))).toBe("Daily budget ($/day)");
  });
});
