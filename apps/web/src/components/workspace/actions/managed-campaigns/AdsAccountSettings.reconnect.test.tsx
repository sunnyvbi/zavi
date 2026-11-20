// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ api: vi.fn(), invalidate: vi.fn() }));
vi.mock("./api", () => ({ campaignFetch: h.api }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: async () => true }));
vi.mock("./ChannelBalance", () => ({ ChannelBalance: () => <div>Shared balance</div> }));
vi.mock("./campaignReviewPrefetch", async (original) => ({ ...(await original<typeof import("./campaignReviewPrefetch")>()), invalidateCampaignReviews: h.invalidate }));

import { AdsAccountSettings } from "./AdsAccountSettings";

const BASE = "/api/ads/accounts/linkedin";
const OLD = "10000000-0000-4000-8000-000000000001";
const NEW = "10000000-0000-4000-8000-000000000002";
const WALLET = "10000000-0000-4000-8000-000000000003";
const walletRow = { id: WALLET, account_id: "m", provider_account_id: "910000001", funding_source: "wallet", currency: "USD", disabled: false };
const oldRow = { id: OLD, provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false };
const newRow = { id: NEW, provider_account_id: "560026764", funding_source: "provider", currency: "USD", disabled: false };
const managed = [{ account_id: "m", label: "Zavi account" }];
const before = { accounts: [oldRow, walletRow], managed, selected_id: OLD, unseen_selected_id: null };
const after = { accounts: [{ ...oldRow, not_on_login: true }, walletRow], managed, selected_id: null, unseen_selected_id: OLD };
const afterBound = { accounts: [{ ...oldRow, not_on_login: true }, walletRow, newRow], managed, selected_id: NEW, unseen_selected_id: null };
const oldList = { accounts: [{ id: "559148166", name: "Zavi QA", currency: "USD" }] };
const newList = { accounts: [{ id: "560026764", name: "Mohit's Ad Account", currency: "USD" }] };
let choices: unknown;
let list: unknown;
let consentReads = 0;
let consentRow = { version: "v1", text: "Authorize", accepted: true };
let held: Array<() => void> = [];
let holding = false;
let onPost: (path: string, body: unknown) => unknown = () => ({ ok: true });

beforeEach(() => {
  h.api.mockReset();
  h.invalidate.mockReset();
  choices = before;
  list = oldList;
  consentReads = 0;
  consentRow = { version: "v1", text: "Authorize", accepted: true };
  held = [];
  holding = false;
  onPost = () => ({ ok: true });
  h.api.mockImplementation(async (path: string, opts?: { method?: string; body?: string }) => {
    if (opts?.method === "POST") return onPost(path, JSON.parse(opts.body ?? "null"));
    if (path.startsWith(`${BASE}/available`)) {
      const value = list;
      if (value instanceof Error) throw value;
      if (holding) await new Promise<void>((resolve) => held.push(resolve));
      return value;
    }
    if (path.endsWith("/consent")) { consentReads++; return { ...consentRow }; }
    if (path.endsWith("/reservations")) return { reservations: [] };
    if (path === BASE) {
      const value = choices;
      if (holding) await new Promise<void>((resolve) => held.push(resolve));
      return value;
    }
    if (path.startsWith("/api/ads/campaigns?")) return { campaigns: [] };
    return { accounts: [] };
  });
});
afterEach(cleanup);

const posts = () => h.api.mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === "POST").map(([p, o]) => [p, JSON.parse((o as { body: string }).body)]);
const reads = (path: string) => h.api.mock.calls.filter(([p]) => p === path).length;
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };
const returnToTab = async () => { await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); }); };
async function open(onConnectionChange = vi.fn()) {
  render(<AdsAccountSettings platform="linkedin" onConnectionChange={onConnectionChange} />);
  await screen.findByRole("heading", { name: "Shared wallet permission" });
  await waitFor(() => expect(reads(`${BASE}/available`)).toBe(1));
  await settle();
  return onConnectionChange;
}

it("swaps to the new login when the founder comes back from reconnecting in another tab, binding its account with no reload", async () => {
  const changed = await open();
  expect(screen.getByText(/billed by LinkedIn Ads/)).toBeTruthy();
  onPost = (path, body) => {
    expect(path).toBe(`${BASE}/connect`);
    expect(body).toEqual({ mode: "customer", account_id: "560026764" });
    choices = afterBound;
    return { ok: true };
  };
  choices = after;
  list = newList;
  await returnToTab();
  await waitFor(() => expect(posts()).toEqual([[`${BASE}/connect`, { mode: "customer", account_id: "560026764" }]]));
  await waitFor(() => expect(reads(BASE)).toBe(3));
  await settle();
  expect(screen.getByText(/billed by LinkedIn Ads/)).toBeTruthy();
  expect(screen.queryByText("560026764")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(posts()).toHaveLength(1);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(h.invalidate).toHaveBeenCalledTimes(2);
});

it("fetches nothing new and tells nobody when the connection did not change", async () => {
  const changed = await open();
  await returnToTab();
  await waitFor(() => expect(reads(`${BASE}/available`)).toBe(2));
  await settle();
  expect(reads(BASE)).toBe(2);
  expect(consentReads).toBe(2);
  expect(changed).not.toHaveBeenCalled();
  expect(h.invalidate).not.toHaveBeenCalled();
  expect(posts()).toEqual([]);
});

it("notices the shared-wallet permission was withdrawn in another tab: no longer says Authorized and offers to authorize", async () => {
  await open();
  expect(screen.getByText("Authorized")).toBeTruthy();
  expect(screen.getByText("Wallet authorized")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Authorize shared wallet" })).toBeNull();
  consentRow = { version: "v1", text: "Authorize", accepted: false };
  await returnToTab();
  await screen.findByText("Not authorized");
  expect(screen.queryByText("Authorized")).toBeNull();
  expect(screen.queryByText("Wallet authorized")).toBeNull();
  expect(screen.getByText("Wallet not authorized")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Authorize shared wallet" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Withdraw shared-wallet permission" })).toBeNull();
  expect(h.api.mock.calls.some(([p]) => String(p).includes("refresh=1"))).toBe(false);
  expect(posts()).toEqual([]);
});

it("a withdrawal in another tab flags the wallet on the Zavi account in use and does not swap it for the login's own account", async () => {
  choices = { ...before, selected_id: WALLET };
  await open();
  expect(screen.getByText("Approved campaigns are paid from your shared ads balance.")).toBeTruthy();
  expect(screen.getByText("Wallet authorized")).toBeTruthy();
  consentRow = { version: "v1", text: "Authorize", accepted: false };
  await returnToTab();
  await screen.findByText("Wallet not authorized");
  expect(screen.getByText("Zavi is not allowed to pay for campaigns from your shared ads balance.")).toBeTruthy();
  await waitFor(() => expect(reads(`${BASE}/available`)).toBe(2));
  await settle();
  expect(posts()).toEqual([]);
});

it("notices the shared-wallet permission was given in another tab", async () => {
  consentRow = { version: "v1", text: "Authorize", accepted: false };
  await open();
  expect(screen.getByText("Not authorized")).toBeTruthy();
  consentRow = { version: "v1", text: "Authorize", accepted: true };
  await returnToTab();
  await screen.findByText("Authorized");
  expect(screen.getByText("Wallet authorized")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Withdraw shared-wallet permission" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Authorize shared wallet" })).toBeNull();
});

it("notices the account was stopped in another tab and turns it back on", async () => {
  const changed = await open();
  onPost = (path, body) => {
    expect(path).toBe(`${BASE}/enable`);
    expect(body).toEqual({ account_binding_id: OLD });
    choices = before;
    return { ok: true };
  };
  choices = { ...before, accounts: [{ ...oldRow, disabled: true }, walletRow] };
  await returnToTab();
  await waitFor(() => expect(posts()).toEqual([[`${BASE}/enable`, { account_binding_id: OLD }]]));
  await waitFor(() => expect(reads(BASE)).toBe(3));
  await settle();
  expect(screen.getByText(/billed by LinkedIn Ads/)).toBeTruthy();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(h.api.mock.calls.some(([p]) => String(p).includes("refresh=1"))).toBe(false);
  expect(posts()).toHaveLength(1);
});

it("binds nothing when the founder disconnected in another tab", async () => {
  const changed = await open();
  choices = after;
  list = Object.assign(new Error("not connected"), { code: "linkedin_ads_not_connected" });
  await returnToTab();
  await waitFor(() => expect(reads(`${BASE}/available`)).toBe(2));
  await settle();
  expect(posts()).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("heading", { name: "Shared wallet permission" })).toBeTruthy();
});

it("keeps what is on screen and tells nobody when the reread fails with an outage", async () => {
  const changed = await open();
  list = new Error("LinkedIn is busy");
  await returnToTab();
  await waitFor(() => expect(reads(`${BASE}/available`)).toBe(2));
  await settle();
  expect(screen.getByText(/billed by LinkedIn Ads/)).toBeTruthy();
  expect(screen.getByText("Wallet authorized")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  expect(posts()).toEqual([]);
});

it("a slow reread from before a withdrawal lands cannot put the old permission back", async () => {
  await open();
  holding = true;
  await returnToTab();
  await waitFor(() => expect(held.length).toBe(2));
  const slow = held;
  held = [];
  holding = false;
  onPost = () => {
    consentRow = { version: "v1", text: "Authorize", accepted: false };
    return { ok: true };
  };
  fireEvent.click(screen.getByRole("button", { name: "Withdraw shared-wallet permission" }));
  await screen.findByText("Wallet not authorized");
  expect(posts()).toEqual([["/api/ads/wallet/consent", { version: "v1", accept: false }]]);
  consentRow = { version: "v1", text: "Authorize", accepted: true };
  await act(async () => { slow.forEach((f) => f()); await Promise.resolve(); await Promise.resolve(); });
  await settle();
  expect(screen.getByText("Wallet not authorized")).toBeTruthy();
  expect(screen.queryByText("Wallet authorized")).toBeNull();
  expect(screen.getByRole("button", { name: "Authorize shared wallet" })).toBeTruthy();
  expect(posts()).toHaveLength(1);
});

it("does not read after unmounting", async () => {
  await open();
  cleanup();
  const calls = h.api.mock.calls.length;
  document.dispatchEvent(new Event("visibilitychange"));
  await Promise.resolve();
  expect(h.api.mock.calls.length).toBe(calls);
});
