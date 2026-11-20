// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { PlatformSpec } from "./types";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("@/components/ui/ConfirmDialog", () => ({ confirmAction: async () => true }));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => ({}) }));
vi.mock("@/lib/verifiedUser", () => ({ getVerifiedUser: async () => ({ email: "owner@brightloop.test" }) }));
const ws = vi.hoisted(() => ({ tabs: [] as unknown[], activeTabId: "c" }));
vi.mock("../WorkspaceShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../WorkspaceShell")>()),
  useWorkspaceOptional: () => ({ openTab: () => {}, tabs: ws.tabs, activeTabId: ws.activeTabId }),
}));
const { spec } = vi.hoisted(() => ({ spec: { current: {} as PlatformSpec } }));
vi.mock("./platforms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platforms")>()),
  platformFor: () => spec.current,
}));

import { ChannelActionsLane } from "./ChannelActionsLane";
import { makeAction } from "./__tests__/fixtures";

const D = "11111111-2222-4333-8444-555555555555";
const SLUG = "email_marketing";
const srv = { decision: "proposed", card: "pending" as string };
const approvalsGets = () => apiFetch.mock.calls.filter(([u, i]) => String(u) === `/api/approvals/${D}` && !(i as { method?: string } | undefined)?.method).length;

function emailCard() {
  const open = srv.card === "pending";
  return {
    rail: "decisions",
    id: D,
    class: "email_campaign.create_and_send",
    status: srv.card,
    open,
    route: "sendgrid",
    list: { name: "Brightloop members", people: 3 },
    sender: { email: "hello@brightloop.test", name: "Brightloop" },
    reply_to: null,
    unsubscribe_group_id: "7",
    viewer_can_approve: true,
    chosen_variant: open ? null : 1,
    versions: [1, 2].map((n) => ({ variant: n, subject: `Subject ${n}`, preview_text: `Preview ${n}`, html: `<p>V${n}</p>`, tested_by_me: true, tested_by_approver: true })),
    can_approve: open ? [true, true] : [false, false],
    reasons: [],
    ...(srv.card === "sent" ? { sent_count: 3 } : {}),
  };
}

beforeEach(() => {
  apiFetch.mockReset();
  srv.decision = "proposed";
  srv.card = "pending";
  spec.current = { name: "Email campaigns" };
  ws.tabs = [];
  Element.prototype.scrollIntoView = () => {};
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (u === `/api/approvals/${D}`) {
      return ok({ decision: { id: D, decision_class: "email_campaign.create_and_send", status: srv.decision, body: {} }, home: { kind: "channel", slug: SLUG }, needs_owner_admin: false, viewer_role: "owner" });
    }
    if (u.startsWith(`/api/email-cards/decisions/${D}/approve`) && init?.method === "POST") {
      srv.decision = "approved";
      srv.card = "sending";
      return ok({ ok: true });
    }
    if (u.startsWith(`/api/email-cards/decisions/${D}/count`)) return ok({ people: 3 });
    if (u === `/api/email-cards/decisions/${D}`) return ok({ card: emailCard() });
    if (u.includes("/actions")) return ok({ actions: [], more: 0, store: "channel_actions", ...(srv.decision === "acted" ? { completed: [makeAction("send_message", { id: D, title: "Sent", status: "acted", exec_status: "executed", executed_at: "2026-10-28T04:31:11Z" })] } : {}) });
    if (u.includes("/metrics")) return ok({ metrics: [] });
    return ok({});
  });
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const staged = (ids: string[]) => ({
  ids,
  render: (shown: readonly string[]) => shown.map((id) => <li key={id} data-testid={`action-${id}`}>Staged email card</li>),
});

const lane = (ids: string[]) => (
  <ChannelActionsLane slug={SLUG} legacy={<p>legacy rail</p>} workState="idle" lastRunAt={null} actionCount={ids.length} connected hasConnectors chatStaged={staged(ids)}>
    {null}
  </ChannelActionsLane>
);

describe("a linked email decision drawn as a staged card on its own channel", () => {
  it("keeps the card on the lane with its final status once the staged copy is dropped, and reads the decision a bounded number of times", async () => {
    window.history.replaceState(null, "", `/workspace?tab=channels&channel=${SLUG}&action=${D}`);
    const view = render(lane([D]));
    await screen.findByTestId(`action-${D}`);
    await waitFor(() => expect(approvalsGets()).toBe(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByTestId("linked-decision")).toBeNull();

    srv.decision = "acted";
    srv.card = "sent";
    view.rerender(lane([]));

    const linked = await screen.findByTestId("linked-decision");
    await waitFor(() => expect(linked.textContent).toMatch(/Sent to 3 /));
    expect(screen.queryByTestId(`action-${D}`)).toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(approvalsGets()).toBeLessThanOrEqual(2);
    expect(screen.getAllByTestId("linked-decision")).toHaveLength(1);
  });

  it("does not draw the card twice while the staged copy is still on the lane", async () => {
    window.history.replaceState(null, "", `/workspace?tab=channels&channel=${SLUG}&action=${D}`);
    const view = render(lane([D]));
    await waitFor(() => expect(approvalsGets()).toBe(1));
    view.rerender(lane([D]));
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(screen.queryByTestId("linked-decision")).toBeNull();
    expect(screen.getAllByTestId(`action-${D}`)).toHaveLength(1);
  });
});

describe("a linked email decision the founder navigated away from", () => {
  it("is not drawn when the chat drops the staged copy after the tab's link cleared", async () => {
    const decisionReads = () => apiFetch.mock.calls.filter(([u]) => String(u).startsWith(`/api/email-cards/decisions/${D}`) || String(u) === `/api/approvals/${D}`).length;
    ws.tabs = [{ id: "c", payload: { kind: "channels", channel: SLUG, action: D } }];
    const view = render(lane([D]));
    await screen.findByTestId(`action-${D}`);
    await waitFor(() => expect(approvalsGets()).toBe(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByTestId("linked-decision")).toBeNull();

    ws.tabs = [{ id: "c", payload: { kind: "channels", channel: SLUG } }];
    view.rerender(lane([D]));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const before = decisionReads();

    srv.decision = "acted";
    srv.card = "sent";
    view.rerender(lane([]));
    await act(async () => { await new Promise((r) => setTimeout(r, 500)); });

    expect(screen.queryByTestId(`action-${D}`)).toBeNull();
    expect(screen.queryByTestId("linked-decision")).toBeNull();
    expect(decisionReads()).toBe(before);
  });
});
