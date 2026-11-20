// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://latest.zaviagent.com"}

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  track: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  router: null as unknown,
  search: "",
  api: {
    me: vi.fn(),
    home: vi.fn(),
    profile: vi.fn(),
    setupEarn: vi.fn(),
    setupMake: vi.fn(),
    affiliate: vi.fn(),
    onboardingLink: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => (h.router ??= { replace: h.replace, push: h.push }),
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/analytics/events", () => ({ trackEvent: h.track, trackEventDeferred: () => () => {} }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({ auth: {} }) }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: h.api };
});

import ApplyFlow from "./ApplyFlow";

const setup = (over: Record<string, unknown> = {}) => ({
  goal: false, earn_mode: null, dob: true, make: false, package: false, package_required: true, done: 1, total: 3, complete: false, ...over,
});
const me = (setupOver: Record<string, unknown>, country: string | null = null, payout: unknown = null) => ({
  vetting_state: "approved",
  setup: setup(setupOver),
  creator: { id: "m", display_name: "Maya", slug: null, lanes: [], city: null, country_code: country, missed_deadline_count: 0 },
  payout_country_supported: null,
  payout_account: payout,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.search = "";
  h.api.home.mockResolvedValue({ home: "/creator", has_company: false, in_any_company: false, is_creator: true });
  h.api.profile.mockResolvedValue({ accounts: [], niches: [], bio: null, intro_video_name: null, country_code: null });
});
afterEach(cleanup);

describe("How you want to earn", () => {
  it("needs a pick, saves it, tracks it, and moves on", async () => {
    h.search = "step=goal";
    h.api.me.mockResolvedValue(me({}));
    h.api.setupEarn.mockResolvedValue({ ok: true, setup: setup({ goal: true, earn_mode: "affiliate", package_required: false }) });
    render(<ApplyFlow />);
    expect(await screen.findByText("How do you want to earn?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Pick at least one.")).toBeTruthy();
    expect(h.api.setupEarn).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Refer customers \(affiliate\)/ }));
    expect(screen.queryByText("First package")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.api.setupEarn).toHaveBeenCalledWith(true, false));
    expect(h.track).toHaveBeenCalledWith("creator_earn_mode_chosen", { mode: "affiliate" });
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/creators/apply?step=account"));
  });

  it("a late /me never overwrites a goal the creator already tapped", async () => {
    h.search = "step=goal";
    let answer: (v: unknown) => void = () => {};
    h.api.me.mockReturnValue(new Promise((r) => (answer = r)));
    h.api.setupEarn.mockResolvedValue({ ok: true, setup: setup({ goal: true, earn_mode: "affiliate", package_required: false }) });
    render(<ApplyFlow />);
    fireEvent.click(await screen.findByRole("button", { name: /Refer customers \(affiliate\)/ }));
    answer(me({ goal: true, earn_mode: "jobs" }));
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.api.setupEarn).toHaveBeenCalledWith(true, false));
  });

  it("affiliate only goes live after What you make, even before /me answers", async () => {
    h.search = "step=make";
    h.api.me.mockReturnValue(new Promise(() => {}));
    h.api.setupMake.mockResolvedValue({ ok: true, setup: setup({ goal: true, earn_mode: "affiliate", make: true, complete: true }) });
    render(<ApplyFlow />);
    fireEvent.click(await screen.findByRole("button", { name: "TikTok" }));
    fireEvent.change(screen.getByPlaceholderText(/tiktok\.com/), { target: { value: "@maya" } });
    fireEvent.change(screen.getByPlaceholderText("48,000"), { target: { value: "1,200" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/creators/apply?state=live"));
  });
});

describe("What you make, affiliate only", () => {
  it("says the link needs a platform, and that Zavi looks before the first payout", async () => {
    h.search = "step=make";
    h.api.me.mockResolvedValue(me({ goal: true, earn_mode: "affiliate", package_required: false }));
    render(<ApplyFlow />);
    expect(await screen.findByText("Where you post and what about. You need at least one platform to get your affiliate link.")).toBeTruthy();
    expect(screen.getByText("Zavi looks at these before your first payout.")).toBeTruthy();
  });
});

describe("the end of setup", () => {
  it("affiliate only: the link, earnings from the terms, the disclosure, and the two next steps", async () => {
    h.search = "state=live";
    h.api.me.mockResolvedValue(me({ goal: true, earn_mode: "affiliate", make: true, complete: true }));
    h.api.affiliate.mockResolvedValue({ code: "k7m4p2qa" });
    render(<ApplyFlow />);
    expect(await screen.findByText("Your affiliate link is ready")).toBeTruthy();
    expect(await screen.findByText("https://latest.zaviagent.com/?via=k7m4p2qa")).toBeTruthy();
    expect(screen.getByText("$100 in year one")).toBeTruthy();
    expect(screen.getByText("$600 in year one")).toBeTruthy();
    expect(screen.getByText("$1,200 in year one")).toBeTruthy();
    expect(screen.getByText(/Say you are a Zavi affiliate when you share your link\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up payouts" })).toBeNull();
    expect(screen.getByRole("link", { name: "Add your country" }).getAttribute("href")).toBe("/creator/affiliate");
    const business = screen.getByRole("link", { name: "Set up your business" });
    expect(business.getAttribute("href")).toBe("/start");
    expect(screen.getByText(/our team turns on 90 days of Pro/)).toBeTruthy();
    expect(screen.queryByText(/first accepted job/)).toBeNull();
    expect(screen.queryByText("One more thing: add your country")).toBeNull();
    expect(screen.getByRole("link", { name: /Go to your affiliate page/ }).getAttribute("href")).toBe("/creator/affiliate");
  });

  it("affiliate only in a country Stripe cannot pay: says our team pays, no add-country and no Stripe button", async () => {
    h.search = "state=live";
    h.api.me.mockResolvedValue(me({ goal: true, earn_mode: "affiliate", make: true, complete: true }, "IN"));
    render(<ApplyFlow />);
    expect(await screen.findByText("Your affiliate link is ready")).toBeTruthy();
    expect(screen.getByText("Payouts for your country are handled by our team.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Add your country" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up payouts" })).toBeNull();
  });

  it("affiliate only with a payable country: Set up payouts opens Stripe", async () => {
    h.search = "state=live";
    h.api.me.mockResolvedValue(me({ goal: true, earn_mode: "affiliate", make: true, complete: true }, "US"));
    h.api.affiliate.mockResolvedValue({ code: "k7m4p2qa" });
    h.api.onboardingLink.mockResolvedValue({ url: "#stripe" });
    render(<ApplyFlow />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up payouts" }));
    await waitFor(() => expect(h.api.onboardingLink).toHaveBeenCalled());
  });

  it("both: You're live on Zavi, the link, and the country card", async () => {
    h.search = "state=live";
    h.api.me.mockResolvedValue(me({ goal: true, earn_mode: "both", make: true, package: true, complete: true }));
    h.api.affiliate.mockResolvedValue({ code: "k7m4p2qa" });
    render(<ApplyFlow />);
    expect(await screen.findByText("You're live on Zavi")).toBeTruthy();
    expect(screen.getByText("Your profile and first package are saved, and your affiliate link is ready to share.")).toBeTruthy();
    expect(await screen.findByText("https://latest.zaviagent.com/?via=k7m4p2qa")).toBeTruthy();
    expect(screen.getByText("One more thing: add your country")).toBeTruthy();
  });

  it("jobs only keeps the end screen as it was", async () => {
    h.search = "state=live";
    h.api.me.mockResolvedValue(me({ goal: true, earn_mode: "jobs", make: true, package: true, complete: true }, "US"));
    render(<ApplyFlow />);
    expect(await screen.findByText("You're live on Zavi")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Earnings" }).getAttribute("href")).toBe("/creator/earnings");
    expect(screen.queryByText("Your affiliate link is ready")).toBeNull();
    expect(h.api.affiliate).not.toHaveBeenCalled();
  });
});
