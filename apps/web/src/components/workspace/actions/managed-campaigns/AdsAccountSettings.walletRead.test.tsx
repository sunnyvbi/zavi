// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const api = vi.hoisted(() => vi.fn());
const h = vi.hoisted(() => ({ fail: new Set<string>(), hang: new Set<string>() }));
vi.mock("./api", () => ({ campaignFetch: api }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: vi.fn(async () => true) }));
vi.mock("./ChannelBalance", () => ({ ChannelBalance: () => <div>Shared balance</div> }));

import { AdsAccountSettings } from "./AdsAccountSettings";

const binding = "10000000-0000-4000-8000-000000000001";
const CONSENT = "/api/ads/wallet/consent";
const RESERVATIONS = "/api/ads/wallet/reservations";
const ACCOUNTS = "/api/ads/accounts/linkedin";
const LIST = "/api/ads/campaigns?platform=linkedin";
const UNREAD = "Zavi could not read your shared wallet permission just now, so it is not shown. Your campaigns and their Pause controls below still work.";
const campaign = { id: "own-1", provider_campaign_id: "77", name: "Own billing push", funding_source: "provider", status: "active", platform: "linkedin" };

const reply = (path: string) => {
  if (path === CONSENT) return { version: "v1", text: "Terms", accepted: true };
  if (path === ACCOUNTS) return { accounts: [{ id: binding, provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: false }], managed: [], selected_id: binding };
  if (path === LIST) return { campaigns: [campaign] };
  if (path.endsWith("/available")) return { accounts: [{ id: "11", name: "Main", currency: "USD" }] };
  return {};
};

beforeEach(() => {
  vi.clearAllMocks();
  h.fail = new Set();
  h.hang = new Set();
  api.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (opts?.method === "POST") return { ok: true };
    if (h.hang.has(path)) return new Promise(() => {});
    if (h.fail.has(path)) throw new Error("Service unavailable");
    return reply(path);
  });
});
afterEach(cleanup);

const open = () => {
  render(<AdsAccountSettings platform="linkedin" />);
  fireEvent.click(screen.getByText("Ad account and shared wallet"));
};
const reads = (path: string) => api.mock.calls.filter(([p, o]) => p === path && !(o as { method?: string } | undefined)?.method).length;
const posts = () => api.mock.calls.filter(([, opts]) => (opts as { method?: string } | undefined)?.method === "POST");
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };
const notice = () => screen.getByText(UNREAD).closest("p") as HTMLElement;

describe("a failed wallet permission read never hides the balance or claims a permission state", () => {
  it("the wallet permission failing keeps the balance card, says exactly what could not be read, and offers Try again", async () => {
    h.fail.add(CONSENT);
    open();
    await screen.findByText(UNREAD);
    expect(notice().getAttribute("role")).toBe("alert");
    expect(within(notice()).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText("Shared balance")).toBeTruthy();
    expect(screen.queryByText(/funds it has reserved|reserved just now/)).toBeNull();
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("must catch: an unread permission never claims authorized or not authorized", async () => {
    h.fail.add(CONSENT);
    open();
    await screen.findByText(UNREAD);
    expect(screen.queryByText("Wallet authorized")).toBeNull();
    expect(screen.queryByText("Wallet not authorized")).toBeNull();
    expect(screen.queryByText("Authorized")).toBeNull();
    expect(screen.queryByText("Not authorized")).toBeNull();
    expect(screen.queryByRole("button", { name: "Authorize shared wallet" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw shared-wallet permission" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Shared wallet permission" })).toBeNull();
  });

  it("must catch: a reload after a withdrawal that loses the permission drops the old Authorized instead of showing it stale", async () => {
    open();
    const withdraw = await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
    expect(screen.getByText("Wallet authorized")).toBeTruthy();
    h.fail.add(CONSENT);
    fireEvent.click(withdraw);
    await screen.findByText(UNREAD);
    expect(posts()).toEqual([[CONSENT, { method: "POST", body: JSON.stringify({ version: "v1", accept: false }) }]]);
    expect(screen.queryByText("Wallet authorized")).toBeNull();
    expect(screen.queryByText("Wallet not authorized")).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw shared-wallet permission" })).toBeNull();
    expect(screen.getByText("Shared balance")).toBeTruthy();
  });

  it("the account read failing too shows the error with its retry and no wallet notice", async () => {
    h.fail.add(ACCOUNTS);
    h.fail.add(CONSENT);
    open();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toContain("Service unavailable");
    expect(screen.queryByText("Shared balance")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Try again" }).length).toBeGreaterThan(0);
  });

  it("Try again rereads the account and the permission, recovers the wallet and clears the message", async () => {
    h.fail.add(CONSENT);
    open();
    await screen.findByText(UNREAD);
    const before = api.mock.calls.length;
    h.fail.clear();
    fireEvent.click(within(notice()).getByRole("button", { name: "Try again" }));
    await screen.findByText("Wallet authorized");
    expect(screen.queryByText(/could not read/)).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw shared-wallet permission" })).toBeTruthy();
    expect(screen.getByText("Shared balance")).toBeTruthy();
    await waitFor(() => expect(reads(LIST)).toBe(2));
    const after = api.mock.calls.slice(before).map((c) => c[0]).sort();
    expect(after).toEqual([ACCOUNTS, CONSENT, LIST].sort());
    expect(posts()).toHaveLength(0);
  });

  it("must catch: a wallet read that never answers keeps the skeleton and claims no failure yet", async () => {
    h.hang.add(CONSENT);
    open();
    expect(screen.getByText("Loading account settings…")).toBeTruthy();
    await waitFor(() => expect(reads(LIST)).toBe(1));
    await settle();
    expect(screen.getByText("Loading account settings…")).toBeTruthy();
    expect(screen.queryByText(/could not read/)).toBeNull();
    expect(screen.queryByText("Shared balance")).toBeNull();
  });

  it("never reads the wallet reservations and shows no campaign list or Pause control", async () => {
    open();
    await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
    await waitFor(() => expect(reads(LIST)).toBe(1));
    await settle();
    expect(reads(RESERVATIONS)).toBe(0);
    expect(screen.queryByText(/reserved/)).toBeNull();
    expect(screen.queryByText("Bound campaign list")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("a failed campaign read surfaces no error", async () => {
    h.fail.add(LIST);
    open();
    await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
    await waitFor(() => expect(reads(LIST)).toBe(1));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
