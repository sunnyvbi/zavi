// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

type Msg = { id: string; thread_id: string; sender_kind: "tenant" | "creator"; body: string; created_at: string };
type Notice = { id: string; kind: string; title: string; body: null; link_path: string; read_at: string | null; created_at: string };
type Res = { ok: true; data: unknown } | { ok: false; message: string; status: number };

const HUB = "/workspace?tab=channels&channel=ugc";
const T1 = "2026-10-16T10:00:00.000Z";
const T2 = "2026-10-16T10:05:00.000Z";

const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body?: unknown }>,
  failRead: false,
}));
let messages: Msg[];
let notices: Notice[];

const notice = (id: string, link: string, read_at: string | null = null): Notice => ({
  id,
  kind: "creator_message",
  title: `Notice ${id}`,
  body: null,
  link_path: `${HUB}${link}`,
  read_at,
  created_at: T1,
});

vi.mock("./useCards", async (orig) => ({
  ...(await orig<typeof import("./useCards")>()),
  useCreatorCards: () => ({}),
  callJson: vi.fn(async (path: string, init?: { body?: unknown }): Promise<Res> => {
    net.calls.push({ path, body: init?.body });
    if (path === "/api/humans/notifications") {
      return {
        ok: true,
        data: { notifications: notices.map((n) => ({ ...n })), unread: notices.filter((n) => !n.read_at).length },
      };
    }
    if (path === "/api/humans/notifications/read") {
      if (net.failRead) return { ok: false, message: "nope", status: 500 };
      const ids = (init?.body as { ids: string[] }).ids;
      for (const n of notices) if (ids.includes(n.id) && !n.read_at) n.read_at = "2026-10-16T12:00:00.000Z";
      return { ok: true, data: { ok: true } };
    }
    if (path === "/api/creators/threads") {
      const last = messages[messages.length - 1];
      return {
        ok: true,
        data: {
          threads: [
            {
              thread_id: "t1",
              human_member_id: "m1",
              display_name: "Maya Films",
              last_message: { body: last.body, sender_kind: last.sender_kind, created_at: last.created_at },
              last_message_at: last.created_at,
              unread_count: 1,
            },
          ],
        },
      };
    }
    if (path === "/api/creators/invites/threads") return { ok: true, data: { threads: [] } };
    if (path === "/api/creators/threads/t1/messages") return { ok: true, data: { messages: [...messages] } };
    if (path === "/api/creators/threads/t1/offers") return { ok: true, data: { offers: [] } };
    return { ok: true, data: {} };
  }),
}));

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const readBodies = () => net.calls.filter((c) => c.path === "/api/humans/notifications/read").map((c) => c.body);
const unreadOnServer = () => notices.filter((n) => !n.read_at).map((n) => n.id).sort();

async function mountBellThenThread() {
  vi.resetModules();
  const { UgcNotificationBell } = await import("./NotificationBell");
  const { ThreadDrawer } = await import("./ThreadDrawer");
  window.history.replaceState(null, "", `${HUB}`);
  const bell = render(<UgcNotificationBell />);
  await flush();
  expect(screen.getByRole("button", { name: "Notifications, 4 unread" })).toBeTruthy();
  window.history.replaceState(null, "", `${HUB}&drawer=thread&creator=m1`);
  render(<ThreadDrawer />);
  await flush();
  return bell;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  localStorage.clear();
  net.calls.length = 0;
  net.failRead = false;
  messages = [{ id: "m1", thread_id: "t1", sender_kind: "creator", body: "Hi, happy to help", created_at: T1 }];
  notices = [
    notice("nA", "&drawer=thread&creator=m1"),
    notice("nB", "&drawer=thread&creator=m1"),
    notice("nJ", "&drawer=job&job=j1"),
    notice("nO", "&drawer=thread&creator=m2"),
    notice("nR", "&drawer=thread&creator=m1", "2026-10-15T00:00:00.000Z"),
  ];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("opening a conversation reads its message notifications", () => {
  it("posts read for exactly that creator's unread thread notices, once, and the bell drops without its 60s poll", async () => {
    await mountBellThenThread();
    expect(screen.getByText("Hi, happy to help")).toBeTruthy();

    expect(readBodies()).toEqual([{ ids: ["nA", "nB"] }]);
    expect(unreadOnServer()).toEqual(["nJ", "nO"]);
    expect(screen.getByRole("button", { name: "Notifications, 2 unread" })).toBeTruthy();
  });

  it("a creator message that lands while the conversation is open is read on the next refresh, before the bell's own poll", async () => {
    await mountBellThenThread();
    messages.push({ id: "m2", thread_id: "t1", sender_kind: "creator", body: "Shipping address?", created_at: T2 });
    notices.push(notice("nC", "&drawer=thread&creator=m1"));

    await flush(20_000);
    expect(screen.getByText("Shipping address?")).toBeTruthy();
    expect(readBodies()).toEqual([{ ids: ["nA", "nB"] }, { ids: ["nC"] }]);
    expect(unreadOnServer()).toEqual(["nJ", "nO"]);
    expect(screen.getByRole("button", { name: "Notifications, 2 unread" })).toBeTruthy();
  });

  it("a refused read leaves the bell as the server has it and is tried again on the next new message", async () => {
    net.failRead = true;
    await mountBellThenThread();
    expect(readBodies()).toEqual([{ ids: ["nA", "nB"] }]);
    expect(screen.getByRole("button", { name: "Notifications, 4 unread" })).toBeTruthy();

    net.failRead = false;
    messages.push({ id: "m2", thread_id: "t1", sender_kind: "creator", body: "Shipping address?", created_at: T2 });
    await flush(20_000);
    expect(readBodies()[1]).toEqual({ ids: ["nA", "nB"] });
    expect(screen.getByRole("button", { name: "Notifications, 2 unread" })).toBeTruthy();
  });
});
