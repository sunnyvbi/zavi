// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), campaignFetch: api }));
vi.mock("@/lib/stripe/adsStripe", () => ({ adsPublishableKey: () => null, adsStripe: () => null }));
const viewer = vi.hoisted(() => ({ role: null as string | null }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => (viewer.role ? { role: viewer.role } : null) }));
import { ChannelBalance } from "./ChannelBalance";
import { chatgpt_ads } from "../platforms/chatgpt_ads";

const spec = chatgpt_ads.campaignWorkspace!;
const base = { balance_cents: 1000, reserved_cents: 0, available_cents: 1000, funding_enabled: true, in_app_enabled: false, auto_refill_enabled: true, refill_cents: 5000, threshold_cents: 2000, pending: false, last_error: null };
let wallet: Record<string, unknown>;
let disable: () => Promise<unknown>;
const disables = () => api.mock.calls.filter(([p]) => String(p).endsWith("/disable-refill"));
const checkouts = () => api.mock.calls.filter(([p]) => String(p).endsWith("/checkout"));

beforeEach(() => {
  api.mockReset();
  viewer.role = null;
  sessionStorage.clear();
  wallet = { ...base };
  disable = async () => { wallet = { ...wallet, auto_refill_enabled: false }; return {}; };
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.mockImplementation(async (path: string) => {
    if (path.endsWith("/disable-refill")) return disable();
    if (path.endsWith("/checkout")) return { url: "https://checkout.stripe.com/c/pay/x" };
    return wallet;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const turnOff = () => screen.findByRole("button", { name: "Turn off auto-refill" });

describe.each([["card"], ["tile"], ["dialog"]] as const)("the auto-refill state in the %s", (variant) => {
  const show = () => render(<ChannelBalance spec={spec} platform="linkedin" variant={variant} />);

  it("says it is on and how much each refill charges, and the control really turns it off once", async () => {
    show();
    const control = await turnOff();
    const state = control.closest("[data-testid=auto-refill-state]") as HTMLElement;
    expect(within(state).getByText("Auto-refill is on")).toBeTruthy();
    expect(within(state).getByText("$50.00 per refill")).toBeTruthy();
    fireEvent.click(control);
    await waitFor(() => expect(disables()).toHaveLength(1));
    expect(disables()[0][1]).toEqual({ method: "POST" });
    await waitFor(() => expect(screen.queryAllByTestId("auto-refill-state")).toHaveLength(0));
    expect(screen.queryByRole("button", { name: "Turn off auto-refill" })).toBeNull();
    expect(disables()).toHaveLength(1);
  });

  it("shows the change is in progress, and a second click while it runs charges no second request", async () => {
    let finish: (v: unknown) => void = () => {};
    disable = () => new Promise((resolve) => { finish = resolve; });
    show();
    const control = await turnOff();
    fireEvent.click(control);
    await waitFor(() => expect(control.getAttribute("aria-busy")).toBe("true"));
    expect(control.textContent).toBe("Turning off…");
    expect((control as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(control);
    expect(disables()).toHaveLength(1);
    wallet = { ...wallet, auto_refill_enabled: false };
    await act(async () => { finish({}); });
    await waitFor(() => expect(screen.queryAllByTestId("auto-refill-state")).toHaveLength(0));
  });

  it("stays on and says so when the server refuses, so nobody believes refills stopped", async () => {
    disable = async () => { throw new Error("nope"); };
    show();
    fireEvent.click(await turnOff());
    expect((await screen.findByRole("alert")).textContent).toContain("Auto-refill could not be disabled. Try again.");
    const control = await turnOff();
    expect(control.closest("[data-testid=auto-refill-state]")).not.toBeNull();
    expect(control.textContent).toBe("Turn off");
    expect((control as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers no control when auto-refill is already off", async () => {
    wallet = { ...base, auto_refill_enabled: false };
    show();
    await waitFor(() => expect(api).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryAllByTestId("auto-refill-state")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Turn off auto-refill" })).toBeNull();
  });
});

describe("the charge authorization in the dialog", () => {
  const CREATOR_ONLY = "Authorize Zavi to charge this card for creator hires Autopilot books within its caps.";
  const REFILL = `Authorize Zavi to charge this card for LinkedIn ads refills and for creator hires Autopilot books within its caps. Refills are $100.00 whenever your ads balance falls below $${(spec.balance.threshold / 100).toLocaleString("en-US")}, up to $${(spec.balance.dailyRefillCap / 100).toLocaleString("en-US")} per UTC day. Disable auto-refill in the LinkedIn Ads channel at any time.`;
  const openDialog = async () => {
    wallet = { ...base, auto_refill_enabled: false };
    vi.stubGlobal("location", { ...window.location, assign: vi.fn(), href: "http://localhost/workspace" });
    render(<ChannelBalance spec={spec} platform="linkedin" variant="dialog" />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await screen.findByRole("heading", { name: "Add ads balance" });
    await act(async () => {});
  };
  const save = () => screen.getByRole("button", { name: "Save card" }) as HTMLButtonElement;

  it("Save card stays disabled and sends nothing until the box is ticked, even if the form is submitted directly", async () => {
    await openDialog();
    expect(save().disabled).toBe(true);
    fireEvent.submit(save().closest("form")!);
    await act(async () => {});
    expect(checkouts()).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox", { name: CREATOR_ONLY }));
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(checkouts()).toHaveLength(1));
    expect(JSON.parse(String(checkouts()[0][1].body))).toMatchObject({ mode: "setup", consent: true, enable_refill: false });
  });

  it("turning on auto-refill withdraws the earlier consent and swaps in the refill terms word for word", async () => {
    await openDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: CREATOR_ONLY }));
    expect(save().disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Also auto-refill my ads balance" }));
    expect(save().disabled).toBe(true);
    const refill = screen.getByRole("checkbox", { name: REFILL }) as HTMLInputElement;
    expect(refill.checked).toBe(false);
    expect(screen.getByText(REFILL)).toBeTruthy();
    fireEvent.submit(save().closest("form")!);
    await act(async () => {});
    expect(checkouts()).toHaveLength(0);
    fireEvent.click(refill);
    fireEvent.click(save());
    await waitFor(() => expect(checkouts()).toHaveLength(1));
    expect(JSON.parse(String(checkouts()[0][1].body))).toMatchObject({ mode: "setup", consent: true, enable_refill: true, amount_cents: 10000 });
  });

  it("the boxes are real checkboxes a keyboard user can reach, and they lock while checkout opens", async () => {
    let finish: (v: unknown) => void = () => {};
    await openDialog();
    api.mockImplementation((path: string) => path.endsWith("/checkout") ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(wallet));
    const consent = screen.getByRole("checkbox", { name: CREATOR_ONLY }) as HTMLInputElement;
    fireEvent.click(consent);
    fireEvent.click(save());
    await waitFor(() => expect(consent.disabled).toBe(true));
    expect((screen.getByRole("checkbox", { name: "Also auto-refill my ads balance" }) as HTMLInputElement).disabled).toBe(true);
    await act(async () => { finish({ url: "https://checkout.stripe.com/c/pay/x" }); });
  });
});

describe.each([["card", "Add Balance"], ["tile", "+ Add balance"]] as const)("a workspace member on the %s", (variant, addLabel) => {
  it.each(["member", "viewer"])("a %s sees the balance and refill state but no Add balance or Turn off, with a plain note, and sends nothing", async (role) => {
    viewer.role = role;
    render(<ChannelBalance spec={spec} platform="linkedin" variant={variant} />);
    expect(await screen.findByText("$10.00")).toBeTruthy();
    expect(screen.getAllByText("Auto-refill is on").length).toBeGreaterThan(0);
    expect(screen.getByTestId("wallet-owners-only").textContent).toBe("Only workspace owners and admins can add balance or turn off auto-refill.");
    expect(screen.queryByRole("button", { name: addLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn off auto-refill" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.mock.calls.every(([p]) => p === "/api/ads/wallet")).toBe(true);
  });

  it.each(["owner", "admin"])("an %s keeps both controls and sees no note", async (role) => {
    viewer.role = role;
    render(<ChannelBalance spec={spec} platform="linkedin" variant={variant} />);
    expect(await screen.findByRole("button", { name: addLabel })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn off auto-refill" })).toBeTruthy();
    expect(screen.queryByTestId("wallet-owners-only")).toBeNull();
  });
});

it("the dialog-only variant tells a member who may add balance instead of showing a form that would fail", async () => {
  viewer.role = "member";
  render(<ChannelBalance spec={spec} platform="linkedin" variant="dialog" />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(await screen.findByText("Only workspace owners and admins can add balance or turn off auto-refill.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save card" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
  expect(screen.queryByRole("button", { name: "Turn off auto-refill" })).toBeNull();
});

it("tells the account panel the refill state it read, and again after the founder turns refill off", async () => {
  const seen = vi.fn();
  render(<ChannelBalance spec={spec} platform="linkedin" variant="card" onWallet={seen} />);
  await waitFor(() => expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ auto_refill_enabled: true, funding_enabled: true })));
  fireEvent.click(await turnOff());
  await waitFor(() => expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ auto_refill_enabled: false })));
});

describe("the balance pill in the channel's tab row", () => {
  it("shows the balance without cents when it is whole, and Add money opens the dialog", async () => {
    wallet = { ...base, balance_cents: 5300, auto_refill_enabled: false };
    render(<ChannelBalance spec={spec} variant="pill" />);
    const pill = await screen.findByTestId("balance-pill");
    await waitFor(() => expect(pill.textContent).toContain("$53"));
    expect(pill.textContent).not.toContain("$53.00");
    expect(pill.textContent).toContain("Add money");
    fireEvent.click(pill);
    expect(await screen.findByRole("heading", { name: "Add ads balance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add once" })).toBeTruthy();
  });

  it("opens and says payments are not available when funding is off, with no amount to enter", async () => {
    wallet = { ...base, balance_cents: 0, funding_enabled: false, auto_refill_enabled: false };
    render(<ChannelBalance spec={spec} variant="pill" />);
    const pill = await screen.findByTestId("balance-pill");
    await waitFor(() => expect(pill.textContent).toContain("$0"));
    fireEvent.click(pill);
    expect(await screen.findByText(/Payments are not available for this workspace yet/)).toBeTruthy();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("keeps cents when the balance has them, and a member gets no Add money", async () => {
    viewer.role = "member";
    wallet = { ...base, balance_cents: 5340 };
    render(<ChannelBalance spec={spec} variant="pill" />);
    const pill = await screen.findByTestId("balance-pill");
    await waitFor(() => expect(pill.textContent).toContain("$53.40"));
    expect(pill.textContent).not.toContain("Add money");
    fireEvent.click(pill);
    expect(await screen.findByText(/Only workspace owners and admins can add balance/)).toBeTruthy();
  });
});
