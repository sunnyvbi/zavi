// @vitest-environment jsdom
import { forgetConnected } from "../email/EmailConnectTiles";
import { forgetPaused } from "../email/EmailSendingSwitch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChannelChatPin } from "../actions/channelChat";

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/font/local", () => ({ default: () => ({ className: "", style: {} }) }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ approvalsPending: 0, openAgentTab: vi.fn(), openTab: vi.fn(), role: "owner", tenantName: "Brightloop" }),
  useWorkspaceOptional: () => ({ role: "owner" }),
}));

const chats = vi.hoisted(() => ({ mounts: [] as { pin: ChannelChatPin; channelSlug: string; open: boolean }[] }));
vi.mock("./ChannelActionChat", () => ({
  ChannelActionChat: (p: { pin: ChannelChatPin; channelSlug: string; open: boolean }) => {
    chats.mounts.push({ pin: p.pin, channelSlug: p.channelSlug, open: p.open });
    return (
      <div
        data-testid="channel-chat"
        data-open={String(p.open)}
        data-target={p.pin.target}
        data-channel={p.channelSlug}
        data-action-id={p.pin.target === "action" ? p.pin.action.id : ""}
        data-mode={p.pin.target === "action" ? p.pin.mode : ""}
      />
    );
  },
}));

const DECISION_ID = "33333333-3333-4333-8333-333333333333";
const LANE_ID = "44444444-4444-4444-8444-444444444444";
const decision = {
  id: DECISION_ID,
  decision_class: "bulk_outbound.send",
  channel_slug: "email_marketing",
  handler: "bulk_outbound.send",
  emitted_at: "2026-10-28T10:00:00.000Z",
  run_group: null,
  action_source: "decision",
  thread_id: "thread-write-it",
  agent_slug: "email_marketing",
  body: { list_name: "Brightloop members" },
};

const cardView = (over: Record<string, unknown> = {}) => ({
  rail: "decisions",
  id: DECISION_ID,
  class: "bulk_outbound.send",
  status: "pending",
  open: true,
  editable: true,
  route: "sendgrid",
  list: { name: "Brightloop members", people: 238 },
  sender: { email: "hello@brightloop.test", name: "Brightloop" },
  reply_to: null,
  unsubscribe_group_id: "7",
  viewer_can_approve: true,
  chosen_variant: null,
  versions: [1, 2].map((n) => ({ variant: n, subject: `Subject ${n}`, preview_text: `Preview ${n}`, html: `<p>Version ${n}</p>`, tested_by_me: false, tested_by_approver: false })),
  can_approve: [false, false],
  reasons: [],
  ...over,
});

const answers: Record<string, unknown> = {};
const apiFetch = vi.fn(async (url: string, _init?: unknown) => {
  const path = url.split("?")[0];
  if (path.startsWith("/api/approvals"))
    return { ok: true, status: 200, json: async () => ({ decisions: [decision], channel_pending_counts: { email_marketing: 1 } }) };
  if (path === "/api/channels")
    return {
      ok: true,
      status: 200,
      json: async () => ({
        channels: [
          {
            channel_slug: "email_marketing",
            delivery_mode: "execute",
            work_state: "needs_review",
            priority: 1,
            last_run_at: "2026-10-28T09:00:00.000Z",
            connected: true,
            connectors: ["email"],
            linked_connectors: ["email"],
            runnable: true,
          },
        ],
      }),
    };
  return { ok: true, status: 200, json: async () => answers[path] ?? {} };
});
vi.mock("@/lib/api", () => ({ apiFetch: (url: string, init?: unknown) => apiFetch(url, init) }));

import { ChannelsPanel, clearChannelBoardCache } from "./ChannelsPanel";

let savedMatchMedia: typeof window.matchMedia | undefined;

beforeEach(() => {
  clearChannelBoardCache();
  forgetConnected();
  forgetPaused();
  apiFetch.mockClear();
  chats.mounts.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
  answers["/api/workspace/email-pause"] = { paused: false };
  answers["/api/workspace/email-test-lists"] = { routes: [{ route: "zavi_list", label: "Zavi lists", status: "complete", error: null, lists: [] }], orphans: [] };
  answers["/api/workspace/email-plan"] = { ok: true, role: "owner", timezone: "UTC", items: [], holds: [], released: [] };
  answers[`/api/email-cards/decisions/${DECISION_ID}`] = { card: cardView() };
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=email_marketing");
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  if (savedMatchMedia) window.matchMedia = savedMatchMedia;
  else delete (window as unknown as Record<string, unknown>).matchMedia;
  window.history.replaceState(null, "", "/");
});

const mountEmailPage = () =>
  render(
    <div className="workspace-shell">
      <ChannelsPanel collapsed={false} onToggle={() => {}} variant="page" />
    </div>,
  );

const askButton = () => screen.findByRole("button", { name: "Ask Zavi to change it" }, { timeout: 4000 });

describe("a pending email card on the decisions rail (Write it, agent runs)", () => {
  it("Ask Zavi opens the channel chat pinned to THIS decision card on the email channel, so a redraft replaces it", async () => {
    mountEmailPage();
    const ask = await askButton();
    const before = chats.mounts.filter((m) => m.pin.target === "action").length;
    expect(before).toBe(0);
    fireEvent.click(ask);
    await waitFor(() => {
      const chat = screen.getAllByTestId("channel-chat").find((c) => c.dataset.target === "action");
      expect(chat).toBeTruthy();
      expect(chat!.dataset.open).toBe("true");
      expect(chat!.dataset.actionId).toBe(DECISION_ID);
      expect(chat!.dataset.channel).toBe("email_marketing");
      expect(chat!.dataset.mode).toBe("ask");
    });
    const pinned = chats.mounts.filter((m) => m.pin.target === "action");
    expect(pinned.every((m) => m.pin.target === "action" && m.pin.action.id === DECISION_ID && (m.pin.action.id as string) !== LANE_ID)).toBe(true);
    const last = pinned[pinned.length - 1]!.pin;
    if (last.target !== "action") throw new Error("not an action pin");
    expect(last.action.channel_slug).toBe("email_marketing");
    expect(await last.onRedo("make it shorter")).toBe(false);
    expect(apiFetch.mock.calls.some(([u]) => String(u).includes("/redo"))).toBe(false);
    expect(apiFetch.mock.calls.some(([u, init]) => String(u).includes(`/api/email-cards/decisions/${DECISION_ID}`) && (init as { method?: string } | undefined)?.method === "POST")).toBe(false);
  });

  it("a card that is no longer editable (sending or sent) offers no Ask Zavi, the same rule as the lane", async () => {
    answers[`/api/email-cards/decisions/${DECISION_ID}`] = { card: cardView({ status: "approved", open: false, editable: false, chosen_variant: 1 }) };
    mountEmailPage();
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => String(u) === `/api/email-cards/decisions/${DECISION_ID}`)).toBe(true), { timeout: 4000 });
    await screen.findAllByText(/Subject 1/, {}, { timeout: 4000 });
    expect(screen.queryByRole("button", { name: "Ask Zavi to change it" })).toBeNull();
  });
});
