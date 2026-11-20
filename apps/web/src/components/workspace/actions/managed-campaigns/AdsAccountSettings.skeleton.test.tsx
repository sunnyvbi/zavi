// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", () => ({ campaignFetch: h.api }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("./ChannelBalance", () => ({ ChannelBalance: () => <div>Shared balance</div> }));
vi.mock("./BoundAdsCampaigns", () => ({ BoundAdsCampaigns: () => <div>Bound campaign list</div> }));

import { AdsAccountSettings } from "./AdsAccountSettings";

const AVAILABLE = "/api/ads/accounts/linkedin/available";
const BINDING = "10000000-0000-4000-8000-000000000001";
const list = { accounts: [{ id: "559880687", name: "Old Co", currency: "USD" }], fetched_at: new Date().toISOString(), just_refreshed: false };
const accounts = { accounts: [{ id: BINDING, provider_account_id: "559880687", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: BINDING };
let release: Array<() => void> = [];
let failChoices = false;

beforeEach(() => {
  h.api.mockReset();
  release = [];
  failChoices = false;
  h.api.mockImplementation(async (path: string) => {
    if (path.startsWith(AVAILABLE)) return list;
    if (path.endsWith("/consent")) return { version: "v1", text: "Authorize", accepted: true };
    if (failChoices) throw new Error("Account settings could not load.");
    return new Promise((resolve) => release.push(() => resolve(accounts)));
  });
});
afterEach(cleanup);

const summary = () => screen.getByTestId("ads-account-summary");
const pulses = (root: HTMLElement) => root.querySelectorAll(".animate-pulse").length;

it("until the first read lands the section is an inert skeleton, then it becomes the normal expander with its title and pill", async () => {
  render(<AdsAccountSettings platform="linkedin" />);
  const head = summary();
  expect(head.getAttribute("aria-busy")).toBe("true");
  expect(head.tabIndex).toBe(-1);
  expect(head.className).toContain("pointer-events-none");
  expect(head.className).not.toContain("cursor-pointer");
  expect(pulses(head)).toBe(3);
  expect(screen.queryByText("Wallet authorized")).toBeNull();
  const details = head.closest("details") as HTMLDetailsElement;
  expect(details.open).toBe(false);
  expect(screen.getByRole("status").textContent).toBe("Loading account settings…");
  expect(pulses(screen.getByRole("status"))).toBe(3);

  await act(async () => { release.forEach((r) => r()); });
  await waitFor(() => expect(summary().getAttribute("aria-busy")).toBeNull());
  expect(summary().tabIndex).toBe(0);
  expect(summary().className).toContain("cursor-pointer");
  expect(pulses(summary())).toBe(0);
  expect(screen.getByText("Wallet authorized")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByText("Ad account and shared wallet"));
  expect(await screen.findByRole("heading", { name: "Shared wallet permission" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Withdraw shared-wallet permission" })).toBeTruthy();
});

it("a failed first read drops the skeleton and shows the expander with the error and Try again inside", async () => {
  failChoices = true;
  render(<AdsAccountSettings platform="linkedin" />);
  await waitFor(() => expect(summary().getAttribute("aria-busy")).toBeNull());
  expect(pulses(summary())).toBe(0);
  fireEvent.click(screen.getByText("Ad account and shared wallet"));
  expect((await screen.findByRole("alert")).textContent).toContain("Account settings could not load.");
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});
