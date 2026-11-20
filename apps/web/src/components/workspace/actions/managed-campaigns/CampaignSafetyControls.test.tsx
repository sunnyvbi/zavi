// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
import { CampaignSafetyControls, hasMoneyAtStake, WALLET_READ_WAIT_MS } from "./CampaignSafetyControls";
import { chatgpt_ads } from "../platforms/chatgpt_ads";
beforeEach(() => {
  api.mockReset();
  HTMLDialogElement.prototype.close = function () {};
  api.mockImplementation(async (path: string) => path.endsWith("/wallet") ? { balance_cents: 10000, reserved_cents: 0, funding_enabled: true, auto_refill_enabled: true } : { campaigns: [{ id: "c1", name: "Launch", status: "active", updated_at: 10 }], complete: true });
});
afterEach(cleanup);
it("keeps cancellation and exact pause available without any funding or activation controls", async () => {
  render(<CampaignSafetyControls spec={chatgpt_ads.campaignWorkspace!} />);
  fireEvent.click(await screen.findByRole("button", { name: /Manage ChatGPT/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Turn off auto-refill" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/api/ads/wallet/disable-refill", { method: "POST" }));
  fireEvent.click(await screen.findByRole("button", { name: "Pause Launch" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/api/channels/chatgpt_ads/campaigns/c1", { method: "POST", body: JSON.stringify({ status: "paused", expected_updated_at: 10 }) }));
  expect(screen.queryByRole("button", { name: /Add balance|Activate|Create/ })).toBeNull();
});
it("does not describe a failed inventory request as no campaigns", async () => {
  api.mockRejectedValue(new Error("Unavailable"));
  render(<CampaignSafetyControls spec={chatgpt_ads.campaignWorkspace!} />);
  fireEvent.click(await screen.findByRole("button", { name: /Manage ChatGPT/ }));
  await screen.findByText(/Campaign status is unavailable/);
  expect(screen.queryByText("No managed campaigns found.")).toBeNull();
});
it("stays hidden for a workspace with no balance, no reservation and no auto-refill", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/wallet") ? { balance_cents: 0, reserved_cents: 0, auto_refill_enabled: false, pending: false } : { campaigns: [{ id: "c1", name: "Old", status: "paused" }], complete: true });
  render(<CampaignSafetyControls spec={chatgpt_ads.campaignWorkspace!} />);
  await waitFor(() => expect(api).toHaveBeenCalledWith("/api/ads/wallet"));
  await Promise.resolve();
  expect(screen.queryByRole("button", { name: /Manage ChatGPT/ })).toBeNull();
});
it("shows the controls for an empty wallet while a campaign is still active", async () => {
  api.mockImplementation(async (path: string) => path.endsWith("/wallet") ? { balance_cents: 0, reserved_cents: 0, auto_refill_enabled: false, pending: false } : { campaigns: [{ id: "c1", name: "Launch", status: "active" }], complete: true });
  render(<CampaignSafetyControls spec={chatgpt_ads.campaignWorkspace!} />);
  expect(await screen.findByRole("button", { name: /Manage ChatGPT/ })).toBeTruthy();
});
it.each([
  [{ balance_cents: 0, reserved_cents: 0, auto_refill_enabled: false, pending: false }, false],
  [{ balance_cents: 0, reserved_cents: 0, auto_refill_enabled: true, pending: false }, true],
  [{ balance_cents: 0, reserved_cents: 0, auto_refill_enabled: false, pending: true }, true],
  [{ balance_cents: 2500, reserved_cents: 0, auto_refill_enabled: false, pending: false }, true],
  [{ balance_cents: 0, reserved_cents: 900, auto_refill_enabled: false, pending: false }, true],
  [{}, true],
  [null, true],
])("decides whether %j leaves money at stake", (wallet, expected) => {
  expect(hasMoneyAtStake(wallet)).toBe(expected);
});
it("shows the controls when the wallet read hangs, so a stuck request never hides them", async () => {
  vi.useFakeTimers();
  try {
    api.mockImplementation(() => new Promise(() => {}));
    render(<CampaignSafetyControls spec={chatgpt_ads.campaignWorkspace!} />);
    expect(screen.queryByRole("button", { name: /Manage ChatGPT/ })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(WALLET_READ_WAIT_MS); });
    expect(screen.getByRole("button", { name: /Manage ChatGPT/ })).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
