// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BudgetChoicePanel, blockLines, raiseAskOf, raiseLabel } from "./BudgetChoicePanel";
import type { BudgetChoiceView } from "@/lib/approvals/decisionApi";

type Over = Extract<BudgetChoiceView, { kind: "over" }>;
const over = (o: Partial<Over> = {}): Over => ({ kind: "over", month_label: "October", projection_usd: 27040, monthly_usd: 27000, over_by_usd: 40, raise_to_usd: 27100, daily_limit_usd: null, daily_limit_to_usd: null, ...o });

afterEach(() => cleanup());

describe("BudgetChoicePanel", () => {
  it("must-catch (Codex F3): a budget's first, prorated month names this month's cap; the raise label keeps the monthly budget", () => {
    const v = over({ month_cap_usd: 13500, projection_usd: 14000, raise_to_usd: 27100 });
    expect(blockLines(v)).toEqual(["October is projected at about $14,000, over your $13,500 October budget."]);
    expect(raiseLabel(v)).toBe("Approve and raise budget to $27,100");
    expect(blockLines(over({ month_cap_usd: 27000 }))).toEqual(["October is projected at about $27,040, over your $27,000 budget."]);
  });

  it("monthly only: the exact sentence, the label, and the ask it posts", () => {
    const v = over();
    expect(blockLines(v)).toEqual(["October is projected at about $27,040, over your $27,000 budget."]);
    expect(raiseLabel(v)).toBe("Approve and raise budget to $27,100");
    const onRaise = vi.fn();
    render(<BudgetChoicePanel view={v} busy={false} onApproveAndRaise={onRaise} onReject={() => {}} />);
    expect(screen.getByText("October is projected at about $27,040, over your $27,000 budget.")).toBeTruthy();
    expect(screen.getByText("Your monthly ad budget becomes $27,100 from now on. Most months you'll spend less than this.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and raise budget to $27,100" }));
    expect(onRaise).toHaveBeenCalledWith({ raise_budget_to_usd: 27100 });
  });
  it("must-catch Q3/B: daily limit only", () => {
    const v = over({ raise_to_usd: null, daily_limit_usd: 1000, daily_limit_to_usd: 1021 });
    expect(raiseAskOf(v)).toEqual({ raise_daily_limit_to_usd: 1021 });
    const onRaise = vi.fn();
    render(<BudgetChoicePanel view={v} busy={false} onApproveAndRaise={onRaise} onReject={() => {}} />);
    expect(screen.getByText("This goes over your $1,000 daily ad limit.")).toBeTruthy();
    expect(screen.getByText("Your daily ad limit becomes $1,021 from now on.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and raise daily limit to $1,021" }));
    expect(onRaise).toHaveBeenCalledWith({ raise_daily_limit_to_usd: 1021 });
  });
  it("only the set-aside sum is over: says what is set aside, not a projection", () => {
    expect(blockLines(over({ set_aside_over: true }))).toEqual(["With what is already set aside for your running ads in October, this goes past your $27,000 budget."]);
  });
  it("both limits on one card", () => {
    const v = over({ daily_limit_usd: 1000, daily_limit_to_usd: 1020 });
    expect(raiseLabel(v)).toBe("Approve and raise budget to $27,100 and daily limit to $1,020");
    expect(raiseAskOf(v)).toEqual({ raise_budget_to_usd: 27100, raise_daily_limit_to_usd: 1020 });
    expect(blockLines(v)).toHaveLength(2);
  });
  it("unreadable shows why and no raise button", () => {
    render(<BudgetChoicePanel view={{ kind: "unreadable", why: "google was last read 2026-10-20" }} busy={false} onApproveAndRaise={() => {}} onReject={() => {}} />);
    expect(screen.getByText("Zavi can't check your ad budget right now (google was last read 2026-10-20).")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });
  it("Find the money elsewhere only when offered and the month blocks", () => {
    render(<BudgetChoicePanel view={over({ raise_to_usd: null, daily_limit_usd: 1000, daily_limit_to_usd: 1021, find_money: null })} busy={false} onApproveAndRaise={() => {}} onReject={() => {}} onFindMoney={() => {}} />);
    expect(screen.queryByRole("button", { name: "Find the money elsewhere" })).toBeNull();
    cleanup();
    render(<BudgetChoicePanel view={over({ find_money: "available" })} busy={false} onApproveAndRaise={() => {}} onReject={() => {}} onFindMoney={() => {}} />);
    expect(screen.getByRole("button", { name: "Find the money elsewhere" })).toBeTruthy();
    expect(screen.queryByText("Cuts can't make room this month: the money is already set aside for raises you approved. Raise the budget instead.")).toBeNull();
  });
  it("must-catch upcar shape: find_money none hides the button and says cuts can't make room; unreadable hides it and adds nothing", () => {
    render(<BudgetChoicePanel view={over({ set_aside_over: true, find_money: "none", find_money_why: "set_aside" })} busy={false} onApproveAndRaise={() => {}} onReject={() => {}} onFindMoney={() => {}} />);
    expect(screen.queryByRole("button", { name: "Find the money elsewhere" })).toBeNull();
    expect(screen.getByText("Cuts can't make room this month: the money is already set aside for raises you approved. Raise the budget instead.")).toBeTruthy();
    cleanup();
    render(<BudgetChoicePanel view={over({ find_money: "unreadable" })} busy={false} onApproveAndRaise={() => {}} onReject={() => {}} onFindMoney={() => {}} />);
    expect(screen.queryByRole("button", { name: "Find the money elsewhere" })).toBeNull();
    expect(screen.queryByTestId("cuts-cant-make-room")).toBeNull();
    cleanup();
    render(<BudgetChoicePanel view={over({ find_money: "none", find_money_why: "spent" })} busy={false} onApproveAndRaise={() => {}} onReject={() => {}} onFindMoney={() => {}} />);
    expect(screen.getByText("This month's spend so far leaves no room for this raise. Raise the budget instead.")).toBeTruthy();
    expect(screen.queryByText(/already set aside/)).toBeNull();
    cleanup();
    for (const why of ["not_enough", "no_candidates", "non_usd"] as const) {
      render(<BudgetChoicePanel view={over({ find_money: "none", find_money_why: why })} busy={false} onApproveAndRaise={() => {}} onReject={() => {}} onFindMoney={() => {}} />);
      expect(screen.getByText("Cutting other ads can't make enough room this month. Raise the budget instead.")).toBeTruthy();
      expect(screen.queryByText("Cuts can't make room this month: the money is already set aside for raises you approved. Raise the budget instead.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Find the money elsewhere" })).toBeNull();
      cleanup();
    }
    render(<BudgetChoicePanel view={over()} busy={false} onApproveAndRaise={() => {}} onReject={() => {}} onFindMoney={() => {}} />);
    expect(screen.queryByRole("button", { name: "Find the money elsewhere" })).toBeNull();
  });
});
