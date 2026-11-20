// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChannelActionView } from "@/lib/workspace/channelActionsApi";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("next/link", () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { ChannelActionsLane } from "./ChannelActionsLane";
import { ChannelSurface } from "./ChannelSurface";
import { ChannelChatProvider } from "./channelChat";
import { makeAction } from "./__tests__/fixtures";

const SLUG = "email_marketing";
const PLANNED = "aaaaaaaa-1111-4111-8111-111111111111";
const LIVE = "bbbbbbbb-2222-4222-8222-222222222222";
const DONE = "cccccccc-3333-4333-8333-333333333333";
const PLAN_ITEM = "dddddddd-4444-4444-8444-444444444444";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const planItem = {
  id: PLAN_ITEM,
  route: "mailchimp",
  list_id: "L1",
  list_name: "Paying customers",
  planned_at: "2026-10-21T16:00:00Z",
  planned_label: "Wed, Oct 21, 09:00",
  timezone: "America/Los_Angeles",
  angle: "Product news: shared calendars",
  why: "Product news beat tips for this list.",
  source: "email_agent",
  status: "ready",
  status_reason: null,
  reason: null,
  content_version: 1,
  schedule_gen: 1,
  card: { rail: "channel_actions", id: PLANNED },
  vetoed: false,
  scheduled: null,
  unattended: false,
  sent_at: null,
};
let actions: ChannelActionView[] = [];
let completed: ChannelActionView[] = [];
let planItems: unknown[] = [];
const scrollIntoView = vi.fn();
const assign = vi.fn();
const openChat = vi.fn();
const original = window.location;

function lane(planGate?: Promise<void>) {
  apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u === "/api/workspace/email-plan") {
      await planGate;
      return ok({ ok: true, role: "owner", timezone: "America/Los_Angeles", next_plan_at: null, next_plan_label: null, items: planItems });
    }
    if (u.includes(`/api/channels/${SLUG}/actions`)) return ok({ actions, more: 0, store: "channel_actions", completed });
    if (u.includes(`/api/channels/${SLUG}/metrics`)) return ok({ metrics: [] });
    return ok({});
  });
  return render(
    <ChannelChatProvider open={openChat}>
      <ChannelSurface slug={SLUG}>
        <ChannelActionsLane slug={SLUG} legacy={<p>legacy rail</p>} workState="idle" lastRunAt={null} actionCount={0} connected hasConnectors>
          {null}
        </ChannelActionsLane>
      </ChannelSurface>
    </ChannelChatProvider>,
  );
}

function link(id: string) {
  window.history.replaceState(null, "", `/workspace?tab=channels&channel=${SLUG}&action=${id}`);
  Object.defineProperty(window, "location", { configurable: true, value: { ...original, search: window.location.search, assign } });
}

beforeEach(() => {
  apiFetch.mockReset();
  scrollIntoView.mockReset();
  assign.mockReset();
  openChat.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
  actions = [
    makeAction("send_message", { id: PLANNED, channel_slug: SLUG, title: "The planned send" }),
    makeAction("check", { id: LIVE, channel_slug: SLUG, title: "Check the sending domain" }),
  ];
  completed = [];
  planItems = [planItem];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: original });
  window.history.replaceState(null, "", "/");
});

describe("email lane links", () => {
  it("a link to a sent email card opens that card's own page", async () => {
    completed = [makeAction("send_message", { id: DONE, channel_slug: SLUG, title: "Sent last week", status: "acted", exec_status: "executed", executed_at: "2026-10-18T04:31:11Z", email_card: true })];
    link(DONE);
    lane();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/workspace/email-cards/channel_actions/${DONE}`));
    expect(assign).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("a link to a card still on the lane scrolls to that card and goes nowhere", async () => {
    link(LIVE);
    lane();
    const card = await screen.findByTestId(`action-${LIVE}`);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.instances.at(-1)).toBe(card);
    expect(within(card).queryAllByText("Check the sending domain").length).toBeGreaterThan(0);
    expect(assign).not.toHaveBeenCalled();
  });
});
