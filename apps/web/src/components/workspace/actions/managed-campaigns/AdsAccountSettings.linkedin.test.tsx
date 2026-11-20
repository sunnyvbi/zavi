// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  api: vi.fn(),
  confirm: vi.fn(async (..._a: unknown[]) => true),
  role: "owner" as string | null,
  connect: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock("@/app/connectors/ConnectButton", () => ({ startConnectFlow: h.connect }));
vi.mock("./api", () => ({ campaignFetch: h.api }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: h.role }) }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: h.confirm }));
vi.mock("./ChannelBalance", () => ({ ChannelBalance: () => <div>Shared balance</div> }));
vi.mock("./BoundAdsCampaigns", () => ({ BoundAdsCampaigns: () => <div>Bound campaign list</div> }));

import { AdsAccountSettings } from "./AdsAccountSettings";

const ACCOUNTS = "/api/ads/accounts/linkedin";
const AVAILABLE = `${ACCOUNTS}/available`;
const CONSENT = "/api/ads/wallet/consent";
const OWN = "10000000-0000-4000-8000-000000000001";
const ZAVI = "20000000-0000-4000-8000-000000000002";
type Account = { id: string; account_id?: string; provider_account_id: string | null; funding_source: "wallet" | "provider"; currency: string | null; disabled: boolean; view_only?: boolean; owned_elsewhere?: boolean; billing_hold?: boolean; not_on_login?: boolean };
let accounts: Account[];
let selected: string | null;
let available: Array<{ id: string; name: string; currency: string | null; held_elsewhere?: boolean; billing_hold?: boolean; view_only?: boolean }>;
let connection: string;
let accepted: boolean;
let refuse: string | null;
let availableFails: { code: string } | null;
let holdConnect: Array<(v: unknown) => void> | null;
let managed: Array<{ account_id: string; label: string }>;

beforeEach(() => {
  h.api.mockReset();
  h.confirm.mockReset();
  h.confirm.mockResolvedValue(true);
  h.connect.mockClear();
  h.role = "owner";
  accounts = [];
  selected = null;
  available = [{ id: "558561881", name: "There Is A Tool For That", currency: "USD" }, { id: "559148166", name: "Zavi QA", currency: "USD" }];
  connection = "conn-1";
  accepted = false;
  refuse = null;
  availableFails = null;
  holdConnect = null;
  managed = [{ account_id: "m1", label: "Zavi LinkedIn" }];
  h.api.mockImplementation(async (path: string, opts?: { method?: string; body?: string }) => {
    if (opts?.method === "POST") {
      if (refuse) throw new Error(refuse);
      if (path === CONSENT) accepted = JSON.parse(opts.body ?? "{}").accept === true;
      if (path === `${ACCOUNTS}/connect`) {
        const { account_id: id, mode } = JSON.parse(opts.body ?? "{}") as { account_id: string; mode: string };
        if (mode === "managed") {
          accounts = [...accounts, { id: ZAVI, account_id: id, provider_account_id: "999", funding_source: "wallet", currency: "USD", disabled: false }];
          selected = ZAVI;
        } else {
          accounts = [...accounts, { id: OWN, provider_account_id: id, funding_source: "provider", currency: "USD", disabled: false }];
          selected = OWN;
        }
        if (holdConnect) return new Promise((r) => holdConnect?.push(r));
        return { account_binding_id: OWN };
      }
      if (path === `${ACCOUNTS}/select` || path === `${ACCOUNTS}/enable`) {
        const id = JSON.parse(opts.body ?? "{}").account_binding_id as string;
        accounts = accounts.map((a) => (a.id === id ? { ...a, disabled: false } : a));
        selected = id;
      }
      return { ok: true };
    }
    if (path.startsWith(AVAILABLE)) {
      if (availableFails) throw Object.assign(new Error("refused"), availableFails);
      return { accounts: available, fetched_at: new Date().toISOString(), just_refreshed: false };
    }
    if (path === CONSENT) return { version: "v1", text: "I authorize Zavi to use my shared ads balance for campaigns I approve.", accepted };
    if (path === "/api/ads/wallet/reservations") return { reservations: [] };
    if (path === ACCOUNTS || path === "/api/ads/accounts/chatgpt") return { accounts, managed, selected_id: selected, connection };
    if (path === "/api/ads/campaigns?platform=linkedin") return { campaigns: [] };
    return {};
  });
});
afterEach(cleanup);

const open = () => {
  render(<AdsAccountSettings platform="linkedin" />);
  fireEvent.click(screen.getByText("Ad account and shared wallet"));
};
const posts = (path?: string) =>
  h.api.mock.calls.filter(([p, o]) => (o as { method?: string } | undefined)?.method === "POST" && (!path || p === path));
const body = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body);

const reads = (path: string) => h.api.mock.calls.filter(([p, o]) => p === path && !(o as { method?: string } | undefined)?.method).length;
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };

describe("one ad account, chosen by the connection", () => {
  it("binds the first ad account of the login once, reloads only after the server saved it, and marks it in the account list without a dropdown", async () => {
    holdConnect = [];
    open();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    expect(body(posts()[0])).toEqual({ mode: "customer", account_id: "558561881" });
    await settle();
    expect(reads(ACCOUNTS)).toBe(1);
    await act(async () => { holdConnect?.forEach((r) => r({ account_binding_id: OWN })); });
    await waitFor(() => expect(reads(ACCOUNTS)).toBe(2));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(reads(ACCOUNTS)).toBe(3));
    await settle();
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1);
    expect(posts()).toHaveLength(1);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getAllByRole("radio").map((r) => [r.getAttribute("aria-label"), r.getAttribute("aria-checked")])).toEqual([
      ["There Is A Tool For That · your account", "true"],
      ["Zavi QA · your account", "false"],
    ]);
    expect(screen.getAllByText("Use your own account")).toHaveLength(1);
    expect(screen.getAllByText("Use a Zavi account")).toHaveLength(1);
    expect(screen.queryByText("Stop using this account for new campaigns")).toBeNull();
    expect(screen.queryByRole("button", { name: "New campaign" })).toBeNull();
    expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
    expect(screen.queryByText("Bound campaign list")).toBeNull();
    expect(screen.queryByText("558561881")).toBeNull();
    expect(screen.getByRole("button", { name: "Authorize shared wallet" })).toBeTruthy();
  });

  it("re-selects an existing binding instead of connecting again, and turns a stopped one back on", async () => {
    accounts = [{ id: OWN, provider_account_id: "558561881", funding_source: "provider", currency: "USD", disabled: false }];
    open();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe(`${ACCOUNTS}/select`);
    expect(body(posts()[0])).toEqual({ account_binding_id: OWN });
    await waitFor(() => expect(reads(ACCOUNTS)).toBe(2));
    cleanup();
    h.api.mockClear();
    accounts = [{ id: OWN, provider_account_id: "558561881", funding_source: "provider", currency: "USD", disabled: true }];
    selected = null;
    open();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe(`${ACCOUNTS}/enable`);
    expect(body(posts()[0])).toEqual({ account_binding_id: OWN });
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(0);
  });

  it("skips an account another workspace holds and binds the next one", async () => {
    available = [{ id: "558561881", name: "Taken", currency: "USD", held_elsewhere: true }, { id: "559148166", name: "Zavi QA", currency: "USD" }];
    open();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    expect(body(posts()[0])).toEqual({ mode: "customer", account_id: "559148166" });
    await waitFor(() => expect(reads(ACCOUNTS)).toBe(2));
    await settle();
    expect(posts()).toHaveLength(1);
  });

  it("a refused bind is not retried on its own, not on focus and not on a reread that shows the same state", async () => {
    refuse = "Your LinkedIn login can only view this ad account.";
    open();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    await screen.findByRole("button", { name: "Authorize shared wallet" });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(reads(ACCOUNTS)).toBe(2));
    await settle();
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1);
    expect(reads(ACCOUNTS)).toBe(2);
  });

  it("a new connection binds again; the same connection does not", async () => {
    open();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    await waitFor(() => expect(reads(ACCOUNTS)).toBe(2));
    await settle();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(reads(ACCOUNTS)).toBe(3));
    await settle();
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1);
    accounts = [];
    selected = null;
    connection = "conn-2";
    available = [{ id: "777", name: "New login co", currency: "EUR" }];
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(2));
    expect(body(posts(`${ACCOUNTS}/connect`)[1])).toEqual({ mode: "customer", account_id: "777" });
    await waitFor(() => expect(reads(ACCOUNTS)).toBe(5));
    await settle();
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(2);
  });

  it("a member sees the wallet state, never reads the login's list and never binds", async () => {
    h.role = "member";
    accounts = [{ id: OWN, provider_account_id: "558561881", funding_source: "provider", currency: "USD", disabled: false }];
    selected = OWN;
    open();
    await screen.findByText(/Only a workspace owner or admin can change the (ad account or the )?shared wallet permission/);
    const authorize = (await screen.findByRole("button", { name: "Authorize shared wallet" })) as HTMLButtonElement;
    expect(authorize.disabled).toBe(true);
    expect(authorize.title).toMatch(/owner or admin/);
    expect(screen.getByText("Wallet not authorized")).toBeTruthy();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(reads(ACCOUNTS)).toBe(2));
    await settle();
    expect(h.api.mock.calls.filter(([p]) => String(p).startsWith(AVAILABLE))).toHaveLength(0);
    expect(posts()).toHaveLength(0);
    expect(screen.queryByText("558561881")).toBeNull();
  });

  it.each([["linkedin_ads_not_connected"], ["linkedin_ads_token_revoked"]])("with the login's list refused as %s, binds nothing and keeps the wallet section", async (code) => {
    availableFails = { code };
    open();
    await screen.findByRole("button", { name: "Authorize shared wallet" });
    await waitFor(() => expect(h.api.mock.calls.filter(([p]) => String(p).startsWith(AVAILABLE))).toHaveLength(1));
    await settle();
    expect(posts()).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Shared balance")).toBeTruthy();
    cleanup();
    h.api.mockClear();
    accounts = [{ id: OWN, provider_account_id: "558561881", funding_source: "provider", currency: "USD", disabled: false }];
    selected = OWN;
    open();
    await screen.findByRole("button", { name: "Authorize shared wallet" });
    await settle();
    expect(posts()).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a Zavi wallet account in use is shown as paid from the shared balance and is not swapped for the login's own account", async () => {
    accepted = true;
    accounts = [{ id: "20000000-0000-4000-8000-000000000002", account_id: "m1", provider_account_id: "999", funding_source: "wallet", currency: "USD", disabled: false }];
    selected = "20000000-0000-4000-8000-000000000002";
    open();
    await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
    expect(screen.getByText("Approved campaigns are paid from your shared ads balance.")).toBeTruthy();
    expect(screen.queryByText(/billed by LinkedIn Ads/)).toBeNull();
    expect(screen.getByText("Wallet authorized")).toBeTruthy();
    await waitFor(() => expect(h.api.mock.calls.filter(([p]) => String(p).startsWith(AVAILABLE))).toHaveLength(1));
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("the ChatGPT panel keeps its picker and connect section", async () => {
    render(<AdsAccountSettings platform="chatgpt" />);
    fireEvent.click(screen.getByText("Ad account and shared wallet"));
    expect(await screen.findByRole("combobox", { name: "Account for new campaigns" })).toBeTruthy();
    expect(screen.getByText("Use your own account")).toBeTruthy();
    expect(screen.getByText("Bound campaign list")).toBeTruthy();
    expect(h.api.mock.calls.filter(([p]) => String(p).startsWith(AVAILABLE))).toHaveLength(0);
  });
});

describe("the shared wallet permission is given in a popup", () => {
  beforeEach(() => {
    accounts = [{ id: OWN, provider_account_id: "558561881", funding_source: "provider", currency: "USD", disabled: false }];
    selected = OWN;
  });

  it("opens the terms in a confirm dialog, sends nothing when dismissed, and authorizes once confirmed", async () => {
    h.confirm.mockResolvedValueOnce(false);
    open();
    await screen.findByRole("button", { name: "Authorize shared wallet" });
    expect(screen.getByText("Wallet not authorized")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("I authorize Zavi to use my shared ads balance for campaigns I approve.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Authorize shared wallet" }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    const options = h.confirm.mock.calls[0][0] as { title: string; confirmLabel: string; size: string; body: React.ReactElement };
    expect(options.title).toBe("Authorize the shared wallet");
    expect(options.confirmLabel).toBe("I authorize");
    expect(options.size).toBe("lg");
    render(options.body);
    expect(screen.getByTestId("consent-terms-popup").textContent).toBe("I authorize Zavi to use my shared ads balance for campaigns I approve.");
    expect(posts(CONSENT)).toHaveLength(0);
    expect(screen.getByText("Wallet not authorized")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Authorize shared wallet" }));
    await waitFor(() => expect(posts(CONSENT)).toHaveLength(1));
    expect(body(posts(CONSENT)[0])).toEqual({ version: "v1", accept: true });
    await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
    expect(screen.getByText("Wallet authorized")).toBeTruthy();
    fireEvent.click(screen.getByText("View the terms you accepted"));
    expect(within(screen.getByTestId("consent-terms")).getByText("I authorize Zavi to use my shared ads balance for campaigns I approve.")).toBeTruthy();
  });

  it("a second press while the first authorization is in flight opens no second popup", async () => {
    let settle: (v: unknown) => void = () => {};
    const plain = h.api.getMockImplementation()!;
    h.api.mockImplementation((path: string, opts?: { method?: string; body?: string }) =>
      opts?.method === "POST" && path === CONSENT ? new Promise((r) => { settle = r; }) : plain(path, opts),
    );
    open();
    const button = (await screen.findByRole("button", { name: "Authorize shared wallet" })) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(posts(CONSENT)).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Authorizing…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Authorizing…" }));
    expect(h.confirm).toHaveBeenCalledTimes(1);
    accepted = true;
    await act(async () => { settle({ ok: true }); });
    await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
  });

  it("a refused authorization keeps the wallet not authorized and shows the reason", async () => {
    refuse = "Add a payment method before authorizing the shared wallet.";
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Authorize shared wallet" }));
    expect((await screen.findByRole("alert")).textContent).toContain(refuse);
    expect(screen.getByText("Wallet not authorized")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Authorize shared wallet" })).toBeTruthy();
  });
});

describe("a login with no ad account of its own runs on the Zavi account once the shared wallet is authorized", () => {
  beforeEach(() => {
    available = [];
  });

  it("binds the Zavi account once, with the wallet already authorized, and never again after the reload shows it in use", async () => {
    accepted = true;
    open();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    expect(body(posts()[0])).toEqual({ mode: "managed", account_id: "m1" });
    await waitFor(() => expect(reads(ACCOUNTS)).toBe(2));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(reads(ACCOUNTS)).toBe(3));
    await settle();
    expect(posts()).toHaveLength(1);
    expect(screen.getByText("Approved campaigns are paid from your shared ads balance.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("must catch: binds nothing without the wallet permission, then binds the Zavi account the moment the popup is confirmed", async () => {
    open();
    await screen.findByRole("button", { name: "Authorize shared wallet" });
    await waitFor(() => expect(h.api.mock.calls.filter(([p]) => String(p).startsWith(AVAILABLE))).toHaveLength(1));
    await settle();
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Authorize shared wallet" }));
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    expect(posts()[0][0]).toBe(CONSENT);
    expect(body(posts()[0])).toEqual({ version: "v1", accept: true });
    expect(body(posts(`${ACCOUNTS}/connect`)[0])).toEqual({ mode: "managed", account_id: "m1" });
    await screen.findByText("Approved campaigns are paid from your shared ads balance.");
  });

  it("must catch: a dismissed popup binds nothing", async () => {
    h.confirm.mockResolvedValue(false);
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Authorize shared wallet" }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("turns a stopped Zavi binding back on instead of connecting again, and leaves one on billing hold alone", async () => {
    accepted = true;
    accounts = [{ id: ZAVI, account_id: "m1", provider_account_id: "999", funding_source: "wallet", currency: "USD", disabled: true }];
    open();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe(`${ACCOUNTS}/enable`);
    expect(body(posts()[0])).toEqual({ account_binding_id: ZAVI });
    cleanup();
    h.api.mockClear();
    accounts = [{ id: ZAVI, account_id: "m1", provider_account_id: "999", funding_source: "wallet", currency: "USD", disabled: true, billing_hold: true }];
    selected = null;
    open();
    await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
    await waitFor(() => expect(h.api.mock.calls.filter(([p]) => String(p).startsWith(AVAILABLE))).toHaveLength(1));
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("must catch: the login's own ad account wins over the Zavi account, and a login that is not connected binds nothing", async () => {
    accepted = true;
    available = [{ id: "558561881", name: "Own", currency: "USD" }];
    open();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    expect(body(posts()[0])).toEqual({ mode: "customer", account_id: "558561881" });
    cleanup();
    h.api.mockClear();
    accounts = [];
    selected = null;
    availableFails = { code: "linkedin_ads_not_connected" };
    open();
    await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
    await waitFor(() => expect(h.api.mock.calls.filter(([p]) => String(p).startsWith(AVAILABLE))).toHaveLength(1));
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("a refused Zavi bind shows the reason and sends nothing again on the next focus", async () => {
    accepted = true;
    refuse = "The Zavi account is not available for this workspace.";
    open();
    expect((await screen.findByTestId("linkedin-account-error")).textContent).toContain(refuse);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(posts()).toHaveLength(1);
  });
});

describe("the auto-bind picks a usable account and can be retried", () => {
  it("must catch: skips a live account LinkedIn holds for billing and binds the next one", async () => {
    available = [{ id: "558561881", name: "Held", currency: "USD", billing_hold: true }, { id: "559148166", name: "Usable", currency: "USD" }];
    open();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    expect(body(posts()[0])).toEqual({ mode: "customer", account_id: "559148166" });
  });

  it("must catch: a refused bind shows the reason with Try again, and Try again posts the bind once more", async () => {
    refuse = "LinkedIn refused the account.";
    open();
    const alert = await screen.findByTestId("linkedin-account-error");
    expect(alert.textContent).toContain(refuse);
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1);
    refuse = null;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("linkedin-account-error")).toBeNull());
  });

  it("must catch: a selected binding the login can only view does not block binding a usable live account", async () => {
    accounts = [{ id: OWN, provider_account_id: "111", funding_source: "provider", currency: "USD", disabled: false, view_only: true }];
    selected = OWN;
    open();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    expect(body(posts()[0])).toEqual({ mode: "customer", account_id: "558561881" });
  });

  it("must catch: a selected binding the current login cannot see does not block binding the login's own live account", async () => {
    accounts = [{ id: OWN, provider_account_id: "111", funding_source: "provider", currency: "USD", disabled: false, not_on_login: true }];
    selected = OWN;
    open();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    expect(body(posts()[0])).toEqual({ mode: "customer", account_id: "558561881" });
  });

  it("must catch: never posts a bind for a live account the login can only view, and binds nothing when every live account is view-only", async () => {
    available = [{ id: "558561881", name: "Viewer", currency: "USD", view_only: true }, { id: "559148166", name: "Usable", currency: "USD" }];
    open();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    expect(body(posts()[0])).toEqual({ mode: "customer", account_id: "559148166" });
    cleanup();
    h.api.mockClear();
    accounts = [];
    selected = null;
    available = [{ id: "558561881", name: "Viewer", currency: "USD", view_only: true }];
    open();
    await waitFor(() => expect(h.api.mock.calls.filter(([p]) => String(p).startsWith(AVAILABLE))).toHaveLength(1));
    await settle();
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(0);
    expect(screen.queryByTestId("linkedin-account-error")).toBeNull();
  });

  it("must catch: a Zavi grant that arrives while the page is open binds the Zavi account exactly once on the founder's return", async () => {
    accepted = true;
    available = [];
    managed = [];
    open();
    await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
    await waitFor(() => expect(h.api.mock.calls.filter(([p]) => String(p).startsWith(AVAILABLE))).toHaveLength(1));
    await settle();
    expect(posts()).toHaveLength(0);
    managed = [{ account_id: "m1", label: "Zavi LinkedIn" }];
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    expect(body(posts()[0])).toEqual({ mode: "managed", account_id: "m1" });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1);
  });
});

describe("LinkedIn accounts in use in another workspace", () => {
  it("says the account runs elsewhere when every account this login can run is held by another workspace, and binds nothing", async () => {
    available = [{ id: "558561881", name: "There Is A Tool For That", currency: "USD", held_elsewhere: true }];
    open();
    const note = await screen.findByTestId("linkedin-accounts-held-elsewhere");
    expect(note.textContent).toBe(
      "Your LinkedIn ad account There Is A Tool For That is already connected to another Zavi workspace, so it cannot be used here. An ad account runs in one workspace at a time. Open that workspace to see its campaigns and numbers, or disconnect LinkedIn Ads there first to use the account here.",
    );
    expect(screen.getByTestId("linkedin-own-card").contains(note)).toBe(true);
    expect(screen.getAllByText(/another Zavi workspace/)).toHaveLength(1);
    expect(screen.getAllByText(/There Is A Tool For That/)).toHaveLength(1);
    await settle();
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(0);
  });

  it("stays quiet when a free account is offered beside a held one", async () => {
    available = [{ id: "558561881", name: "Taken", currency: "USD", held_elsewhere: true }, { id: "559880687", name: "Free", currency: "USD" }];
    open();
    await settle();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByTestId("linkedin-own-card")).getByRole("radio", { name: "Free · your account" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.queryByTestId("linkedin-accounts-held-elsewhere")).toBeNull();
    expect(screen.queryByText(/another Zavi workspace/)).toBeNull();
    expect(screen.queryByText(/Taken/)).toBeNull();
  });

  it("stays quiet when no account is held elsewhere", async () => {
    available = [];
    open();
    await within(await screen.findByTestId("linkedin-own-card")).findByText("This LinkedIn login has no ad account.");
    expect(screen.queryByTestId("linkedin-accounts-held-elsewhere")).toBeNull();
    expect(screen.queryByText(/another Zavi workspace/)).toBeNull();
  });
});

describe("LinkedIn account setup follows the ChatGPT layout: a Zavi card and an own-account card, always both", () => {
  const ownCard = () => screen.findByTestId("linkedin-own-card");
  const walletCard = () => screen.getByTestId("linkedin-wallet-card");
  const zaviButton = () => within(walletCard()).getByRole("button", { name: "Use Zavi’s LinkedIn account" }) as HTMLButtonElement;
  const radio = (name: string) => within(screen.getByTestId("linkedin-own-card")).getByRole("radio", { name: `${name} · your account` });
  const checked = () => screen.queryAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.getAttribute("aria-label"));
  const enabledButtons = (card: HTMLElement) => within(card).queryAllByRole("button").filter((b) => !(b as HTMLButtonElement).disabled);

  it.each([
    ["linkedin_ads_not_connected", "Connect LinkedIn Ads"],
    ["linkedin_ads_token_revoked", "Reconnect LinkedIn Ads"],
  ])("with LinkedIn refused as %s and no Zavi grant, shows both cards side by side, a not-ready Zavi card that posts nothing, and %s on the own card", async (code, label) => {
    availableFails = { code };
    managed = [];
    open();
    const own = await ownCard();
    const wallet = walletCard();
    expect(screen.getByRole("heading", { name: "Connect an account" })).toBeTruthy();
    expect(own.parentElement).toBe(wallet.parentElement);
    expect(own.parentElement!.className.split(" ")).toEqual(expect.arrayContaining(["grid", "gap-4", "sm:grid-cols-2"]));
    expect([...own.parentElement!.children]).toEqual([wallet, own]);
    expect(within(wallet).getByText("Use a Zavi account")).toBeTruthy();
    expect(within(wallet).getByText("Zavi runs campaigns on its own LinkedIn ad account and pays from your shared wallet.")).toBeTruthy();
    expect(within(wallet).getByText(/can only promote posts from the LinkedIn page Zavi’s ad account advertises for/)).toBeTruthy();
    expect(within(own).getByText("Use your own account")).toBeTruthy();
    expect(within(own).getByText("Billed by LinkedIn")).toBeTruthy();
    expect(screen.queryByText("In use")).toBeNull();
    expect(zaviButton().disabled).toBe(true);
    expect(within(wallet).getByTestId("linkedin-wallet-state").textContent).toBe("Zavi’s LinkedIn ad account is not ready for this workspace yet.");
    fireEvent.click(zaviButton());
    const permission = screen.getByRole("heading", { name: "Shared wallet permission" });
    expect(own.contains(permission) || wallet.contains(permission)).toBe(false);
    const authorize = screen.getByRole("button", { name: "Authorize shared wallet" });
    expect(own.contains(authorize) || wallet.contains(authorize)).toBe(false);
    expect(authorize.className.split(" ")).toEqual(expect.arrayContaining(["w-full", "sm:w-auto"]));
    expect(within(own).getAllByRole("button").map((b) => b.textContent)).toEqual([label]);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(h.connect).not.toHaveBeenCalled();
    fireEvent.click(within(own).getByRole("button", { name: label }));
    await waitFor(() => expect(h.connect).toHaveBeenCalledTimes(1));
    expect(h.connect.mock.calls[0]).toEqual(["linkedin_ads", { returnHere: true }]);
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("keeps the Zavi button off until the wallet is authorized, then one press binds the granted account, and one press on an own account takes it back", async () => {
    open();
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1));
    await waitFor(() => expect(checked()).toEqual(["There Is A Tool For That · your account"]));
    expect(zaviButton().disabled).toBe(true);
    expect(within(walletCard()).getByTestId("linkedin-wallet-state").textContent).toBe("Authorize the permission above to use it.");
    fireEvent.click(zaviButton());
    await settle();
    expect(posts()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Authorize shared wallet" }));
    await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
    expect(zaviButton().disabled).toBe(false);
    expect(within(walletCard()).queryByTestId("linkedin-wallet-state")).toBeNull();
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(1);
    fireEvent.click(zaviButton());
    await waitFor(() => expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(2));
    expect(body(posts(`${ACCOUNTS}/connect`)[1])).toEqual({ mode: "managed", account_id: "m1" });
    await within(walletCard()).findByText("In use");
    expect(screen.getAllByText("In use")).toHaveLength(1);
    expect(within(walletCard()).queryByRole("button")).toBeNull();
    expect(checked()).toEqual([]);
    expect(within(await ownCard()).getByText("Billed by LinkedIn", { selector: "span.rounded-full" })).toBeTruthy();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(2);
    expect(posts(`${ACCOUNTS}/select`)).toHaveLength(0);
    fireEvent.click(radio("There Is A Tool For That"));
    await waitFor(() => expect(posts(`${ACCOUNTS}/select`)).toHaveLength(1));
    expect(body(posts(`${ACCOUNTS}/select`)[0])).toEqual({ account_binding_id: OWN });
    await waitFor(() => expect(checked()).toEqual(["There Is A Tool For That · your account"]));
    expect(within(await ownCard()).getByText("In use")).toBeTruthy();
    expect(within(walletCard()).queryByText("In use")).toBeNull();
    expect(zaviButton().disabled).toBe(false);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(posts(`${ACCOUNTS}/connect`)).toHaveLength(2);
    expect(posts(`${ACCOUNTS}/select`)).toHaveLength(1);
  });

  it("with an own account selected, marks it in the list and only the own card in use, never shows its id, and a press on another account connects that one", async () => {
    accounts = [{ id: OWN, provider_account_id: "559148166", funding_source: "provider", currency: "USD", disabled: false }];
    selected = OWN;
    open();
    const own = await ownCard();
    await waitFor(() => expect(checked()).toEqual(["Zavi QA · your account"]));
    expect(within(own).getByText("In use")).toBeTruthy();
    expect(screen.getAllByText("In use")).toHaveLength(1);
    expect(within(own).queryByText("Billed by LinkedIn", { selector: "span.rounded-full" })).toBeNull();
    expect(own.textContent).not.toMatch(/559148166|558561881/);
    expect(within(own).queryByText(/New campaigns run on/)).toBeNull();
    fireEvent.click(radio("Zavi QA"));
    await settle();
    expect(posts()).toHaveLength(0);
    fireEvent.click(radio("There Is A Tool For That"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe(`${ACCOUNTS}/connect`);
    expect(body(posts()[0])).toEqual({ mode: "customer", account_id: "558561881" });
  });

  it("with the Zavi account selected and the wallet authorized, marks only the Zavi card in use, and drops the mark the moment the permission is withdrawn", async () => {
    accepted = true;
    accounts = [{ id: ZAVI, account_id: "m1", provider_account_id: "999", funding_source: "wallet", currency: "USD", disabled: false }];
    selected = ZAVI;
    open();
    const own = await ownCard();
    const wallet = walletCard();
    await within(wallet).findByText("In use");
    expect(screen.getAllByText("In use")).toHaveLength(1);
    expect(within(wallet).getByTestId("linkedin-wallet-state").textContent).toBe("New campaigns run on Zavi’s ad account, paid from your shared wallet.");
    await waitFor(() => expect(within(own).getAllByRole("radio")).toHaveLength(2));
    expect(checked()).toEqual([]);
    expect(wallet.textContent).not.toContain("999");
    await settle();
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Withdraw shared-wallet permission" }));
    await waitFor(() => expect(posts(CONSENT)).toHaveLength(1));
    expect(body(posts(CONSENT)[0])).toEqual({ version: "v1", accept: false });
    await screen.findByRole("button", { name: "Authorize shared wallet" });
    expect(screen.queryByText("In use")).toBeNull();
    expect(zaviButton().disabled).toBe(true);
    expect(within(walletCard()).getByTestId("linkedin-wallet-state").textContent).toBe("Authorize the permission above to use it.");
  });

  it("with every own account held by another workspace, the own card says so once with no action, and the authorized Zavi card is the way forward", async () => {
    accepted = true;
    available = [
      { id: "558561881", name: "There Is A Tool For That", currency: "USD", held_elsewhere: true },
      { id: "559148166", name: "Zavi QA", currency: "USD", held_elsewhere: true },
    ];
    open();
    const own = await ownCard();
    expect((await within(own).findByTestId("linkedin-accounts-held-elsewhere")).textContent).toMatch(/^Your LinkedIn ad accounts There Is A Tool For That, Zavi QA are already connected to another Zavi workspace, so they cannot be used here\./);
    expect(screen.getAllByText(/another Zavi workspace/)).toHaveLength(1);
    expect(within(own).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText("In use")).toBeNull();
    await settle();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(posts()).toHaveLength(0);
    expect(zaviButton().disabled).toBe(false);
    fireEvent.click(zaviButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe(`${ACCOUNTS}/connect`);
    expect(body(posts()[0])).toEqual({ mode: "managed", account_id: "m1" });
    await within(walletCard()).findByText("In use");
  });

  it("re-selects a stopped Zavi binding instead of connecting again, and keeps the button off while LinkedIn holds Zavi's account for billing", async () => {
    accepted = true;
    available = [{ id: "558561881", name: "Held", currency: "USD", held_elsewhere: true }];
    accounts = [{ id: ZAVI, account_id: "m1", provider_account_id: "999", funding_source: "wallet", currency: "USD", disabled: true }];
    open();
    await ownCard();
    await waitFor(() => expect(zaviButton().disabled).toBe(false));
    fireEvent.click(zaviButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe(`${ACCOUNTS}/enable`);
    expect(body(posts()[0])).toEqual({ account_binding_id: ZAVI });
    cleanup();
    h.api.mockClear();
    accounts = [{ id: ZAVI, account_id: "m1", provider_account_id: "999", funding_source: "wallet", currency: "USD", disabled: true, billing_hold: true }];
    selected = null;
    open();
    await ownCard();
    await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
    expect(zaviButton().disabled).toBe(true);
    expect(within(walletCard()).getByTestId("linkedin-wallet-state").textContent).toMatch(/^LinkedIn has paused Zavi's managed ad account for billing/);
    fireEvent.click(zaviButton());
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("with the wallet authorized but no Zavi grant for this workspace, keeps the Zavi button off, says it is not ready and posts nothing", async () => {
    accepted = true;
    managed = [];
    available = [{ id: "558561881", name: "Held", currency: "USD", held_elsewhere: true }];
    open();
    await ownCard();
    await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
    expect(zaviButton().disabled).toBe(true);
    expect(within(walletCard()).getByTestId("linkedin-wallet-state").textContent).toBe("Zavi’s LinkedIn ad account is not ready for this workspace yet.");
    fireEvent.click(zaviButton());
    await settle();
    expect(posts()).toHaveLength(0);
    expect(screen.queryByText("In use")).toBeNull();
  });

  it("a refused Zavi pick shows the reason, marks nothing in use and is not retried on its own", async () => {
    accepted = true;
    available = [{ id: "558561881", name: "Held", currency: "USD", held_elsewhere: true }];
    open();
    await ownCard();
    await waitFor(() => expect(zaviButton().disabled).toBe(false));
    refuse = "Zavi's LinkedIn ad account is not ready for this workspace.";
    fireEvent.click(zaviButton());
    expect((await screen.findByRole("alert")).textContent).toContain(refuse);
    expect(screen.queryByText("In use")).toBeNull();
    expect(screen.queryByTestId("linkedin-account-error")).toBeNull();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await settle();
    expect(posts()).toHaveLength(1);
  });

  it("tells a view-only login and an empty login apart in the own card, with no account to pick in either", async () => {
    available = [{ id: "558561881", name: "Viewer Co", currency: "USD", view_only: true }];
    open();
    const own = await ownCard();
    await within(own).findByText(/Your LinkedIn login can only view Viewer Co/);
    expect(within(own).queryByText(/another Zavi workspace/)).toBeNull();
    expect(within(own).queryAllByRole("button")).toHaveLength(0);
    expect(own.textContent).not.toMatch(/Campaign Manager/);
    cleanup();
    h.api.mockClear();
    available = [];
    open();
    const empty = await ownCard();
    await within(empty).findByText("This LinkedIn login has no ad account.");
    expect(within(empty).queryAllByRole("button")).toHaveLength(0);
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("says LinkedIn paused the own account in use for billing, without sending the founder elsewhere, and stays quiet when it is not paused", async () => {
    accounts = [{ id: OWN, provider_account_id: "558561881", funding_source: "provider", currency: "USD", disabled: false, billing_hold: true }];
    selected = OWN;
    open();
    const own = await ownCard();
    await waitFor(() => expect(checked()).toEqual(["There Is A Tool For That · your account"]));
    expect(within(own).getByText("In use")).toBeTruthy();
    expect(within(own).getByText(/LinkedIn has paused this ad account for billing/)).toBeTruthy();
    expect(own.textContent).not.toMatch(/Campaign Manager/);
    expect(within(walletCard()).queryByText(/paused/)).toBeNull();
    cleanup();
    h.api.mockClear();
    accounts = [{ id: OWN, provider_account_id: "558561881", funding_source: "provider", currency: "USD", disabled: false }];
    open();
    const clear = await ownCard();
    await waitFor(() => expect(checked()).toEqual(["There Is A Tool For That · your account"]));
    expect(within(clear).queryByText(/paused/)).toBeNull();
  });

  it("does not call a selected account in use when the login can only view it", async () => {
    accounts = [{ id: OWN, provider_account_id: "111", funding_source: "provider", currency: "USD", disabled: false, view_only: true }];
    selected = OWN;
    available = [{ id: "111", name: "Viewer Co", currency: "USD", view_only: true }];
    open();
    const own = await ownCard();
    await within(own).findByText(/Your LinkedIn login can only view Viewer Co/);
    expect(screen.queryByText("In use")).toBeNull();
    expect(within(own).queryByText(/New campaigns run on/)).toBeNull();
    expect(within(own).queryAllByRole("button")).toHaveLength(0);
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("a member sees both cards and which one is in use, but no enabled action, no account list, no account id and no read of the login's list", async () => {
    h.role = "member";
    accepted = true;
    accounts = [{ id: OWN, provider_account_id: "558561881", funding_source: "provider", currency: "USD", disabled: false }];
    selected = OWN;
    open();
    const own = await ownCard();
    expect(within(own).getByText("In use")).toBeTruthy();
    expect(within(own).getByText("New campaigns run on your LinkedIn ad account.")).toBeTruthy();
    expect(own.textContent).not.toContain("558561881");
    const wallet = walletCard();
    expect(within(wallet).queryByText("In use")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(enabledButtons(own)).toHaveLength(0);
    expect(enabledButtons(wallet)).toHaveLength(0);
    expect(zaviButton().disabled).toBe(true);
    fireEvent.click(zaviButton());
    await settle();
    cleanup();
    h.api.mockClear();
    accounts = [];
    selected = null;
    availableFails = { code: "linkedin_ads_not_connected" };
    open();
    const none = await ownCard();
    expect(within(none).getByText(/No ad account of your own is in use here/)).toBeTruthy();
    expect(screen.queryByText("In use")).toBeNull();
    expect(within(none).queryAllByRole("button")).toHaveLength(0);
    expect(enabledButtons(walletCard())).toHaveLength(0);
    await settle();
    expect(h.api.mock.calls.filter(([p]) => String(p).startsWith(AVAILABLE))).toHaveLength(0);
    expect(posts()).toHaveLength(0);
    expect(h.connect).not.toHaveBeenCalled();
  });
});
