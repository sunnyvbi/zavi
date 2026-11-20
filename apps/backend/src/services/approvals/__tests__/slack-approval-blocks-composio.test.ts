import { describe, it, expect } from "vitest";
import { isEditableBudgetClass } from "../slack-approval-blocks";

describe("Slack and Composio writes", () => {
  it("a composio class is never an editable-budget class", () => {
    expect(isEditableBudgetClass("composio.moves_money")).toBe(false);
    expect(isEditableBudgetClass("composio.write")).toBe(false);
  });
});
