// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const ctx = vi.hoisted(() => ({ value: null as null | { openTab: () => string; role: string } }));
vi.mock("./WorkspaceShell", () => ({ useWorkspaceOptional: () => ctx.value }));
const openBilling = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace/openBilling", () => ({ openBillingSettings: openBilling }));

import { CreditRefusalNotice } from "./CreditRefusalNotice";
import { creditRefusalFrom } from "@/lib/workspace/creditRefusal";

const refusal = {
  headline: "Not enough credits for this build.",
  detail: " Top up to start it.",
  subline: "Needs about 6,500 credits · you have 492",
};

afterEach(() => {
  cleanup();
  ctx.value = null;
  openBilling.mockReset();
});

describe("CreditRefusalNotice", () => {
  it("an owner gets the numbers and both billing buttons, which open Billing in place", () => {
    ctx.value = { openTab: () => "t", role: "owner" };
    render(<CreditRefusalNotice refusal={refusal} />);
    expect(screen.getByText("Not enough credits for this build.")).toBeTruthy();
    expect(screen.getByText("Needs about 6,500 credits · you have 492")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Buy Credits" }));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade Plan" }));
    expect(openBilling).toHaveBeenCalledTimes(2);
  });

  it("a member, who cannot reach Billing, is told to ask the owner and gets no dead-end buttons", () => {
    ctx.value = { openTab: () => "t", role: "member" };
    render(<CreditRefusalNotice refusal={refusal} />);
    expect(screen.queryByRole("button", { name: "Buy Credits" })).toBeNull();
    expect(screen.getByText(/Ask your workspace owner to add credits\./)).toBeTruthy();
  });

  it("the free-edit wall shows its sentence with both Buy Credits and Upgrade Plan", () => {
    ctx.value = { openTab: () => "t", role: "owner" };
    const wall = creditRefusalFrom(
      { error: { code: "free_edits_used", message: "You've used your 2 free edits. Editing your app needs Starter ($20/mo), or buy credits." } },
      "change",
    )!;
    render(<CreditRefusalNotice refusal={wall} />);
    expect(screen.getByText("You've used your 2 free edits. Editing your app needs Starter ($20/mo), or buy credits.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Buy Credits" }));
    fireEvent.click(screen.getByRole("button", { name: "Upgrade Plan" }));
    expect(openBilling).toHaveBeenCalledTimes(2);
  });

  it("an explicit onOpenBilling wins (the /start flow)", () => {
    const go = vi.fn();
    render(<CreditRefusalNotice refusal={refusal} onOpenBilling={go} />);
    fireEvent.click(screen.getByRole("button", { name: "Buy Credits" }));
    expect(go).toHaveBeenCalledTimes(1);
    expect(openBilling).not.toHaveBeenCalled();
  });
});
