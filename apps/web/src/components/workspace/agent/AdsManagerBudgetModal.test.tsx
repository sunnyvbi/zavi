// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
import { AdsManagerBudgetModal, type BudgetModalCampaign } from "./AdsManagerBudgetModal";

const campaign: BudgetModalCampaign = { campaign_id: "c1", channel: "meta", name: "Spring promo", band: "green", status_label: "scale", spend_label: "$120", roas_label: "3.1×", bookings_label: "4", cost_label: "$30", pct_label: "60%", objective_label: "Conversions", current_daily_budget_usd: 50, cost_per_result_usd: 30 };
const res = (ok: boolean, body: unknown = {}) => ({ ok, json: async () => body });
beforeEach(() => {
  apiFetch.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); });

function Host({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(true);
  return open ? <AdsManagerBudgetModal mode="edit" campaign={campaign} onClose={() => setOpen(false)} onDone={onDone} /> : <p>closed</p>;
}

it("opens as a named modal with focus on Close", () => {
  render(<Host onDone={() => {}} />);
  const dialog = screen.getByRole("dialog", { name: "Edit budget: Spring promo" });
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
});

it("closing mid-submit still stages, approves and confirms the change exactly as before", async () => {
  const onDone = vi.fn();
  apiFetch
    .mockResolvedValueOnce(res(true, { decision_id: "d1" }))
    .mockResolvedValueOnce(res(true))
    .mockResolvedValueOnce(res(true, { status: "acted" }));
  render(<Host onDone={onDone} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  expect(screen.getByText("closed")).toBeTruthy();
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 4000 });
  expect(apiFetch.mock.calls.map(([path, opts]) => [path, opts?.method ?? "GET"])).toEqual([
    ["/api/agents/performance-marketer/budget-edit", "POST"],
    ["/api/approvals/d1/approve", "POST"],
    ["/api/agents/performance-marketer/budget-edit/status/d1", "GET"],
  ]);
  expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ channel: "meta", campaign_id: "c1", campaign_name: "Spring promo", proposed_daily_budget_usd: 50 });
});

it("a refused stage keeps the modal open with the error", async () => {
  apiFetch.mockResolvedValueOnce(res(false, { error: { message: "Over your cost cap." } }));
  render(<Host onDone={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
  expect(await screen.findByText("Over your cost cap.")).toBeTruthy();
  expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true);
});

it("an ad budget refusal says the budget limit was reached and links to the budget", async () => {
  apiFetch
    .mockResolvedValueOnce(res(true, { decision_id: "d1" }))
    .mockResolvedValueOnce(res(true))
    .mockResolvedValueOnce(res(true, { status: "rejected", dispatch_error: "cap_refuse: ad_budget_over_month" }));
  render(<Host onDone={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
  const link = await screen.findByTestId("budget-modal-ad-budget", {}, { timeout: 4000 });
  expect(link.getAttribute("href")).toBe("/workspace?tab=growth-strategy#ad-budget");
  expect(screen.getByText(/Budget limit reached\. Nothing was sent to your ad account\./)).toBeTruthy();
  expect(screen.queryByText(/spend cap configured/)).toBeNull();
});
