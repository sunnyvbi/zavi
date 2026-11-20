// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://latest.zaviagent.com"}
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CreatorAffiliate } from "@/lib/creator/api";

const data: CreatorAffiliate = {
  code: "abcd2345",
  clicks_30d: 12,
  signups: 3,
  paying: 1,
  pending_cents: 2000,
  payable_cents: 600,
  paid_cents: 2000,
  open_payout: null,
  entries: [
    { created_at: "2026-10-01T00:00:00Z", kind: "commission", amount_cents: 2000, month_index: 1, rate: 1, matures_at: "2026-10-31T00:00:00Z", paid: true },
    { created_at: "2026-10-05T00:00:00Z", kind: "adjustment", amount_cents: -600, month_index: null, rate: null, matures_at: "2026-10-05T00:00:00Z", paid: false },
  ],
  payout: { connected: false, payouts_enabled: false, disconnected: false },
};
const api = vi.hoisted(() => ({
  affiliate: vi.fn(),
  onboardingLink: vi.fn(),
  home: vi.fn(),
  me: vi.fn(),
  saveProfile: vi.fn(),
  inbox: vi.fn(),
  threads: vi.fn(),
  jobs: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/creator/affiliate", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/components/UserMenu", () => ({ UserMenu: ({ email }: { email: string }) => <span>{email}</span> }));
vi.mock("@/lib/creator/api", async (orig) => {
  const real = await orig<typeof import("@/lib/creator/api")>();
  return { ...real, creatorApi: api };
});
import { CreatorAffiliateScreen, entryLabel, notReady, payoutLine } from "./CreatorAffiliate";
import { CreatorChrome } from "./CreatorChrome";

const setup = (earn_mode: string | null) => ({ goal: !!earn_mode, earn_mode, dob: true, make: true, package: earn_mode !== "affiliate", package_required: earn_mode !== "affiliate", done: 3, total: 3, complete: true });
const me = (earn_mode: string | null, country: string | null = null) => ({
  vetting_state: "approved",
  setup: setup(earn_mode),
  creator: { id: "m", display_name: "Maya", slug: null, lanes: [], city: null, country_code: country, missed_deadline_count: 0 },
  payout_country_supported: null,
  payout_account: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.affiliate.mockResolvedValue(data);
  api.home.mockResolvedValue({ home: "/creator", has_company: false, in_any_company: false, is_creator: true });
  api.jobs.mockResolvedValue({ jobs: [], scope: "all", order: "" });
  api.inbox.mockResolvedValue({ requests: [], alerts: [], unread_alerts: 0, order: "" });
  api.threads.mockResolvedValue({ threads: [], order: "" });
});
afterEach(cleanup);

describe("creator affiliate page", () => {
  it("shows the link, the numbers, payout setup and the journal in words", async () => {
    render(<CreatorAffiliateScreen />);
    expect(await screen.findByText("https://latest.zaviagent.com/?via=abcd2345")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Set up payouts/ })).toBeTruthy();
    expect(screen.getByText("Referred payment, month 1 (100%)")).toBeTruthy();
    expect(screen.getByText("Refund or dispute on a referred payment")).toBeTruthy();
    expect(screen.getByText(/Say you are a Zavi affiliate when you share your link\./)).toBeTruthy();
  });
  it("says where the payout stands", () => {
    expect(payoutLine({ ...data, payable_cents: 600 })).toMatch(/Payouts start at \$20/);
    expect(payoutLine({ ...data, payable_cents: 2400 })).toMatch(/next daily payout/);
    expect(payoutLine({ ...data, open_payout: { state: "awaiting_approval", amount_cents: 2400 } })).toMatch(/being checked before your first payout/);
    expect(entryLabel({ ...data.entries[0], month_index: 3, rate: 0.3 })).toBe("Referred payment, month 3 (30%)");
  });
});

describe("affiliate tab for an affiliate-only creator", () => {
  it("offers 90 days of Pro through the business signup, turned on by our team", async () => {
    api.me.mockResolvedValue(me("affiliate", "US"));
    render(<CreatorChrome><CreatorAffiliateScreen /></CreatorChrome>);
    expect(await screen.findByText("Set up your business to get 90 days of Pro")).toBeTruthy();
    expect(screen.getByText(/our team turns on 90 days of Pro/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up your business" }).getAttribute("href")).toBe("/start");
  });

  it("a creator who already has a business is told our team turns Pro on, with no signup link", async () => {
    api.me.mockResolvedValue(me("affiliate", "US"));
    api.home.mockResolvedValue({ home: "/workspace", has_company: true, in_any_company: true, is_creator: true });
    render(<CreatorChrome><CreatorAffiliateScreen /></CreatorChrome>);
    expect(await screen.findByText("Your business is set up. Our team turns on your 90 days of Pro.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Set up your business" })).toBeNull();
  });

  it("jobs only has no Pro card", async () => {
    api.me.mockResolvedValue(me("jobs", "US"));
    render(<CreatorChrome><CreatorAffiliateScreen /></CreatorChrome>);
    expect(await screen.findByText("https://latest.zaviagent.com/?via=abcd2345")).toBeTruthy();
    expect(screen.queryByText("Set up your business to get 90 days of Pro")).toBeNull();
  });

  it("the country banner asks for the country so Zavi can pay, and says our team handles the rest", async () => {
    api.me.mockResolvedValue(me("affiliate", null));
    render(<CreatorChrome><CreatorAffiliateScreen /></CreatorChrome>);
    expect(await screen.findByText("Add your country so Zavi can pay you")).toBeTruthy();
    expect(screen.getByText("Not in the list? Payouts for your country are handled by our team.")).toBeTruthy();
    expect(screen.queryByText(/Zavi can't pay creators there yet/)).toBeNull();
    const options = Array.from((screen.getByLabelText("Country") as HTMLSelectElement).options).map((o) => o.value);
    expect(options).not.toContain("IN");
  });

  it("before approval, says what is left and opens the first missing step", () => {
    expect(notReady({ goal: true, earn_mode: "affiliate", dob: true, make: false, package: false, package_required: false, done: 2, total: 3, complete: false })).toEqual({
      line: "Your affiliate link is ready once How you want to earn, Your age and What you make are done.",
      href: "/creators/apply?step=make",
    });
    expect(notReady({ goal: true, earn_mode: "both", dob: true, make: true, package: false, package_required: true, done: 3, total: 4, complete: false }).href).toBe(
      "/creators/apply?step=package",
    );
  });
});
