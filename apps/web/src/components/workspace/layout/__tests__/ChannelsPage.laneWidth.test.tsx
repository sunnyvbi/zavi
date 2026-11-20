// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHANNELS, type Channel } from "@zavi/shared";

const viewport = vi.hoisted(() => ({ compact: false, listeners: new Set<() => void>() }));
vi.mock("@/lib/responsive", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (fire: () => void) => {
    viewport.listeners.add(fire);
    return () => {
      viewport.listeners.delete(fire);
    };
  };
  const useIsCompact = () => useSyncExternalStore(subscribe, () => viewport.compact, () => false);
  return { useIsCompact, useMediaMatch: useIsCompact, COMPACT_MAX_PX: 639, COMPACT_QUERY: "(max-width: 639px)" };
});

const LIST = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Newsletter",
  created_at: "2026-10-01T00:00:00Z",
  latest: { id: "v-a", source_kind: "csv", source_label: "Email", contact_count: 12, created_at: "2026-10-01T00:00:00Z", consented: true },
  active: { id: "v-a", contact_count: 12, sendable: 11, unsubscribed_or_bounced: 1 },
  needs_consent: false,
};
const answers: Record<string, unknown> = {};
const calls: string[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string) => {
    calls.push(url);
    const path = url.split("?")[0];
    return { ok: true, status: 200, json: async () => answers[path] ?? {} };
  }),
}));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("../../agent/ScheduleView", () => ({ ScheduleView: () => <div /> }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner", tenantName: "Brightloop" }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("../ChannelActionChat", () => ({
  ChannelActionChat: ({ fullBleed, open, maxWidthPx }: { fullBleed?: boolean; open: boolean; maxWidthPx?: number }) => (
    <div data-testid="channel-chat" data-full-bleed={fullBleed ? "yes" : "no"} data-open={open ? "yes" : "no"} data-max-width={maxWidthPx ?? ""} />
  ),
}));

const href = vi.hoisted(() => ({ value: "/workspace?tab=channels&channel=email_marketing", listeners: new Set<() => void>() }));
vi.mock("../../navigation/useWorkspaceLocation", async () => {
  const { useReducer, useEffect } = await import("react");
  return {
    useWorkspaceLocation: () => {
      const [, force] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        href.listeners.add(force);
        return () => {
          href.listeners.delete(force);
        };
      }, [force]);
      return href.value;
    },
  };
});
vi.mock("../../navigation/workspaceRoutes", async (importOriginal) => {
  const move = (next: string) => {
    href.value = next;
    href.listeners.forEach((fire) => fire());
  };
  return {
    ...(await importOriginal<typeof import("../../navigation/workspaceRoutes")>()),
    readWorkspaceLocation: () => href.value,
    replaceWorkspaceLocation: move,
    pushWorkspaceLocation: move,
  };
});

import { ChannelsPage, type ChannelEntry } from "../ChannelsPage";
import { ChannelDetailPage, type ChannelDetail } from "../ChannelDrawer";

const email = (CHANNELS as readonly Channel[]).find((c) => c.slug === "email_marketing")!;
const detail: ChannelDetail = {
  channel: email,
  mode: "produce",
  connected: false,
  connectors: [],
  workState: "idle",
  lastRunAt: null,
  lastProbeAt: null,
  lastProbeDelta: null,
  runnable: true,
};
const entry = { channel: email, count: 0, waiting: 0, subtitle: null, lock: null } as unknown as ChannelEntry;

const lane = vi.hoisted(() => ({ width: 0, observers: new Set<() => void>() }));

function renderChannels() {
  return render(
    <ChannelsPage
      entries={[entry]}
      loading={false}
      onShow={() => {}}
      onUpgrade={() => {}}
      renderDetail={(_slug, close, leading) => (
        <ChannelDetailPage detail={detail} actionCount={0} error={null} leading={leading} onClose={close} onOpenConnectors={() => {}} />
      )}
    />,
  );
}

function resizeLane(width: number) {
  act(() => {
    lane.width = width;
    lane.observers.forEach((fire) => fire());
  });
}

const openChat = () => fireEvent.click(screen.getByRole("button", { name: "Show the chat" }));

beforeEach(() => {
  lane.width = 0;
  lane.observers.clear();
  answers["/api/workspace/email-pause"] = { paused: false };
  answers["/api/workspace/email-test-lists"] = { routes: [], orphans: [] };
  answers["/api/workspace/email-plan"] = { ok: true, role: "owner", timezone: "UTC", items: [], holds: [], released: [] };
  answers["/api/workspace/email-lists"] = { lists: [LIST] };
  answers["/api/workspace/email-contacts"] = { rows: [], total: 0, counts: { contacts: 0, lists: 1, unsubscribed: 0, bounced: 0 }, masked: false };
  window.matchMedia = ((query: string) =>
    ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList) as typeof window.matchMedia;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => lane.width });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private fire: () => void;
      constructor(cb: () => void) {
        this.fire = cb;
      }
      observe() {
        lane.observers.add(this.fire);
      }
      disconnect() {
        lane.observers.delete(this.fire);
      }
      unobserve() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  viewport.compact = false;
  href.value = "/workspace?tab=channels&channel=email_marketing";
  window.localStorage.clear();
});

describe("Flow 28: the chat never squeezes the email lane below a readable width", () => {
  it("a 640px lane (a 1280px viewport) opens the chat as an overlay on the lane, not a column beside the cards", async () => {
    lane.width = 640;
    renderChannels();
    await waitFor(() => expect(screen.getByRole("tab", { name: /^Overview/ })).toBeTruthy());
    openChat();
    const chat = await screen.findByTestId("channel-chat");
    expect(chat.getAttribute("data-full-bleed")).toBe("yes");
    expect(chat.getAttribute("data-open")).toBe("yes");
    expect(screen.getByTestId("channel-chat-overlay").className).toContain("absolute inset-0");
  });

  it("a 1500px lane keeps the chat as a side column", async () => {
    lane.width = 1500;
    renderChannels();
    await waitFor(() => expect(screen.getByRole("tab", { name: /^Overview/ })).toBeTruthy());
    openChat();
    const chat = await screen.findByTestId("channel-chat");
    expect(chat.getAttribute("data-full-bleed")).toBe("no");
    expect(screen.queryByTestId("channel-chat-overlay")).toBeNull();
  });

  it("widening the lane past the threshold with the chat open flips back to the column without unmounting the chat", async () => {
    lane.width = 640;
    renderChannels();
    await waitFor(() => expect(screen.getByRole("tab", { name: /^Overview/ })).toBeTruthy());
    openChat();
    expect((await screen.findByTestId("channel-chat")).getAttribute("data-full-bleed")).toBe("yes");
    resizeLane(1500);
    expect(screen.getByTestId("channel-chat").getAttribute("data-full-bleed")).toBe("no");
    expect(screen.queryByTestId("channel-chat-overlay")).toBeNull();
    resizeLane(700);
    expect(screen.getByTestId("channel-chat").getAttribute("data-full-bleed")).toBe("yes");
  });

  it("the overlay stays inside the lane: it never fixes itself over the whole screen", async () => {
    lane.width = 640;
    renderChannels();
    await waitFor(() => expect(screen.getByRole("tab", { name: /^Overview/ })).toBeTruthy());
    openChat();
    await screen.findByTestId("channel-chat");
    expect(screen.getByTestId("channel-chat-overlay").className).not.toContain("fixed");
  });

  const RAIL = 280;
  const MIN_DETAIL = 360;
  const MIN_CHAT = 340;
  const ROOMY_DETAIL = 640;

  async function openAt(width: number) {
    lane.width = width;
    const view = renderChannels();
    await waitFor(() => expect(screen.getByRole("tab", { name: /^Overview/ })).toBeTruthy());
    openChat();
    const chat = await screen.findByTestId("channel-chat");
    return { view, chat };
  }

  it("a lane too narrow for the rail, a readable detail and the narrowest chat mounts the overlay", async () => {
    const { chat } = await openAt(979);
    expect(chat.getAttribute("data-full-bleed")).toBe("yes");
    expect(chat.getAttribute("data-open")).toBe("yes");
    const overlay = screen.getByTestId("channel-chat-overlay");
    expect(overlay.className).toContain("absolute inset-0");
    expect(overlay.className).not.toContain("fixed");
  });

  it("the chat shrinks to fit before it covers the page: the column keeps the detail at MIN_DETAIL_PX or more", async () => {
    const modes: Record<number, string> = {};
    for (const width of [700, 979, 980, 1066, 1100, 1200, 1600, 2000]) {
      const { view, chat } = await openAt(width);
      const mode = chat.getAttribute("data-full-bleed") ?? "";
      modes[width] = mode;
      const room = width - RAIL - MIN_DETAIL;
      if (mode === "no") {
        expect(screen.queryByTestId("channel-chat-overlay")).toBeNull();
        expect(room).toBeGreaterThanOrEqual(MIN_CHAT);
        expect(chat.getAttribute("data-max-width")).toBe(String(Math.min(room, Math.max(MIN_CHAT, width - RAIL - ROOMY_DETAIL))));
      } else {
        expect(room).toBeLessThan(MIN_CHAT);
        expect(screen.getByTestId("channel-chat-overlay")).toBeTruthy();
      }
      view.unmount();
      window.localStorage.clear();
    }
    expect(modes).toEqual({ 700: "yes", 979: "yes", 980: "no", 1066: "no", 1100: "no", 1200: "no", 1600: "no", 2000: "no" });
  });

  it("a chat the founder widened to 600px stays a column on a 1200px lane, capped so the page keeps its room", async () => {
    window.localStorage.setItem("zavi.channelChat.email_marketing.width", "600");
    const { chat } = await openAt(1200);
    expect(chat.getAttribute("data-full-bleed")).toBe("no");
    expect(chat.getAttribute("data-max-width")).toBe("340");
    expect(screen.queryByTestId("channel-chat-overlay")).toBeNull();
  });

  it("on a wide lane the chat can only be dragged until the page is down to 640px", async () => {
    const { chat } = await openAt(1700);
    expect(chat.getAttribute("data-max-width")).toBe(String(1700 - RAIL - ROOMY_DETAIL));
  });

  it("an unmeasured lane falls back to the column", async () => {
    const { chat } = await openAt(0);
    expect(chat.getAttribute("data-full-bleed")).toBe("no");
    expect(screen.queryByTestId("channel-chat-overlay")).toBeNull();
  });
});
