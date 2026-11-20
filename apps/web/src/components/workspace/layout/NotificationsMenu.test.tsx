// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  shared: vi.fn(),
  openTab: vi.fn(),
  openAgentTab: vi.fn(),
  setActiveTab: vi.fn(),
  snap: { tenantId: "t1", decisions: [] as unknown[], totals: null as null | Record<string, number>, loaded: true },
  threads: [] as unknown[],
}));

vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({ tenantId: "t1", openTab: h.openTab, openAgentTab: h.openAgentTab, setActiveTab: h.setActiveTab, viewMode: "tabs" }) }));
vi.mock("../useAgentThreads", () => ({ useWorkspaceThreads: () => ({ loaded: true, threads: h.threads }) }));
vi.mock("@/lib/workspace/sharedRead", () => ({ sharedJson: h.shared }));
vi.mock("@/lib/workspace/needsYou", async (actual) => ({
  ...(await actual<typeof import("@/lib/workspace/needsYou")>()),
  useNeedsYouSnapshot: () => h.snap,
}));

import { NotificationsMenu } from "./NotificationsMenu";
import { notificationAge, notificationRows } from "@/lib/workspace/notifications";

const decision = (id: string, home: string, at: string, extra: Record<string, unknown> = {}) => ({
  id, agent_run_id: null, decision_class: "x.y", handler: null, body: { title: `Card ${id}` }, status: "pending", emitted_at: at,
  dispatched_at: null, dispatch_error: null, home, home_channel: null, channel_slug: null, agent_slug: "cgo", thread_id: null, run_stopped: false, needs_owner_admin: false, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  h.openAgentTab.mockResolvedValue("tab-1");
  h.shared.mockResolvedValue({ channel_pending_counts: { meta_ads: 9, reddit_organic: 1, seo: 0 } });
  h.snap = {
    tenantId: "t1", loaded: true, totals: { needs_you: 1, growth: 2, channel: 1 },
    decisions: [
      decision("d-channel", "channel", "2026-11-15T10:00:00Z", { home_channel: "meta_ads" }),
      decision("d-growth", "growth", "2026-11-15T09:00:00Z"),
      decision("d-own", "needs_you", "2026-11-15T08:00:00Z"),
    ],
  };
  h.threads = [{ id: "t-ask", agent_slug: "cgo", unread: true, unread_reply: { head: "Which campaign should get it?", kind: "question", at: "2026-11-15T07:00:00Z" } }];
});
afterEach(cleanup);

async function openMenu() {
  render(<NotificationsMenu />);
  fireEvent.click(await screen.findByRole("button", { name: /Notifications \(5 waiting on you\)/ }));
  return within(screen.getByRole("dialog", { name: "Notifications" }));
}

describe("the notifications bell", () => {
  it("lists one row per channel with work, the CGO, a card of its own and a chat question, newest first", async () => {
    const menu = await openMenu();
    const titles = menu.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(titles[0]).toContain("Meta Ads: 9 actions waiting");
    expect(titles[1]).toContain("Your CGO: 2 decisions waiting");
    expect(titles[2]).toContain("needs you");
    expect(titles[3]).toContain("has a question");
    expect(titles[4]).toContain("1 action waiting");
    expect(titles[4]).toContain("Open the channel to review.");
    expect(titles[5]).toBe("See everything that needs you");
    expect(titles.join(" ")).not.toContain("SEO");
  });

  it("a channel row opens that channel", async () => {
    const menu = await openMenu();
    fireEvent.click(menu.getByRole("button", { name: /Meta Ads: 9 actions waiting/ }));
    expect(h.openTab).toHaveBeenCalledWith(expect.objectContaining({ kind: "channels", payload: { kind: "channels", channel: "meta_ads" } }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a clicked row leaves the list, stays gone after a reload, and returns when more work arrives", async () => {
    let menu = await openMenu();
    fireEvent.click(menu.getByRole("button", { name: /Meta Ads: 9 actions waiting/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Notifications \(4 waiting on you\)/ }));
    expect(screen.queryByText(/Meta Ads/)).toBeNull();
    cleanup();
    render(<NotificationsMenu />);
    expect(await screen.findByRole("button", { name: /Notifications \(4 waiting on you\)/ })).toBeTruthy();
    cleanup();
    h.shared.mockResolvedValue({ channel_pending_counts: { meta_ads: 10, reddit_organic: 1 } });
    menu = await openMenu();
    expect(menu.getByRole("button", { name: /Meta Ads: 10 actions waiting/ })).toBeTruthy();
  });

  it("a seen channel row returns when a different card is waiting at the same count", async () => {
    h.shared.mockResolvedValue({ channel_pending_counts: { meta_ads: 1, reddit_organic: 1 } });
    let menu = await openMenu();
    fireEvent.click(menu.getByRole("button", { name: /Meta Ads: 1 action waiting/ }));
    cleanup();
    h.snap = { ...h.snap, decisions: [decision("d-next", "channel", "2026-11-15T11:00:00Z", { home_channel: "meta_ads" }), ...h.snap.decisions.slice(1)] };
    menu = await openMenu();
    expect(menu.getByRole("button", { name: /Meta Ads: 1 action waiting/ })).toBeTruthy();
  });

  it("a channel row whose waiting card is not in the list stays after a click", async () => {
    h.shared.mockResolvedValue({ channel_pending_counts: { meta_ads: 9, tiktok_ads: 1 } });
    const menu = await openMenu();
    fireEvent.click(menu.getByRole("button", { name: /TikTok Ads: 1 action waiting/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Notifications \(5 waiting on you\)/ }));
    expect(screen.getByRole("button", { name: /TikTok Ads: 1 action waiting/ })).toBeTruthy();
  });

  it("the CGO row opens the growth page, a card opens where it lives, a question opens its chat", async () => {
    let menu = await openMenu();
    fireEvent.click(menu.getByRole("button", { name: /Your CGO/ }));
    expect(h.openTab).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "autopilot" }));
    cleanup();
    window.localStorage.clear();
    menu = await openMenu();
    fireEvent.click(menu.getAllByRole("button", { name: /needs you/ })[0]);
    expect(h.openTab).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "needs-you", payload: { kind: "needs-you", decision: "d-own" } }));
    cleanup();
    window.localStorage.clear();
    menu = await openMenu();
    fireEvent.click(menu.getByRole("button", { name: /has a question/ }));
    expect(h.openAgentTab).toHaveBeenCalledWith("cgo", { threadId: "t-ask" });
  });

  it("the footer opens the full Needs you page", async () => {
    const menu = await openMenu();
    fireEvent.click(menu.getByRole("button", { name: "See everything that needs you" }));
    expect(h.openTab).toHaveBeenCalledWith(expect.objectContaining({ kind: "needs-you", payload: { kind: "needs-you" } }));
  });

  it("says so when nothing is waiting, with no dot on the bell", async () => {
    h.shared.mockResolvedValue({ channel_pending_counts: {} });
    h.snap = { tenantId: "t1", loaded: true, totals: { needs_you: 0, growth: 0, channel: 0 }, decisions: [] };
    h.threads = [];
    const { container } = render(<NotificationsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByText("Nothing new needs you.")).toBeTruthy();
    expect(container.querySelector("[data-notifications-dot]")).toBeNull();
  });

  it("another workspace's cards never show", () => {
    h.snap = { ...h.snap, tenantId: "other" };
    expect(notificationRows({ ...h.snap, decisions: [], totals: null } as never, [], null)).toEqual([]);
    render(<NotificationsMenu />);
    expect(screen.getByRole("button", { name: /Notifications/ }).getAttribute("aria-label")).not.toContain("5 waiting");
  });

  it("ages read as minutes, hours and days", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    expect(notificationAge("2026-11-15T11:58:00Z", now)).toBe("2m");
    expect(notificationAge("2026-11-15T09:00:00Z", now)).toBe("3h");
    expect(notificationAge("2026-11-12T12:00:00Z", now)).toBe("3d");
    expect(notificationAge(null, now)).toBe("");
  });
});
