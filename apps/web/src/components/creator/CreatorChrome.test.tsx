// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const nav = vi.hoisted(() => ({ path: "/creator" }));
const shared = vi.hoisted(() => ({ marketplaceEnabled: true }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.path, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@zavi/shared", () => ({ get CREATOR_MARKETPLACE_ENABLED() { return shared.marketplaceEnabled; } }));
vi.mock("@/components/UserMenu", () => ({ UserMenu: ({ email }: { email: string }) => <span>{email}</span> }));
const api = vi.hoisted(() => ({ me: vi.fn(), saveProfile: vi.fn(), home: vi.fn(), inbox: vi.fn(), threads: vi.fn(), jobs: vi.fn() }));
vi.mock("@/lib/creator/api", () => ({
  creatorApi: api,
  CreatorApiError: class extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
}));

import { CreatorChrome } from "./CreatorChrome";

const me = (setup: Partial<{ dob: boolean; make: boolean; package: boolean; earn_mode: string | null }>, country: string | null) => {
  const s = { dob: false, make: false, package: false, earn_mode: null as string | null, ...setup };
  const needsPackage = s.earn_mode !== "affiliate";
  const complete = s.dob && s.make && (needsPackage ? s.package : true);
  const done = [s.dob, s.make, s.package].filter(Boolean).length;
  return {
    vetting_state: "pending",
    setup: { ...s, goal: !!s.earn_mode, package_required: needsPackage, done, complete },
    creator: { display_name: "Maya", country_code: country },
    payout_country_supported: null,
    payout_account: null,
  };
};

beforeEach(() => {
  nav.path = "/creator";
  shared.marketplaceEnabled = true;
  api.me.mockReset();
  api.saveProfile.mockReset();
  api.home.mockReset();
  api.home.mockResolvedValue({ home: "/start" });
  api.inbox.mockReset();
  api.threads.mockReset();
  api.jobs.mockReset();
  api.jobs.mockResolvedValue({ jobs: [], scope: "all", order: "" });
  api.inbox.mockResolvedValue({ requests: [], alerts: [], unread_alerts: 0, order: "" });
  api.threads.mockResolvedValue({ threads: [], order: "" });
});
afterEach(cleanup);

describe("CreatorChrome", () => {
  const gateError = async (code: string, message: string) => {
    const { CreatorApiError } = await import("@/lib/creator/api");
    return new (CreatorApiError as unknown as new (c: string, m: string) => Error)(code, message);
  };

  it("a closed creator account with no company has no workspace link (it would loop back here)", async () => {
    api.me.mockRejectedValue(await gateError("not_approved", "Your creator profile is not approved yet."));
    api.home.mockResolvedValue({ home: "/creator" });
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    expect(await screen.findByText("Your creator profile is not approved yet.")).toBeTruthy();
    await waitFor(() => expect(api.home).toHaveBeenCalled());
    expect(screen.queryByRole("link", { name: "Go to your workspace" })).toBeNull();
  });

  it("a closed creator who also has a company gets the workspace link", async () => {
    api.me.mockRejectedValue(await gateError("not_approved", "Your creator profile is not approved yet."));
    api.home.mockResolvedValue({ home: "/workspace" });
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    expect(await screen.findByRole("link", { name: "Go to your workspace" })).toBeTruthy();
  });

  it("a founder with no creator row gets Join as a creator and the workspace link", async () => {
    api.me.mockRejectedValue(await gateError("not_a_creator", "This account is not a Zavi creator."));
    api.home.mockResolvedValue({ home: "/workspace" });
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    expect(await screen.findByRole("link", { name: "Join as a creator" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Go to your workspace" })).toBeTruthy();
  });

  const removed = () => ({ ...me({ dob: true, make: true, package: true }, "US"), vetting_state: "rejected" });

  it.each(["/creator/jobs", "/creator/jobs/0a0a", "/creator/earnings"])("a removed creator on %s sees the page with a closed-to-new-work notice", async (path) => {
    nav.path = path;
    api.me.mockResolvedValue(removed());
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    expect(await screen.findByText("page")).toBeTruthy();
    expect(screen.getByText("Your creator account is closed to new work")).toBeTruthy();
    expect(screen.queryByText("Your creator account is closed. Email support if you think that is wrong.")).toBeNull();
    expect(api.inbox).not.toHaveBeenCalled();
    expect(api.threads).not.toHaveBeenCalled();
  });

  it.each(["/creator", "/creator/briefs", "/creator/profile", "/creator/messages"])("a removed creator on %s gets the closed-account screen", async (path) => {
    nav.path = path;
    api.me.mockResolvedValue(removed());
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    expect(await screen.findByText("Your creator account is closed. Email support if you think that is wrong.")).toBeTruthy();
    expect(screen.queryByText("page")).toBeNull();
    await waitFor(() => expect(api.home).toHaveBeenCalled());
    expect(api.inbox).not.toHaveBeenCalled();
  });

  it("shows the setup card on a new account, and every tab", async () => {
    api.me.mockResolvedValue(me({ dob: true }, null));
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    expect(await screen.findByText("Finish setup")).toBeTruthy();
    expect(screen.getByText("1 of 3 done")).toBeTruthy();
    expect(screen.getByText("1. How you want to earn")).toBeTruthy();
    expect(screen.queryByText("Add your country so businesses can book you")).toBeNull();
    for (const t of ["Inbox", "Briefs", "Jobs", "Earnings", "Affiliate", "Profile"]) expect(screen.getAllByRole("link", { name: t }).length).toBeGreaterThan(0);
    expect(screen.getByText("page")).toBeTruthy();
  });

  it("shows only settlement navigation and no recruitment setup when the marketplace is retired", async () => {
    shared.marketplaceEnabled = false;
    api.me.mockResolvedValue(me({ dob: true }, null));
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    expect(await screen.findByText("page")).toBeTruthy();
    expect(screen.queryByText("Finish setup")).toBeNull();
    expect(screen.queryByRole("link", { name: "Briefs" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Affiliate" })).toBeNull();
    expect(screen.queryByText(/Add your country/)).toBeNull();
  });

  it("lets an existing creator add the country required for payouts from Earnings", async () => {
    shared.marketplaceEnabled = false;
    nav.path = "/creator/earnings";
    api.me.mockResolvedValue(me({ dob: true }, null));
    render(<CreatorChrome><p>earnings</p></CreatorChrome>);
    expect(await screen.findByText("Add your country so Zavi can complete payouts")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Country"), { target: { value: "GB" } });
    fireEvent.click(screen.getByRole("button", { name: "Save country" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith({ country_code: "GB" }));
  });

  it("the setup card follows the path: affiliate only has no package, photo or video rows", async () => {
    api.me.mockResolvedValue(me({ dob: true, earn_mode: "affiliate" }, null));
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    expect(await screen.findByText("Finish setup to get your affiliate link")).toBeTruthy();
    expect(screen.getByText("2 of 3 done")).toBeTruthy();
    expect(screen.queryByText("4. Your first package")).toBeNull();
    expect(screen.queryByText("Add a profile photo")).toBeNull();
    expect(screen.queryByText("Add an intro video")).toBeNull();
    expect(screen.getByText("Your affiliate link is ready once these are done. You can look around now.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit How you want to earn" }).getAttribute("href")).toBe("/creators/apply?step=goal");
    expect(screen.getByRole("link", { name: /Start/ }).getAttribute("href")).toBe("/creators/apply?step=make");
  });

  it("jobs and both keep the package row and the photo and video rows", async () => {
    for (const earn_mode of ["jobs", "both"]) {
      api.me.mockResolvedValue(me({ dob: true, earn_mode }, null));
      render(<CreatorChrome><p>page</p></CreatorChrome>);
      expect(await screen.findByText("Finish your profile to get booked")).toBeTruthy();
      expect(screen.getByText("4. Your first package")).toBeTruthy();
      expect(screen.getByText("2 of 4 done")).toBeTruthy();
      expect(screen.getByText("Add a profile photo")).toBeTruthy();
      cleanup();
    }
  });

  it("an affiliate-only creator done with setup is asked for a country so Zavi can pay them", async () => {
    api.me.mockResolvedValue(me({ dob: true, make: true, earn_mode: "affiliate" }, null));
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    expect(await screen.findByText("Add your country so Zavi can pay you")).toBeTruthy();
    expect(screen.getByText("Not in the list? Payouts for your country are handled by our team.")).toBeTruthy();
  });

  it("after setup, asks for the country and offers only countries Zavi can pay", async () => {
    api.me.mockResolvedValue(me({ dob: true, make: true, package: true }, null));
    api.saveProfile.mockResolvedValue({ ok: true });
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    expect(await screen.findByText("Add your country so businesses can book you")).toBeTruthy();
    const select = screen.getByLabelText("Country") as HTMLSelectElement;
    expect(select.className).toContain("appearance-none");
    expect(select.className).toContain("pr-11");
    expect(select.parentElement?.querySelector("svg.lucide-chevron-down")?.getAttribute("class")).toContain("right-4");
    const options = Array.from((screen.getByLabelText("Country") as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toContain("US");
    expect(options).toContain("DE");
    expect(options).not.toContain("IN");
    expect(options).not.toContain("AU");
    fireEvent.change(screen.getByLabelText("Country"), { target: { value: "GB" } });
    fireEvent.click(screen.getByRole("button", { name: "Save country" }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith({ country_code: "GB" }));
  });

  it("a country saved before, that Zavi cannot pay, still says so", async () => {
    api.me.mockResolvedValue(me({ dob: true, make: true, package: true }, "IN"));
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    expect(await screen.findByText("We can't pay creators in India yet. We'll email you when we can.")).toBeTruthy();
  });

  it("hides the banner once a payable country is set", async () => {
    api.me.mockResolvedValue(me({ dob: true, make: true, package: true }, "US"));
    render(<CreatorChrome><p>page</p></CreatorChrome>);
    await waitFor(() => expect(screen.getByText("page")).toBeTruthy());
    expect(screen.queryByText("Add your country so businesses can book you")).toBeNull();
    expect(screen.queryByText("Finish your profile to get booked")).toBeNull();
  });
});
