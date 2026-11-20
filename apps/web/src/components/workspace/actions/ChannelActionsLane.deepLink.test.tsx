// @vitest-environment jsdom

import { ChannelSurface } from "./ChannelSurface";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PlatformSpec } from "./types";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
const openTab = vi.hoisted(() => vi.fn());
const ws = vi.hoisted(() => ({ tabs: [] as unknown[], activeTabId: "c" }));
vi.mock("../WorkspaceShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../WorkspaceShell")>()),
  useWorkspaceOptional: () => ({ openTab, tabs: ws.tabs, activeTabId: ws.activeTabId }),
}));

const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("./platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
let actions: ChannelActionView[] = [];
let completed: ChannelActionView[] | undefined;
const scrollIntoView = vi.fn();

let decisionLookup: { status: number; body: unknown } | null = null;
function lane(slug: string, onSurface = false) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (decisionLookup && /^\/api\/approvals\/[0-9a-f-]{36}$/.test(u)) {
      return { ok: decisionLookup.status < 400, status: decisionLookup.status, json: async () => decisionLookup!.body };
    }
    if (u.includes("/actions")) return ok({ actions, more: 0, store: "channel_actions", ...(completed ? { completed } : {}) });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({});
  });
  const el = (
    <ChannelActionsLane slug={slug} legacy={<p>legacy rail</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>
      {null}
    </ChannelActionsLane>
  );
  return render(onSurface ? <ChannelSurface slug={slug}>{el}</ChannelSurface> : el);
}

beforeEach(() => {
  apiFetch.mockReset();
  scrollIntoView.mockReset();
  spec.current = { name: "Test Ads" };
  completed = undefined;
  decisionLookup = null;
  openTab.mockReset();
  ws.tabs = [];
  Element.prototype.scrollIntoView = scrollIntoView;
  actions = [makeAction("fix", { id: "card-1", title: "Raise the budget" }), makeAction("fix", { id: "card-2", title: "Count sign-ups" })];
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("?action=<id>", () => {
  it("opens the card's kind, scrolls to it and flashes it once", async () => {
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=google_ads&action=card-2");
    lane("deep-link-open");
    const card = await screen.findByTestId("action-card-2");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView.mock.instances[0]).toBe(card);
    expect(card.className).toContain("shadow-[0_0_36px_rgba(255,255,255,0.32)]");
  });

  it("an id that is not on this channel just opens the channel", async () => {
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=google_ads&action=someone-else");
    lane("deep-link-missing");
    const first = await screen.findByTestId("action-card-1");
    expect(screen.getByTestId("action-card-2").className).not.toContain("shadow-[0_0_36px_rgba(255,255,255,0.32)]");
    expect(first.className).not.toContain("shadow-[0_0_36px_rgba(255,255,255,0.32)]");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("a card Zavi already made is not on the page: the channel just opens", async () => {
    completed = [makeAction("fix", { id: "done-1", title: "Raised the budget", status: "acted", exec_status: "executed", executed_at: "2026-10-18T04:31:11Z" })];
    window.history.replaceState(null, "", "/workspace?tab=channels&channel=google_ads&action=done-1");
    lane("deep-link-done", true);
    await screen.findByTestId("action-card-1");
    expect(screen.queryByTestId("action-done-1")).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("no link: nothing scrolls", async () => {
    lane("deep-link-none");
    await screen.findByTestId("action-card-1");
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  const D = "11111111-2222-4333-8444-555555555555";
  it("a linked decision that lives on the Growth page is sent there, focused", async () => {
    decisionLookup = { status: 200, body: { decision: { id: D, decision_class: "google_ads.update_campaign_budget", status: "proposed" }, home: { kind: "growth" }, needs_owner_admin: false, viewer_role: "owner" } };
    window.history.replaceState(null, "", `/workspace?tab=channels&channel=google_ads&action=${D}`);
    lane("deep-link-growth");
    await waitFor(() => expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ kind: "autopilot", payload: { kind: "autopilot", decision: D } })));
  });

  it("a linked decision on another channel opens that channel on the card", async () => {
    decisionLookup = { status: 200, body: { decision: { id: D, decision_class: "seo.publish", status: "proposed" }, home: { kind: "channel", slug: "seo" }, needs_owner_admin: false, viewer_role: "owner" } };
    window.history.replaceState(null, "", `/workspace?tab=channels&channel=google_ads&action=${D}`);
    lane("deep-link-other-channel");
    await waitFor(() => expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ kind: "channels", payload: { kind: "channels", channel: "seo", action: D } })));
  });

  it("a linked decision that lives on THIS channel opens its live card at the top of the lane", async () => {
    decisionLookup = { status: 200, body: { decision: { id: D, decision_class: "google_ads.update_campaign_budget_review", status: "proposed", body: {} }, home: { kind: "channel", slug: "deep-link-here" }, needs_owner_admin: false, viewer_role: "owner" } };
    window.history.replaceState(null, "", `/workspace?tab=channels&channel=deep-link-here&action=${D}`);
    lane("deep-link-here");
    await screen.findByTestId("action-card-1");
    expect(await screen.findByTestId("linked-decision")).toBeTruthy();
    expect(openTab).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Hide this card" }));
    expect(screen.queryByTestId("linked-decision")).toBeNull();
  });

  it("a linked decision already drawn on this lane (outside the ranked list) is scrolled to, not drawn twice", async () => {
    const drawn = document.createElement("article");
    drawn.setAttribute("data-testid", `action-${D}`);
    drawn.scrollIntoView = scrollIntoView;
    document.body.appendChild(drawn);
    decisionLookup = { status: 200, body: { decision: { id: D, decision_class: "seo.publish", status: "proposed", body: {} }, home: { kind: "channel", slug: "deep-link-drawn" }, needs_owner_admin: false, viewer_role: "owner" } };
    window.history.replaceState(null, "", `/workspace?tab=channels&channel=deep-link-drawn&action=${D}`);
    lane("deep-link-drawn");
    await screen.findByTestId("action-card-1");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(screen.queryByTestId("linked-decision")).toBeNull();
    drawn.remove();
  });

  it("an id that is not a decision (404) just leaves the channel open, with no 'gone' line (F5)", async () => {
    decisionLookup = { status: 404, body: { error: { code: "not_found" } } };
    window.history.replaceState(null, "", `/workspace?tab=channels&channel=google_ads&action=${D}`);
    lane("deep-link-gone");
    await screen.findByTestId("action-card-1");
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => String(u) === `/api/approvals/${D}`)).toBe(true));
    expect(screen.queryByText(/not in this list any more/)).toBeNull();
    expect(openTab).not.toHaveBeenCalled();
  });

  it("a card named later on the mounted lane's tab payload is opened then, not only at mount (F5)", async () => {
    ws.tabs = [{ id: "c", kind: "channels", payload: { kind: "channels", channel: "deep-link-later" } }];
    const view = lane("deep-link-later");
    await screen.findByTestId("action-card-1");
    expect(scrollIntoView).not.toHaveBeenCalled();
    ws.tabs = [{ id: "c", kind: "channels", payload: { kind: "channels", channel: "deep-link-later", action: "card-2" } }];
    view.rerender(
      <ChannelActionsLane slug="deep-link-later" legacy={<p>legacy rail</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>
        {null}
      </ChannelActionsLane>,
    );
    const card = await screen.findByTestId("action-card-2");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView.mock.instances[0]).toBe(card);
  });
});
