import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));
const viewer = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspaceOptional: () => (viewer.role ? { role: viewer.role } : null),
}));
vi.mock("../platforms", () => ({ platformFor: () => ({ name: "LinkedIn Ads" }) }));

import { BoundAdsCampaigns } from "./BoundAdsCampaigns";
import { BoundCampaignSafetyControls } from "./CampaignSafetyControls";
import { ChannelPlanLockProvider, type ChannelPlanLock } from "../channelPlanLock";

const A = "10000000-0000-4000-8000-00000000000a";
const B = "10000000-0000-4000-8000-00000000000b";
const ROWS = [
  { id: A, provider_campaign_id: "111", funding_source: "provider", name: "Alpha", status: "PAUSED" },
  { id: B, provider_campaign_id: "222", funding_source: "provider", name: "Bravo", status: "ACTIVE" },
];
let rows: Array<Record<string, unknown>>;
let pauseAnswer: (id: string) => Promise<unknown>;
let reviewAnswer: (id: string) => Promise<unknown>;
const scrolled: Array<{ el: Element; arg: unknown }> = [];

const posts = () => api.mock.calls.filter(([, o]) => (o as RequestInit | undefined)?.method === "POST").map(([p]) => String(p));
const launchReads = () => api.mock.calls.filter(([p, o]) => /\/launch$/.test(String(p)) && !(o as RequestInit | undefined)?.method);
const rowOf = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

beforeEach(() => {
  api.mockReset();
  viewer.role = "owner";
  rows = ROWS;
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    scrolled.push({ el: this, arg });
  };
  pauseAnswer = async () => ({ status: "paused" });
  reviewAnswer = async (id) => ({
    campaign_binding_id: id, name: "Bravo", account_id: "42", funding_source: "provider", status: "PAUSED",
    snapshot: "a".repeat(64), currency: "USD", total_budget_cents: 10000, end_time: Date.now() + 3 * 86400000, ads: [{ id: "8", status: "PAUSED" }],
  });
  api.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (path.includes("?platform=")) return { campaigns: rows };
    if (path === "/api/workspace/ad-budget") return { budget: { status: "active" } };
    const pause = /^\/api\/ads\/campaigns\/([^/]+)\/pause$/.exec(path);
    if (pause && opts?.method === "POST") return pauseAnswer(pause[1]);
    const launch = /^\/api\/ads\/campaigns\/([^/]+)\/launch$/.exec(path);
    if (launch && !opts?.method) return reviewAnswer(launch[1]);
    return { ok: true };
  });
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

const withLock = (lock: ChannelPlanLock | null, ui: ReactNode) => <ChannelPlanLockProvider value={lock}>{ui}</ChannelPlanLockProvider>;
const LOCK_ID = "campaign-launch-locked";

describe("a plan-locked or Coming soon LinkedIn Ads page", () => {
  it("plan-locked: Review launch is off up front with one message and the upgrade, and Pause still sends", async () => {
    const upgrade = vi.fn();
    render(withLock({ tierName: "Pro", upgrade }, <BoundAdsCampaigns platform="linkedin" />));
    const review = within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    expect(review.getAttribute("aria-describedby")).toBe(LOCK_ID);
    const note = document.getElementById(LOCK_ID)!;
    expect(note.textContent).toContain("New campaigns and launches on LinkedIn Ads need the Pro plan. You can still pause your campaigns.");
    fireEvent.click(within(note).getByRole("button", { name: "Upgrade to Pro" }));
    expect(upgrade).toHaveBeenCalledTimes(1);
    fireEvent.click(review);
    expect(launchReads()).toHaveLength(0);
    fireEvent.click(within(rowOf("Bravo")).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(posts()).toEqual([`/api/ads/campaigns/${B}/pause`]));
  });

  it("Coming soon: the same message names the lock, offers no upgrade, and no launch review is read", async () => {
    render(withLock({ tierName: null, soon: true, upgrade: vi.fn() }, <BoundAdsCampaigns platform="linkedin" />));
    const review = within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    const note = document.getElementById(LOCK_ID)!;
    expect(note.textContent).toBe("LinkedIn Ads is coming soon, so new campaigns and launches are off for now. You can still pause your campaigns.");
    expect(within(note).queryByRole("button")).toBeNull();
    fireEvent.click(review);
    expect(launchReads()).toHaveLength(0);
  });

  it("an open channel keeps Review launch on and shows no lock line", async () => {
    render(withLock({ tierName: null, upgrade: vi.fn() }, <BoundAdsCampaigns platform="linkedin" />));
    const review = within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }) as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    expect(document.getElementById(LOCK_ID)).toBeNull();
  });
});

describe("errors sit next to the control that caused them", () => {
  it("a failed Pause shows inside its own row, not at the top of the list", async () => {
    pauseAnswer = async () => { throw Object.assign(new Error("LinkedIn did not pause this campaign. Try again."), { status: 502 }); };
    render(<BoundAdsCampaigns platform="linkedin" />);
    fireEvent.click(within(await waitFor(() => rowOf("Bravo"))).getByRole("button", { name: "Pause" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("LinkedIn did not pause this campaign. Try again.");
    expect(rowOf("Bravo").contains(alert)).toBe(true);
    expect(rowOf("Alpha").contains(alert)).toBe(false);
  });

  it("a failed Review launch shows inside its own row", async () => {
    reviewAnswer = async () => { throw new Error("Zavi could not read this campaign from LinkedIn. Try again."); };
    render(<BoundAdsCampaigns platform="linkedin" />);
    fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
    const alert = await screen.findByRole("alert");
    expect(rowOf("Alpha").contains(alert)).toBe(true);
  });

  it("the launch form opened below the list is scrolled into view", async () => {
    render(<BoundAdsCampaigns platform="linkedin" />);
    fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
    const approve = await screen.findByRole("button", { name: /Approve and launch/ });
    const form = approve.closest("form")!;
    await waitFor(() => expect(scrolled.some((s) => s.el === form)).toBe(true));
    expect(scrolled.find((s) => s.el === form)!.arg).toEqual({ block: "nearest" });
  });

  it("without scrollIntoView (jsdom, old browsers) the form still opens", async () => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    render(<BoundAdsCampaigns platform="linkedin" />);
    fireEvent.click(within(await waitFor(() => rowOf("Alpha"))).getByRole("button", { name: "Review launch" }));
    expect(await screen.findByRole("button", { name: /Approve and launch/ })).toBeTruthy();
  });
});

describe("the pause-only safety block on the channels page", () => {
  it("shows a locked LinkedIn channel's campaigns with Pause only, and pauses", async () => {
    render(<BoundCampaignSafetyControls platform="linkedin" name="LinkedIn Ads" />);
    const open = await screen.findByRole("button", { name: "Pause LinkedIn Ads campaigns" });
    fireEvent.click(open);
    const bravo = rowOf("Bravo");
    expect(within(bravo).queryByRole("button", { name: "Review launch" })).toBeNull();
    expect(within(rowOf("Alpha")).queryByRole("button", { name: "Review launch" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New campaign" })).toBeNull();
    fireEvent.click(within(bravo).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(posts()).toEqual([`/api/ads/campaigns/${B}/pause`]));
  });

  it("stays hidden when every campaign has ended", async () => {
    rows = [{ id: A, provider_campaign_id: "111", funding_source: "provider", name: "Alpha", status: "ENDED" }];
    render(<BoundCampaignSafetyControls platform="linkedin" name="LinkedIn Ads" />);
    await screen.findByText("Alpha");
    expect((screen.getByTestId("linkedin-safety") as HTMLElement).hidden).toBe(true);
    expect(screen.queryByRole("button", { name: "Pause LinkedIn Ads campaigns" })).toBeNull();
  });
});
