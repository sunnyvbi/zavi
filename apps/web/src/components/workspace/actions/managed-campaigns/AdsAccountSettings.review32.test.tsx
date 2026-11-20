import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";

const h = vi.hoisted(() => ({
  api: vi.fn(),
  confirm: vi.fn(async (..._a: unknown[]) => true),
  wallet: { auto_refill_enabled: false, funding_enabled: true } as { auto_refill_enabled: boolean; funding_enabled: boolean } | null,
}));
vi.mock("./api", () => ({ campaignFetch: h.api }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: h.confirm }));
vi.mock("./ChannelBalance", () => ({
  ChannelBalance: ({ onWallet, refreshKey }: { onWallet?: (w: unknown) => void; refreshKey?: unknown }) => {
    useEffect(() => { if (h.wallet) onWallet?.(h.wallet); }, [refreshKey]);
    return <div>Shared balance</div>;
  },
}));

import { AdsAccountSettings } from "./AdsAccountSettings";

const OWN = "10000000-0000-4000-8000-000000000001";
const WALLET = "10000000-0000-4000-8000-000000000002";
const GRANT = "30000000-0000-4000-8000-000000000003";
const CONSENT = "/api/ads/wallet/consent";
const ACCOUNTS = "/api/ads/accounts/linkedin";
const LIST = "/api/ads/campaigns?platform=linkedin";

type Account = { id: string; account_id?: string; provider_account_id: string | null; funding_source: "wallet" | "provider"; currency: string | null; disabled: boolean; view_only?: boolean; billing_hold?: boolean };
let accepted: boolean;
let accounts: Account[];
let managed: Array<{ account_id: string; label: string }>;
let selected: string | null;
let campaigns: Array<Record<string, unknown>>;

beforeEach(() => {
  h.api.mockReset();
  h.confirm.mockReset();
  h.confirm.mockResolvedValue(true);
  h.wallet = { auto_refill_enabled: false, funding_enabled: true };
  accepted = false;
  accounts = [{ id: OWN, provider_account_id: "11", funding_source: "provider", currency: "USD", disabled: false }];
  managed = [];
  selected = OWN;
  campaigns = [];
  h.api.mockImplementation(async (path: string, opts?: { method?: string; body?: string }) => {
    if (opts?.method === "POST") {
      if (path === CONSENT) accepted = JSON.parse(opts.body ?? "{}").accept === true;
      return { ok: true };
    }
    if (path === CONSENT) return { version: "v1", text: "Let Zavi pay from my shared ads balance", accepted };
    if (path === "/api/ads/wallet/reservations") return { reservations: [] };
    if (path === ACCOUNTS) return { accounts, managed, selected_id: selected };
    if (path.includes("/available")) return { accounts: [{ id: "11", name: "Acme main", currency: "USD" }, { id: "12", name: "Acme side", currency: "USD" }] };
    if (path === LIST) return { campaigns };
    return {};
  });
});
afterEach(cleanup);

async function openPanel() {
  render(<AdsAccountSettings platform="linkedin" />);
  fireEvent.click(screen.getByText("Ad account and shared wallet"));
  await screen.findByRole("heading", { name: "Shared wallet permission" });
}
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };
const posts = () => h.api.mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === "POST");

it("P3: after the founder authorizes the shared wallet again, says auto-refill is still off and wallet campaigns stay paused, with how to turn each back on", async () => {
  campaigns = [
    { id: "c1", provider_campaign_id: "71", name: "Spring push", funding_source: "wallet", status: "paused" },
    { id: "c2", provider_campaign_id: "72", name: "Autumn push", funding_source: "wallet", status: "paused" },
    { id: "c3", provider_campaign_id: "73", name: "Own push", funding_source: "provider", status: "paused" },
  ];
  await openPanel();
  await waitFor(() => expect(h.api.mock.calls.filter(([p]) => p === LIST)).toHaveLength(1));
  expect(screen.queryByTestId("reauthorized-followup")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Authorize shared wallet" }));
  const note = await screen.findByTestId("reauthorized-followup");
  expect(note.textContent).toContain("Auto-refill is still off. To turn it back on, use Add balance above and tick Also auto-refill my ads balance.");
  expect(note.textContent).toContain("2 LinkedIn campaigns paid from your shared ads balance are still paused.");
  expect(note.textContent).toContain("Use Review launch on each one below to run it again.");
});

it("P3: says nothing extra when the wallet was already authorized on arrival, or when refill is on and nothing is paused", async () => {
  accepted = true;
  campaigns = [{ id: "c1", provider_campaign_id: "71", name: "Spring push", funding_source: "wallet", status: "paused" }];
  await openPanel();
  await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
  expect(screen.queryByTestId("reauthorized-followup")).toBeNull();
  cleanup();
  accepted = false;
  campaigns = [];
  h.wallet = { auto_refill_enabled: true, funding_enabled: true };
  await openPanel();
  fireEvent.click(screen.getByRole("button", { name: "Authorize shared wallet" }));
  await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
  expect(screen.queryByTestId("reauthorized-followup")).toBeNull();
});

it("P6: a saved account the founder's LinkedIn login can only view is not re-bound; a usable account beside it is bound instead, and nothing is bound when there is none", async () => {
  accepted = true;
  accounts = [{ ...accounts[0], view_only: true }];
  await openPanel();
  await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0][0]).toBe(`${ACCOUNTS}/connect`);
  expect(JSON.parse((posts()[0][1] as { body: string }).body)).toEqual({ mode: "customer", account_id: "12" });
  expect(screen.queryByRole("combobox")).toBeNull();
  cleanup();
  h.api.mockClear();
  h.api.mockImplementation(async (path: string) => {
    if (path === CONSENT) return { version: "v1", text: "Terms", accepted: true };
    if (path === ACCOUNTS) return { accounts, managed, selected_id: selected };
    if (path.includes("/available")) return { accounts: [{ id: "11", name: "Acme main", currency: "USD" }] };
    if (path === LIST) return { campaigns };
    return {};
  });
  await openPanel();
  await waitFor(() => expect(h.api.mock.calls.filter(([p]) => String(p).includes("/available"))).toHaveLength(1));
  await settle();
  expect(posts()).toHaveLength(0);
});

it("P8: a consent change from elsewhere moves the permission card and the summary pill", async () => {
  await openPanel();
  expect(screen.getByText("Wallet not authorized")).toBeTruthy();
  accepted = true;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
  expect(screen.getByText("Wallet authorized")).toBeTruthy();
  expect(screen.queryByText("Wallet not authorized")).toBeNull();
  accepted = false;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await screen.findByRole("button", { name: "Authorize shared wallet" });
  expect(screen.getByText("Wallet not authorized")).toBeTruthy();
  expect(screen.queryByText("Wallet authorized")).toBeNull();
  expect(h.confirm).not.toHaveBeenCalled();
  expect(posts()).toHaveLength(0);
});
