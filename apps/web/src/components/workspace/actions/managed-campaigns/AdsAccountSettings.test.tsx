// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
afterEach(cleanup);
const api = vi.hoisted(() => vi.fn());
const h = vi.hoisted(() => ({
  role: null as string | null,
  confirm: vi.fn(async (..._a: unknown[]) => true),
}));
vi.mock("./api", () => ({ campaignFetch: api }));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspaceOptional: () => (h.role ? { role: h.role } : null),
}));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: h.confirm }));
vi.mock("./ChannelBalance", () => ({
  ChannelBalance: (p: { platform?: string }) => (
    <div data-platform={p.platform ?? ""}>Shared balance</div>
  ),
}));
vi.mock("./BoundAdsCampaigns", () => ({
  BoundAdsCampaigns: () => <div>Bound campaign list</div>,
}));
import { AdsAccountSettings } from "./AdsAccountSettings";
const binding = "10000000-0000-4000-8000-000000000001";
const LINKEDIN = "/api/ads/accounts/linkedin";
const CAMPAIGNS = "/api/ads/campaigns?platform=linkedin";
beforeEach(() => {
  vi.resetAllMocks();
  h.role = null;
  h.confirm.mockResolvedValue(true);
  api.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (opts?.method === "POST") return { ok: true };
    if (path.includes("/available"))
      return { accounts: [{ id: "original", name: "Acme main", currency: "USD" }], fetched_at: new Date().toISOString(), just_refreshed: false };
    if (path.endsWith("/consent"))
      return {
        version: "shared_ads_wallet_v1",
        text: "Authorize my shared ads wallet",
        accepted: false,
      };
    if (path.endsWith("/reservations"))
      return {
        reservations: [
          {
            campaign_binding_id: "c",
            provider_campaign_id: "123",
            platform: "chatgpt",
            provider_account_id: "own-original",
            reserved_cents: 6000,
            spent_cents: 1000,
          },
          {
            campaign_binding_id: "l1",
            provider_campaign_id: "9876",
            platform: "linkedin",
            provider_account_id: "5123",
            reserved_cents: 2500,
            spent_cents: 0,
          },
          {
            campaign_binding_id: "l2",
            provider_campaign_id: "555",
            platform: "linkedin",
            provider_account_id: "5123",
            reserved_cents: 0,
            spent_cents: 0,
          },
        ],
      };
    if (path === CAMPAIGNS)
      return {
        campaigns: [
          { id: "l1", name: "Spring launch", funding_source: "provider", status: "ACTIVE" },
          { id: "l2", name: null, funding_source: "provider", status: "ACTIVE" },
        ],
      };
    return {
      accounts: [
        {
          id: binding,
          provider_account_id: "original",
          funding_source: "provider",
          currency: "USD",
          disabled: false,
        },
      ],
      managed: [{ account_id: "managed", label: "Zavi advertiser" }],
      selected_id: binding,
    };
  });
});
const gets = (suffix: string) =>
  api.mock.calls.filter(
    ([p, o]) => p === suffix && !(o as { method?: string } | undefined)?.method,
  ).length;
const posts = () =>
  api.mock.calls.filter(
    ([, o]) => (o as { method?: string } | undefined)?.method === "POST",
  );
const tick = () => new Promise((r) => setTimeout(r, 0));
const openLinkedIn = (onConnectionChange?: () => void) => {
  render(<AdsAccountSettings platform="linkedin" onConnectionChange={onConnectionChange} />);
  fireEvent.click(screen.getByText("Ad account and shared wallet"));
};

it("Authorize shared wallet shows the terms in a popup, sends nothing when cancelled, and posts the accepted version when confirmed", async () => {
  h.role = "owner";
  h.confirm.mockResolvedValueOnce(false);
  openLinkedIn();
  const authorize = await screen.findByRole("button", { name: "Authorize shared wallet" });
  expect(screen.getByText("Zavi is not allowed to pay for campaigns from your shared ads balance.")).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(authorize);
  await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
  const [options] = h.confirm.mock.calls[0] as [{ title: string; body: ReactNode; confirmLabel: string; size: string }];
  expect(options.title).toBe("Authorize the shared wallet");
  expect(options.confirmLabel).toBe("I authorize");
  expect(options.size).toBe("lg");
  const popup = render(<>{options.body}</>);
  expect(popup.getByTestId("consent-terms-popup").textContent).toBe("Authorize my shared ads wallet");
  popup.unmount();
  await tick();
  expect(posts()).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Authorize shared wallet" }));
  await waitFor(() =>
    expect(posts()).toEqual([
      ["/api/ads/wallet/consent", { method: "POST", body: JSON.stringify({ version: "shared_ads_wallet_v1", accept: true }) }],
    ]),
  );
});

it("after authorizing, counts LinkedIn campaigns still paused on the wallet from the silent campaigns read, not from a campaign list", async () => {
  h.role = "owner";
  let accepted = false;
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (opts?.method === "POST" && path === "/api/ads/wallet/consent") {
      accepted = true;
      return { ok: true };
    }
    if (path === "/api/ads/wallet/consent") return { version: "shared_ads_wallet_v1", text: "Authorize my shared ads wallet", accepted };
    if (path === CAMPAIGNS)
      return {
        campaigns: [
          { id: "l1", name: "Spring launch", funding_source: "wallet", status: accepted ? "PAUSED" : "ACTIVE" },
          { id: "l2", name: "Own one", funding_source: "provider", status: "PAUSED" },
          { id: "l3", name: "Other", funding_source: "wallet", status: "paused" },
        ],
      };
    return base(path, opts);
  });
  openLinkedIn();
  fireEvent.click(await screen.findByRole("button", { name: "Authorize shared wallet" }));
  await screen.findByTestId("reauthorized-followup");
  await waitFor(() =>
    expect(screen.getByTestId("reauthorized-followup").textContent).toContain("2 LinkedIn campaigns paid from your shared ads balance are still paused."),
  );
  expect(gets(CAMPAIGNS)).toBe(2);
  expect(screen.queryByText("Bound campaign list")).toBeNull();
});

it("reads the LinkedIn campaigns silently, never the wallet reservations, and shows no campaign list", async () => {
  openLinkedIn();
  await screen.findByRole("heading", { name: "Shared wallet permission" });
  await waitFor(() => expect(gets(CAMPAIGNS)).toBe(1));
  await tick();
  expect(gets("/api/ads/wallet/reservations")).toBe(0);
  expect(screen.queryByRole("listitem")).toBeNull();
  expect(screen.queryByText("Bound campaign list")).toBeNull();
  expect(screen.queryByText(/reserved/)).toBeNull();
});

it("submits a customer API key only to its dedicated connection operation and clears it afterwards", async () => {
  render(<AdsAccountSettings platform="chatgpt" />);
  fireEvent.click(screen.getByText("Ad account and shared wallet"));
  const key = await screen.findByLabelText("ChatGPT advertiser API key");
  fireEvent.change(key, { target: { value: "synthetic-customer-key" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Verify and connect account" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/api/ads/accounts/chatgpt/connect", {
      method: "POST",
      body: JSON.stringify({
        mode: "customer_key",
        api_key: "synthetic-customer-key",
      }),
    }),
  );
  await waitFor(() => expect((key as HTMLInputElement).value).toBe(""));
});

it("ChatGPT keeps its campaign list and never reads the LinkedIn campaigns endpoint", async () => {
  render(<AdsAccountSettings platform="chatgpt" />);
  fireEvent.click(screen.getByText("Ad account and shared wallet"));
  await screen.findByText("Bound campaign list");
  await tick();
  expect(screen.getAllByText("Bound campaign list")).toHaveLength(1);
  expect(gets(CAMPAIGNS)).toBe(0);
  expect(api.mock.calls.filter(([p]) => String(p).includes("/available"))).toEqual([]);
});

it("tells the shared-balance card it is on the LinkedIn page", async () => {
  openLinkedIn();
  const card = await screen.findByText("Shared balance");
  expect(card.getAttribute("data-platform")).toBe("linkedin");
});

it("an owner with an own account already in use reads the login's accounts once and binds nothing", async () => {
  h.role = "owner";
  openLinkedIn();
  await screen.findByRole("heading", { name: "Shared wallet permission" });
  await waitFor(() => expect(gets(CAMPAIGNS)).toBe(1));
  await tick();
  await tick();
  expect(api.mock.calls.filter(([p]) => p === `${LINKEDIN}/available`)).toHaveLength(1);
  expect(api.mock.calls.some(([p]) => String(p).includes("refresh=1"))).toBe(false);
  expect(posts()).toEqual([]);
  expect(gets(LINKEDIN)).toBe(1);
  expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
  expect(screen.getAllByText(/Acme main/)).toHaveLength(1);
  expect(within(screen.getByTestId("linkedin-own-card")).getByRole("radio", { name: "Acme main · your account" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByText(/original/)).toBeNull();
});

function withChoices(
  choices: () => { accounts: unknown[]; managed: unknown[]; selected_id: string | null },
  onPost?: (path: string, body: unknown) => unknown,
  available: () => unknown = () => ({ accounts: [{ id: "original", name: "Acme main", currency: "USD" }] }),
) {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, opts?: { method?: string; body?: string }) => {
    if (opts?.method === "POST") return onPost ? onPost(path, JSON.parse(opts.body ?? "null")) : { ok: true };
    if (path.includes("/available")) return available();
    if (path === LINKEDIN) return choices();
    return base(path, opts);
  });
}
function withState(accepted: () => boolean, onPost?: (path: string, body: unknown) => unknown) {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, opts?: { method?: string; body?: string }) => {
    if (opts?.method === "POST" && onPost) return onPost(path, JSON.parse(opts.body ?? "null"));
    if (path === "/api/ads/wallet/consent" && !opts?.method)
      return { version: "shared_ads_wallet_v1", text: "Authorize my shared ads wallet", accepted: accepted() };
    return base(path, opts);
  });
}

const own = (id: string, account: string, disabled = false) => ({ id, provider_account_id: account, funding_source: "provider", currency: "USD", disabled });

it("auto-binds the login's first ad account by selecting its existing binding, then shows it as connected", async () => {
  h.role = "owner";
  let selected: string | null = null;
  const onConnectionChange = vi.fn();
  withChoices(
    () => ({ accounts: [own(binding, "original")], managed: [], selected_id: selected }),
    (path, body) => {
      expect(path).toBe(`${LINKEDIN}/select`);
      expect(body).toEqual({ account_binding_id: binding });
      selected = binding;
      return { ok: true };
    },
  );
  openLinkedIn(onConnectionChange);
  await waitFor(() => expect(gets(LINKEDIN)).toBe(2));
  await waitFor(() => expect(gets(CAMPAIGNS)).toBe(2));
  expect(posts()).toEqual([[`${LINKEDIN}/select`, { method: "POST", body: JSON.stringify({ account_binding_id: binding }) }]]);
  expect(onConnectionChange).toHaveBeenCalledTimes(1);
  await tick();
  await tick();
  expect(posts()).toHaveLength(1);
  expect(gets(LINKEDIN)).toBe(2);
});

it("auto-binds by connecting the account when no binding exists for it, and reloads only once the server has saved it", async () => {
  h.role = "owner";
  let bound = false;
  let release = () => {};
  withChoices(
    () => (bound ? { accounts: [own(binding, "original")], managed: [], selected_id: binding } : { accounts: [], managed: [], selected_id: null }),
    (path, body) =>
      new Promise((resolve) => {
        release = () => {
          expect(path).toBe(`${LINKEDIN}/connect`);
          expect(body).toEqual({ mode: "customer", account_id: "original" });
          bound = true;
          resolve({ ok: true });
        };
      }),
  );
  openLinkedIn();
  await waitFor(() => expect(posts()).toHaveLength(1));
  await tick();
  await tick();
  expect(gets(LINKEDIN)).toBe(1);
  expect(screen.queryByRole("alert")).toBeNull();
  release();
  await waitFor(() => expect(gets(LINKEDIN)).toBe(2));
  expect(posts()).toEqual([[`${LINKEDIN}/connect`, { method: "POST", body: JSON.stringify({ mode: "customer", account_id: "original" }) }]]);
  await tick();
  await tick();
  expect(posts()).toHaveLength(1);
});

it("auto-binds a stopped binding of the login's account by turning it back on", async () => {
  h.role = "owner";
  let enabled = false;
  withChoices(
    () => ({ accounts: [own(binding, "559880687", !enabled)], managed: [], selected_id: binding }),
    (path, body) => {
      expect(path).toBe(`${LINKEDIN}/enable`);
      expect(body).toEqual({ account_binding_id: binding });
      enabled = true;
      return { ok: true, account: { id: binding, disabled: false } };
    },
    () => ({ accounts: [{ id: "559880687", name: "Acme main", currency: "USD" }] }),
  );
  openLinkedIn();
  await waitFor(() => expect(gets(LINKEDIN)).toBe(2));
  expect(posts()).toEqual([[`${LINKEDIN}/enable`, { method: "POST", body: JSON.stringify({ account_binding_id: binding }) }]]);
  await tick();
  await tick();
  expect(posts()).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("skips an account another workspace holds and binds the next one", async () => {
  h.role = "owner";
  withChoices(
    () => ({ accounts: [], managed: [], selected_id: null }),
    undefined,
    () => ({
      accounts: [
        { id: "taken", name: "Taken", currency: "USD", held_elsewhere: true },
        { id: "free", name: "Free one", currency: "USD" },
      ],
    }),
  );
  openLinkedIn();
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()).toEqual([[`${LINKEDIN}/connect`, { method: "POST", body: JSON.stringify({ mode: "customer", account_id: "free" }) }]]);
});

it.each([
  [404, "That ad account is no longer connected. Reconnect LinkedIn Ads in Connectors."],
  [502, "LinkedIn did not confirm access to this ad account. Try again in a few minutes."],
])("a %s from the auto-bind is not retried, by reopening the panel or by coming back to the tab", async (status, message) => {
  h.role = "admin";
  withChoices(
    () => ({ accounts: [own(binding, "original", true)], managed: [], selected_id: binding }),
    () => {
      throw Object.assign(new Error(message), { status, code: "x" });
    },
  );
  openLinkedIn();
  await waitFor(() => expect(posts()).toHaveLength(1));
  await screen.findByRole("heading", { name: "Shared wallet permission" });
  fireEvent.click(screen.getByText("Ad account and shared wallet"));
  fireEvent.click(screen.getByText("Ad account and shared wallet"));
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(api.mock.calls.filter(([p]) => p === `${LINKEDIN}/available`)).toHaveLength(2));
  await tick();
  await tick();
  expect(posts()).toEqual([[`${LINKEDIN}/enable`, { method: "POST", body: JSON.stringify({ account_binding_id: binding }) }]]);
  expect(gets(LINKEDIN)).toBe(2);
});

it("binds once per login and account: a reload that still shows nothing selected does not post again", async () => {
  h.role = "owner";
  withChoices(() => ({ accounts: [], managed: [], selected_id: null }));
  openLinkedIn();
  await waitFor(() => expect(posts()).toHaveLength(1));
  await waitFor(() => expect(gets(LINKEDIN)).toBe(2));
  await tick();
  await tick();
  expect(posts()).toHaveLength(1);
});

it("a selected Zavi account is paid from the shared balance, is not described as own billing, and binds nothing", async () => {
  h.role = "owner";
  const first = "20000000-0000-4000-8000-000000000011";
  const second = "20000000-0000-4000-8000-000000000012";
  withState(() => true);
  withChoices(() => ({
    accounts: [
      { id: first, account_id: "grant-a", provider_account_id: "508000111", funding_source: "wallet", currency: "USD", disabled: false },
      { id: second, account_id: "grant-b", provider_account_id: "508000222", funding_source: "wallet", currency: "USD", disabled: false },
    ],
    managed: [
      { account_id: "grant-a", label: "Zavi North" },
      { account_id: "grant-b", label: "Zavi South" },
    ],
    selected_id: second,
  }));
  openLinkedIn();
  await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
  expect(screen.getByText("Approved campaigns are paid from your shared ads balance.")).toBeTruthy();
  expect(screen.queryByText(/billed by LinkedIn Ads/)).toBeNull();
  expect(screen.getByText("Wallet authorized")).toBeTruthy();
  await waitFor(() => expect(api.mock.calls.filter(([p]) => p === `${LINKEDIN}/available`)).toHaveLength(1));
  await tick();
  await tick();
  expect(posts()).toEqual([]);
});

it("a selected Zavi account with the wallet permission withdrawn shows the wallet as not authorized and is not swapped for the login's own account", async () => {
  h.role = "owner";
  const wallet = "20000000-0000-4000-8000-000000000002";
  withChoices(() => ({
    accounts: [{ id: wallet, account_id: "managed", provider_account_id: "508123456", funding_source: "wallet", currency: "USD", disabled: false }],
    managed: [{ account_id: "managed", label: "Zavi advertiser" }],
    selected_id: wallet,
  }));
  openLinkedIn();
  await screen.findByRole("button", { name: "Authorize shared wallet" });
  expect(screen.getByText("Wallet not authorized")).toBeTruthy();
  expect(screen.getByText("Zavi is not allowed to pay for campaigns from your shared ads balance.")).toBeTruthy();
  await waitFor(() => expect(api.mock.calls.filter(([p]) => p === `${LINKEDIN}/available`)).toHaveLength(1));
  await tick();
  await tick();
  expect(posts()).toEqual([]);
});

it.each([["member"], ["viewer"]])(
  "a %s cannot bind or change the wallet permission and is told why",
  async (role) => {
    h.role = role;
    const base = api.getMockImplementation()!;
    api.mockImplementation(async (path: string, opts?: { method?: string }) =>
      path === "/api/ads/wallet/consent" && !opts?.method
        ? { version: "shared_ads_wallet_v1", text: "Authorize my shared ads wallet", accepted: true }
        : path === LINKEDIN && !opts?.method
          ? { accounts: [own(binding, "original", true)], managed: [], selected_id: binding }
          : base(path, opts),
    );
    openLinkedIn();
    await screen.findByText(/Only a workspace owner or admin can change the (ad account or the )?shared wallet permission/);
    const withdraw = screen.getByRole("button", { name: "Withdraw shared-wallet permission" }) as HTMLButtonElement;
    expect(withdraw.disabled).toBe(true);
    expect(withdraw.title).toMatch(/owner or admin/);
    expect(screen.getByText("Wallet authorized")).toBeTruthy();
    fireEvent.click(withdraw);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(gets(LINKEDIN)).toBe(2));
    await tick();
    await tick();
    expect(posts()).toEqual([]);
    expect(api.mock.calls.filter(([p]) => String(p).includes("/available"))).toEqual([]);
    expect(h.confirm).not.toHaveBeenCalled();
  },
);

it("a member cannot authorize the shared wallet either", async () => {
  h.role = "member";
  openLinkedIn();
  const authorize = (await screen.findByRole("button", { name: "Authorize shared wallet" })) as HTMLButtonElement;
  expect(authorize.disabled).toBe(true);
  expect(authorize.title).toMatch(/owner or admin/);
  fireEvent.click(authorize);
  await tick();
  expect(h.confirm).not.toHaveBeenCalled();
  expect(posts()).toEqual([]);
});

it("an owner keeps every control", async () => {
  h.role = "owner";
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, opts?: { method?: string }) =>
    path === "/api/ads/wallet/consent" && !opts?.method
      ? { version: "shared_ads_wallet_v1", text: "Authorize my shared ads wallet", accepted: true }
      : base(path, opts),
  );
  openLinkedIn();
  const withdraw = (await screen.findByRole("button", { name: "Withdraw shared-wallet permission" })) as HTMLButtonElement;
  expect(withdraw.disabled).toBe(false);
  expect(withdraw.title).toBe("");
  expect(screen.queryByText(/Only a workspace owner or admin/)).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  await waitFor(() => expect(api.mock.calls.filter(([p]) => p === `${LINKEDIN}/available`)).toHaveLength(1));
});

it("withdrawing asks first, names only wallet-paid LinkedIn campaigns, and sends nothing when cancelled", async () => {
  h.role = "owner";
  h.confirm.mockResolvedValue(false);
  withState(() => true);
  openLinkedIn();
  fireEvent.click(await screen.findByRole("button", { name: "Withdraw shared-wallet permission" }));
  await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
  const [options] = h.confirm.mock.calls[0] as [{ title: string; description: string; tone: string }];
  expect(options.tone).toBe("danger");
  expect(options.description).toMatch(/LinkedIn campaigns paid from your shared ads balance will be paused/);
  expect(options.description).toMatch(/auto-refill will be turned off/);
  expect(options.description).toMatch(/Campaigns you launched yourself on your own LinkedIn billing keep running; ones Autopilot launched are paused/);
  expect(options.description).not.toMatch(/Campaigns billed to your own LinkedIn account keep running/);
  const standing = screen.getByText(/Withdrawing pauses LinkedIn campaigns paid from/).textContent ?? "";
  expect(standing.replace(/\s+/g, " ")).toMatch(/campaigns you launched yourself on your own LinkedIn billing keep running; ones Autopilot launched are paused/);
  await tick();
  expect(posts()).toEqual([]);
  expect(screen.getAllByText("Authorized").length).toBeGreaterThan(0);
});

it("after a withdrawal whose LinkedIn pauses are still pending, the page reloads and shows permission withdrawn", async () => {
  h.role = "owner";
  let accepted = true;
  withState(
    () => accepted,
    (path, body) => {
      if (path === "/api/ads/wallet/consent" && (body as { accept: boolean }).accept === false) {
        accepted = false;
        throw Object.assign(new Error("Consent is withdrawn; some LinkedIn pauses could not be confirmed yet and will be retried."), {
          status: 502,
          code: "ads_stops_pending",
        });
      }
      return { ok: true };
    },
  );
  openLinkedIn();
  fireEvent.click(await screen.findByRole("button", { name: "Withdraw shared-wallet permission" }));
  await waitFor(() => expect(gets("/api/ads/wallet/consent")).toBe(2));
  expect(posts()).toEqual([
    ["/api/ads/wallet/consent", { method: "POST", body: JSON.stringify({ version: "shared_ads_wallet_v1", accept: false }) }],
  ]);
  await screen.findByText("Not authorized");
  expect(screen.queryByRole("button", { name: "Withdraw shared-wallet permission" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe(
    "Consent is withdrawn; some LinkedIn pauses could not be confirmed yet and will be retried.",
  );
});

it("a pending stop nobody will retry is shown in the server's words, never as Zavi still retrying", async () => {
  h.role = "owner";
  let accepted = true;
  const serverSaid = "Your consent is withdrawn. Autopilot cannot launch LinkedIn campaigns any more. Zavi could not check which campaigns Autopilot already launched on accounts LinkedIn bills you for directly, so they may still be running. Pause them from your LinkedIn campaign list.";
  withState(
    () => accepted,
    (path, body) => {
      if (path === "/api/ads/wallet/consent" && (body as { accept: boolean }).accept === false) {
        accepted = false;
        throw Object.assign(new Error(serverSaid), { status: 502, code: "ads_stops_pending" });
      }
      return { ok: true };
    },
  );
  openLinkedIn();
  fireEvent.click(await screen.findByRole("button", { name: "Withdraw shared-wallet permission" }));
  await screen.findByText("Not authorized");
  const shown = screen.getByRole("alert").textContent ?? "";
  expect(shown).toBe(serverSaid);
  expect(shown).not.toMatch(/retry|retrying/i);
});

it.each([
  ["not connected", 400, "linkedin_ads_not_connected", "LinkedIn Ads is not connected"],
  ["revoked", 403, "linkedin_ads_token_revoked", "LinkedIn Ads needs to be reconnected. Reconnect it from Connectors in the left menu."],
  ["down", 502, "linkedin_ads_http_error", "LinkedIn is down"],
])("an account list refused because LinkedIn is %s binds nothing, keeps the wallet section and raises no error", async (_label, status, code, message) => {
  h.role = "owner";
  withChoices(
    () => ({ accounts: [], managed: [], selected_id: null }),
    undefined,
    () => {
      throw Object.assign(new Error(message), { status, code });
    },
  );
  openLinkedIn();
  await screen.findByRole("button", { name: "Authorize shared wallet" });
  await waitFor(() => expect(api.mock.calls.filter(([p]) => p === `${LINKEDIN}/available`)).toHaveLength(1));
  await tick();
  await tick();
  expect(posts()).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(message)).toBeNull();
  expect(screen.getByText("Shared balance")).toBeTruthy();
});

it("a login with no ad account binds nothing", async () => {
  h.role = "owner";
  withChoices(() => ({ accounts: [], managed: [], selected_id: null }), undefined, () => ({ accounts: [] }));
  openLinkedIn();
  await screen.findByRole("button", { name: "Authorize shared wallet" });
  await waitFor(() => expect(api.mock.calls.filter(([p]) => p === `${LINKEDIN}/available`)).toHaveLength(1));
  await tick();
  await tick();
  expect(posts()).toEqual([]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("a withdrawal that applied but has pauses still unconfirmed refreshes the dashboard, campaign rows and approvals too", async () => {
  h.role = "owner";
  let accepted = true;
  const onConnectionChange = vi.fn();
  withState(
    () => accepted,
    (path, body) => {
      if (path === "/api/ads/wallet/consent" && (body as { accept: boolean }).accept === false) {
        accepted = false;
        throw Object.assign(new Error("Your consent is withdrawn. Some LinkedIn campaigns Zavi pays for are not confirmed paused yet."), { status: 409, code: "ads_stops_pending" });
      }
      return { ok: true };
    },
  );
  openLinkedIn(onConnectionChange);
  fireEvent.click(await screen.findByRole("button", { name: "Withdraw shared-wallet permission" }));
  await screen.findByText("Not authorized");
  expect(onConnectionChange).toHaveBeenCalledTimes(1);
});

it("a failed withdrawal that changed nothing does not tell the page anything moved", async () => {
  h.role = "owner";
  const onConnectionChange = vi.fn();
  withState(() => true, () => {
    throw Object.assign(new Error("Zavi could not withdraw your shared wallet permission just now, so it is still authorized and no campaign was paused. Try again in a minute."), { status: 503, code: "ads_consent_save_unavailable" });
  });
  openLinkedIn(onConnectionChange);
  fireEvent.click(await screen.findByRole("button", { name: "Withdraw shared-wallet permission" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/still authorized/);
  expect(onConnectionChange).not.toHaveBeenCalled();
});

it("a member never triggers the auto-bind, even with a stopped binding and a usable login account", async () => {
  h.role = "member";
  withChoices(() => ({ accounts: [own(binding, "original", true)], managed: [], selected_id: binding }));
  openLinkedIn();
  await screen.findByText(/Only a workspace owner or admin/);
  await screen.findByRole("button", { name: "Authorize shared wallet" });
  await waitFor(() => expect(gets(CAMPAIGNS)).toBe(1));
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(gets(LINKEDIN)).toBe(2));
  await tick();
  await tick();
  expect(posts()).toEqual([]);
  expect(api.mock.calls.filter(([p]) => String(p).includes("/available"))).toEqual([]);
});

it("when the first load fails because LinkedIn is busy, Try again reloads the settings once and clears the error", async () => {
  const normal = api.getMockImplementation()!;
  let failing = true;
  api.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (failing && !opts?.method && path === LINKEDIN)
      throw new Error("LinkedIn Ads is busy right now. Try again in a minute.");
    return normal(path, opts);
  });
  openLinkedIn();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("LinkedIn Ads is busy right now");
  const before = api.mock.calls.length;
  failing = false;
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await screen.findByRole("button", { name: "Authorize shared wallet" });
  expect(screen.queryByRole("alert")).toBeNull();
  await waitFor(() => expect(gets(CAMPAIGNS)).toBe(2));
  await tick();
  const reads = api.mock.calls.slice(before).map((c) => c[0]);
  expect(reads.sort()).toEqual(
    [LINKEDIN, "/api/ads/wallet/consent", CAMPAIGNS].sort(),
  );
  expect(posts()).toEqual([]);
});

it("puts the accepted terms on their own full-width line below the Withdraw row, with the exact consent text", async () => {
  h.role = "owner";
  withState(() => true);
  openLinkedIn();
  const withdraw = await screen.findByRole("button", { name: "Withdraw shared-wallet permission" });
  const disclosure = screen.getByTestId("consent-terms") as HTMLDetailsElement;
  expect(disclosure.open).toBe(false);
  fireEvent.click(within(disclosure).getByText("View the terms you accepted"));
  disclosure.open = true;
  const terms = within(disclosure).getByText("Authorize my shared ads wallet");
  expect(terms.textContent).toBe("Authorize my shared ads wallet");
  expect(disclosure.contains(withdraw)).toBe(false);
  expect(withdraw.parentElement!.contains(disclosure)).toBe(false);
  expect(withdraw.parentElement!.className).toContain("sm:items-start");
  expect(withdraw.parentElement!.className).toContain("flex-col");
  expect(screen.getByTestId("linkedin-wallet-card").contains(withdraw)).toBe(false);
  expect(disclosure.className.split(" ")).toContain("w-full");
  expect(terms.className.split(" ")).toEqual(expect.arrayContaining(["w-full", "text-[13px]", "leading-6"]));
  expect(withdraw.className.split(" ")).toEqual(expect.arrayContaining(["w-full", "sm:w-auto"]));
});

function chatgptChoices(choices: unknown, writes: string[]) {
  const base = api.getMockImplementation()!;
  api.mockImplementation(async (path: string, opts?: { method?: string }) => {
    if (opts?.method === "POST") { writes.push(path); return { ok: true }; }
    if (path === "/api/ads/accounts/chatgpt") return choices;
    return base(path, opts);
  });
}

it("on the Settings page it opens by itself, names the account in use, and Disconnect stops new campaigns on it", async () => {
  h.role = "owner";
  const stops: string[] = [];
  chatgptChoices({ accounts: [own(binding, "acct_9")], managed: [], selected_id: binding }, stops);
  const { container } = render(<AdsAccountSettings platform="chatgpt" settingsPage />);
  expect(await screen.findByText("Connected to acct_9")).toBeTruthy();
  expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(stops).toContain("/api/ads/accounts/chatgpt/disable"));
});

it("on the Settings page, with no account in use, Connect leads to the choices instead of writing anything", async () => {
  h.role = "owner";
  const writes: string[] = [];
  chatgptChoices({ accounts: [], managed: [], selected_id: null }, writes);
  render(<AdsAccountSettings platform="chatgpt" settingsPage />);
  expect(await screen.findByText("Not connected yet")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(writes).toEqual([]);
});
