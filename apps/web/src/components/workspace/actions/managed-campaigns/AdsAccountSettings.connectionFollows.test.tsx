// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ api: vi.fn(), tab: { id: "channels" as string | undefined } }));
vi.mock("./api", () => ({ campaignFetch: h.api }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: async () => true }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner", activeTabId: h.tab.id }) }));

let AdsAccountSettings: typeof import("./AdsAccountSettings").AdsAccountSettings;
let reviews: typeof import("./campaignReviewPrefetch");

const BASE = "/api/ads/accounts/linkedin";
const OLD = "10000000-0000-4000-8000-000000000001";
const NEW = "10000000-0000-4000-8000-000000000002";
const row = (id: string, account: string) => ({ id, provider_account_id: account, funding_source: "provider", currency: "USD", disabled: false });
const managed = [{ account_id: "m", label: "Zavi account" }];
const wallet = (cents: number) => ({ balance_cents: cents, reserved_cents: 0, available_cents: cents, auto_refill_enabled: false, refill_cents: 0, threshold_cents: 0, pending: false, funding_enabled: true, last_error: null });
const OLD_LIST = { accounts: [{ id: "559148166", name: "Zavi QA", currency: "USD" }] };
const NEW_LIST = { accounts: [{ id: "560026764", name: "Mohit's Ad Account", currency: "USD" }] };
const campaign = (id: string, name: string) => ({ id, provider_campaign_id: id, funding_source: "provider", name, status: "ACTIVE" });

let n = 0;
let stampOld = "";
let stampNew = "";
let answers: Record<string, unknown>;
let holds: Record<string, Array<() => void>>;
let holding: Set<string>;
let visible = true;

const oldLogin = () => ({
  choices: { accounts: [row(OLD, "559148166")], managed, selected_id: OLD, unseen_selected_id: null, connection: stampOld },
  available: OLD_LIST,
  balance: wallet(50000),
  campaigns: { campaigns: [campaign("c-old", "Old login campaign")] },
});
const newLogin = () => ({
  choices: { accounts: [{ ...row(OLD, "559148166"), not_on_login: true }, row(NEW, "560026764")], managed, selected_id: NEW, unseen_selected_id: null, connection: stampNew },
  available: NEW_LIST,
  balance: wallet(7500),
  campaigns: { campaigns: [campaign("c-new", "New login campaign")] },
});
const slot = (path: string) => {
  if (path.startsWith(`${BASE}/available`)) return "available";
  if (path === BASE) return "choices";
  if (path === "/api/ads/wallet") return "balance";
  if (path.startsWith("/api/ads/campaigns?")) return "campaigns";
  if (path.endsWith("/reservations")) return "reservations";
  return null;
};

beforeEach(async () => {
  vi.resetModules();
  ({ AdsAccountSettings } = await import("./AdsAccountSettings"));
  reviews = await import("./campaignReviewPrefetch");
  n += 1;
  stampOld = `old-${n}`;
  stampNew = `new-${n}`;
  answers = oldLogin();
  holds = {};
  holding = new Set();
  visible = true;
  h.tab.id = "channels";
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", { configurable: true, value: () => visible });
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  h.api.mockReset();
  h.api.mockImplementation(async (path: string) => {
    if (path.endsWith("/consent")) return { version: "v1", text: "Authorize", accepted: false };
    const name = slot(path);
    if (!name) return { accounts: [] };
    const value = answers[name];
    if (holding.has(name)) await new Promise<void>((resolve) => (holds[name] ??= []).push(resolve));
    if (value instanceof Error) throw value;
    return value;
  });
});
afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as { checkVisibility?: unknown }).checkVisibility;
});

const page = (changed: () => void) => <AdsAccountSettings platform="linkedin" onConnectionChange={changed} />;
const reads = (name: string) => h.api.mock.calls.filter(([p]) => slot(p) === name).length;
const POSTS = (suffix: string) => h.api.mock.calls.filter(([p, o]) => String(p).endsWith(suffix) && o?.method === "POST").length;
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };
const loaded = () => screen.findByRole("heading", { name: "Shared wallet permission" });
async function open(changed = vi.fn()) {
  const view = render(page(changed));
  await loaded();
  await screen.findByText("$500.00");
  await waitFor(() => expect(reads("campaigns")).toBe(1));
  await waitFor(() => expect(reads("available")).toBe(1));
  await settle();
  return { ...view, changed };
}
const expectNewLogin = async () => {
  await screen.findByText("$75.00");
  await waitFor(() => expect(reads("campaigns")).toBe(2));
  expect(screen.queryByText("$500.00")).toBeNull();
  expect(screen.queryByText(/560026764|559148166/)).toBeNull();
};

it("returning by client navigation fires no browser event, and everything on the kept-alive page still follows", async () => {
  const { rerender, changed } = await open();
  visible = false;
  h.tab.id = "connectors";
  rerender(page(changed));
  await settle();
  expect(reads("choices")).toBe(1);
  answers = newLogin();
  visible = true;
  h.tab.id = "channels";
  rerender(page(changed));
  await expectNewLogin();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(reads("choices")).toBe(2);
  expect(POSTS("/connect")).toBe(0);
});

it("regaining focus swaps the balance and rereads the campaigns too, not just the account", async () => {
  const { changed } = await open();
  answers = newLogin();
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await expectNewLogin();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(POSTS("/connect")).toBe(0);
});

it("a page hidden behind another workspace tab reads nothing when the browser window regains focus", async () => {
  await open();
  visible = false;
  const choices = reads("choices");
  await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await settle();
  expect(reads("choices")).toBe(choices);
});

it("hidden behind another channel tab, it still follows the login while the page itself is on screen", async () => {
  const changed = vi.fn();
  render(<AdsAccountSettings platform="linkedin" settingsPage hidden onConnectionChange={changed} />);
  await waitFor(() => expect(reads("choices")).toBe(1));
  await waitFor(() => expect(reads("available")).toBe(1));
  await settle();
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", { configurable: true, value(this: HTMLElement) { return this.tagName !== "DETAILS"; } });
  answers = newLogin();
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(reads("choices")).toBe(2));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(document.querySelector("details")?.hidden).toBe(true);
});

it("a reconnect to a login that sees the same accounts still tells the page, so the old login's dashboard error can clear", async () => {
  const { changed } = await open();
  const heard = vi.fn();
  window.addEventListener(reviews.ADS_CONNECTION_CHANGED_EVENT, heard);
  answers = { ...oldLogin(), choices: { ...oldLogin().choices, connection: stampNew } };
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(heard).toHaveBeenCalledTimes(1);
  window.removeEventListener(reviews.ADS_CONNECTION_CHANGED_EVENT, heard);
});

it("a failed stamp read does not look like a reconnect: the open launch form survives", async () => {
  const { changed } = await open();
  answers = { ...oldLogin(), choices: { ...oldLogin().choices, connection: null } };
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await waitFor(() => expect(reads("available")).toBe(2));
  await settle();
  expect(changed).not.toHaveBeenCalled();
  expect(reads("campaigns")).toBe(1);
});

it("the old login's mount reads landing after the new login's reread cannot put the old login back", async () => {
  holding = new Set(["choices", "available"]);
  const changed = vi.fn();
  render(page(changed));
  await waitFor(() => expect(holds.choices?.length).toBe(1));
  await waitFor(() => expect(holds.available?.length).toBe(1));
  const slow = [...holds.choices, ...holds.available];
  holds = {};
  holding = new Set();
  answers = newLogin();
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await loaded();
  await waitFor(() => expect(reads("choices")).toBe(2));
  await settle();
  expect(changed).not.toHaveBeenCalled();
  answers = oldLogin();
  await act(async () => { slow.forEach((go) => go()); });
  await settle();
  expect(changed).not.toHaveBeenCalled();
  expect(POSTS("/connect")).toBe(0);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(reads("choices")).toBe(3));
  await settle();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(POSTS("/connect")).toBe(0);
});

it("a read that lands mid-mount is the first answer, not a change of connection", async () => {
  holding = new Set(["available"]);
  const changed = vi.fn();
  render(page(changed));
  await waitFor(() => expect(holds.available?.length).toBe(1));
  await loaded();
  const slow = holds.available;
  holds = {};
  holding = new Set();
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(reads("available")).toBe(2));
  await settle();
  await act(async () => { slow.forEach((go) => go()); });
  await settle();
  expect(changed).not.toHaveBeenCalled();
  expect(reads("campaigns")).toBe(1);
  expect(POSTS("/connect")).toBe(0);
});

it("the account list failing still moves the rest of the page", async () => {
  const { changed } = await open();
  answers = { ...newLogin(), available: new Error("LinkedIn is busy") };
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await screen.findByText("$75.00");
  await waitFor(() => expect(reads("campaigns")).toBe(2));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("a disconnect after a failed list read still tells the page and binds nothing", async () => {
  const none = { ...oldLogin().choices, accounts: [], selected_id: null };
  answers = { ...oldLogin(), choices: none, available: new Error("LinkedIn is busy") };
  const changed = vi.fn();
  render(page(changed));
  await loaded();
  await waitFor(() => expect(reads("available")).toBe(1));
  await settle();
  answers = { ...oldLogin(), choices: none, available: Object.assign(new Error("gone"), { code: "linkedin_ads_not_connected" }) };
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  await settle();
  expect(POSTS("/connect")).toBe(0);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("a warm remount after the connection moved drops the cached launch form and tells the page", async () => {
  const first = await open();
  first.unmount();
  const path = "/api/channels/linkedin_ads/actions/a1/review";
  const release = reviews.holdCampaignReview(path);
  await waitFor(() => expect(reviews.cachedCampaignReview(path)).toBeDefined());
  answers = newLogin();
  const changed = vi.fn();
  render(page(changed));
  await expectNewLogin();
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(reviews.cachedCampaignReview(path)).toBeUndefined();
  release();
});

it("non-regression guard: a warm remount on the same connection leaves the cached launch form alone", async () => {
  const first = await open();
  first.unmount();
  const path = "/api/channels/linkedin_ads/actions/a2/review";
  const release = reviews.holdCampaignReview(path);
  await waitFor(() => expect(reviews.cachedCampaignReview(path)).toBeDefined());
  const changed = vi.fn();
  render(page(changed));
  await loaded();
  await screen.findByText("$500.00");
  await settle();
  expect(changed).not.toHaveBeenCalled();
  expect(reviews.cachedCampaignReview(path)).toBeDefined();
  release();
});

const launched = async () => {
  const { announceChannelDashboardStale } = await import("../campaignLinks");
  await act(async () => { announceChannelDashboardStale("linkedin_ads"); });
};

it("a launch shows the new balance straight away, without re-reading the campaigns or the account", async () => {
  await open();
  const campaignReads = reads("campaigns");
  answers = { ...oldLogin(), balance: wallet(49000) };
  await launched();
  await screen.findByText("$490.00");
  expect(screen.queryByText("$500.00")).toBeNull();
  expect(reads("campaigns")).toBe(campaignReads);
  expect(reads("choices")).toBe(1);
  expect(reads("reservations")).toBe(0);
});

it("another channel going stale reads nothing", async () => {
  await open();
  const before = reads("balance");
  const { announceChannelDashboardStale } = await import("../campaignLinks");
  await act(async () => { announceChannelDashboardStale("meta_ads"); });
  await settle();
  expect(reads("balance")).toBe(before);
  expect(screen.getByText("$500.00")).toBeTruthy();
});

it("an older wallet read landing after a newer one cannot bring back the old balance", async () => {
  await open();
  holding = new Set(["balance"]);
  answers = { ...oldLogin(), balance: wallet(49000) };
  await launched();
  await waitFor(() => expect(holds.balance?.length).toBe(1));
  const older = holds.balance;
  holds = {};
  holding = new Set();
  answers = { ...oldLogin(), balance: wallet(48000) };
  await launched();
  await screen.findByText("$480.00");
  await act(async () => { older.forEach((go) => go()); });
  await settle();
  expect(screen.getByText("$480.00")).toBeTruthy();
  expect(screen.queryByText("$490.00")).toBeNull();
});

it("never reads the wallet reservations", async () => {
  await open();
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(reads("choices")).toBe(2));
  await launched();
  await settle();
  expect(reads("reservations")).toBe(0);
  expect(screen.queryByText(/reserved/)).toBeNull();
});

const during = (suffix: string, answer: () => Promise<unknown>) => {
  const base = h.api.getMockImplementation()!;
  h.api.mockImplementation(async (path: string, opts?: { method?: string }) => (path.endsWith(suffix) && opts?.method === "POST" ? answer() : base(path, opts)));
};

it("the auto-bind tells the page only once the server has saved the account, never before", async () => {
  answers.choices = { ...oldLogin().choices, accounts: [], selected_id: null };
  let saved = () => {};
  during("/connect", () => new Promise((resolve) => { saved = () => { answers.choices = oldLogin().choices; resolve({ ok: true }); }; }));
  const changed = vi.fn();
  render(page(changed));
  await waitFor(() => expect(POSTS("/connect")).toBe(1));
  await settle();
  expect(changed).not.toHaveBeenCalled();
  expect(reads("choices")).toBe(1);
  await act(async () => { saved(); });
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(reads("choices")).toBe(2));
  await waitFor(() => expect(reads("campaigns")).toBe(2));
  expect(POSTS("/connect")).toBe(1);
});

it("turning a stopped binding back on refreshes the dashboard", async () => {
  answers.choices = { ...oldLogin().choices, accounts: [{ ...row(OLD, "559148166"), disabled: true }], selected_id: null };
  during("/enable", async () => { answers.choices = oldLogin().choices; return { ok: true }; });
  const changed = vi.fn();
  render(page(changed));
  await waitFor(() => expect(POSTS("/enable")).toBe(1));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(reads("choices")).toBe(2));
  await waitFor(() => expect(reads("campaigns")).toBe(2));
  expect(POSTS("/connect")).toBe(0);
});

it("a refused auto-bind leaves the dashboard alone, because nothing changed", async () => {
  answers.choices = { ...oldLogin().choices, accounts: [{ ...row(OLD, "559148166"), disabled: true }], selected_id: null };
  during("/enable", async () => { throw new Error("LinkedIn said no."); });
  const changed = vi.fn();
  render(page(changed));
  await waitFor(() => expect(POSTS("/enable")).toBe(1));
  await settle();
  expect(changed).not.toHaveBeenCalled();
  expect(POSTS("/enable")).toBe(1);
  expect(reads("campaigns")).toBe(1);
  expect(reads("choices")).toBe(1);
});

const ownCopy = /Campaigns on your own account are billed by LinkedIn Ads\. Only campaigns on a Zavi account use your shared ads balance\./;
const consent = (accepted: boolean) => {
  const base = h.api.getMockImplementation()!;
  h.api.mockImplementation(async (path: string, opts?: { method?: string }) => (path.endsWith("/consent") ? { version: "v1", text: "Terms", accepted } : base(path, opts)));
};

it.each([[true], [false]])("a founder on their own account is not told campaigns come out of the shared balance (permission %s)", async (accepted) => {
  consent(accepted);
  await open();
  expect(await screen.findByText(ownCopy)).toBeTruthy();
  expect(screen.queryByText("Approved campaigns are paid from your shared ads balance.")).toBeNull();
  expect(screen.queryByText("Pay for approved campaigns from your shared ads balance.")).toBeNull();
});

it("a founder on a Zavi account still reads that the shared balance pays", async () => {
  consent(true);
  answers.choices = { ...oldLogin().choices, accounts: [{ ...row(OLD, "559148166"), account_id: "m", funding_source: "wallet" }] };
  render(page(vi.fn()));
  expect(await screen.findByText("Approved campaigns are paid from your shared ads balance.")).toBeTruthy();
  expect(screen.queryByText(ownCopy)).toBeNull();
  await waitFor(() => expect(reads("available")).toBe(1));
  await settle();
  expect(POSTS("/connect")).toBe(0);
});

it("a stopped own account no longer counts, so the copy does not promise its billing", async () => {
  consent(true);
  answers.choices = { ...oldLogin().choices, accounts: [{ ...row(OLD, "559148166"), disabled: true }] };
  answers.available = { accounts: [] };
  render(page(vi.fn()));
  await screen.findByText("Approved campaigns are paid from your shared ads balance.");
  expect(screen.queryByText(ownCopy)).toBeNull();
  await settle();
  expect(POSTS("/enable")).toBe(0);
});
