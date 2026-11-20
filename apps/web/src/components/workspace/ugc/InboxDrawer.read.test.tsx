// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const HUB = "/workspace?tab=channels&channel=ugc";
const MAYA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const JOB = "11111111-1111-1111-1111-111111111111";

type Notice = { id: string; kind: string; title: string; body: null; link_path: string; read_at: string | null; created_at: string };

const net = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body?: unknown }> }));
let notices: Notice[];

const notice = (id: string, link: string): Notice => ({
  id,
  kind: "creator_message",
  title: `Notice ${id}`,
  body: null,
  link_path: `${HUB}${link}`,
  read_at: null,
  created_at: "2026-10-16T10:00:00.000Z",
});

vi.mock("./useCards", async (orig) => ({
  ...(await orig<typeof import("./useCards")>()),
  useCreatorCards: () => ({}),
  callJson: vi.fn(async (path: string, init?: { body?: unknown }) => {
    net.calls.push({ path, body: init?.body });
    if (path === "/api/humans/notifications")
      return {
        ok: true,
        data: { notifications: notices.map((n) => ({ ...n })), unread: notices.filter((n) => !n.read_at).length },
      };
    if (path === "/api/humans/notifications/read") {
      const ids = (init?.body as { ids: string[] }).ids;
      for (const n of notices) if (ids.includes(n.id)) n.read_at = "2026-10-16T12:00:00.000Z";
      return { ok: true, data: { ok: true } };
    }
    if (path === "/api/creators/threads")
      return {
        ok: true,
        data: {
          threads: [
            {
              thread_id: "t1",
              human_member_id: MAYA,
              display_name: "Maya Films",
              last_message: { body: "Hi", sender_kind: "creator", created_at: "2026-10-16T10:00:00.000Z" },
              last_message_at: "2026-10-16T10:00:00.000Z",
            },
          ],
        },
      };
    if (path === "/api/humans/orders")
      return {
        ok: true,
        data: {
          jobs: [
            {
              id: JOB,
              source: "booking",
              status: "in_progress",
              closed_reason: null,
              title: "Spring launch video",
              creator_display_name: "Maya Films",
              creator_slug: "maya",
              human_member_id: MAYA,
              created_at: "2026-10-10T00:00:00Z",
              due_at: null,
              money: {},
              deadline: null,
              awaiting_creator: false,
            },
          ],
        },
      };
    return { ok: true, data: {} };
  }),
}));

import { InboxDrawer } from "./InboxDrawer";
import { UgcNotificationBell } from "./NotificationBell";

const readBodies = () => net.calls.filter((c) => c.path === "/api/humans/notifications/read").map((c) => c.body);

beforeEach(() => {
  net.calls.length = 0;
  notices = [
    notice("nA", `&drawer=thread&creator=${MAYA}`),
    notice("nJ", `&drawer=job&job=${JOB}`),
    notice("nO", `&drawer=thread&creator=${OTHER}`),
  ];
  window.history.replaceState(null, "", `${HUB}&drawer=inbox`);
});
afterEach(cleanup);

describe("opening a conversation from Creators", () => {
  it("reads only that creator's message notices, leaves their job notice unread, and the bell drops at once", async () => {
    render(
      <>
        <UgcNotificationBell />
        <InboxDrawer />
      </>,
    );
    expect(await screen.findByRole("button", { name: "Notifications, 3 unread" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Message Maya" }));

    expect(new URLSearchParams(window.location.search).get("drawer")).toBe("thread");
    await waitFor(() => expect(readBodies()).toEqual([{ ids: ["nA"] }]));
    expect(notices.find((n) => n.id === "nJ")?.read_at).toBeNull();
    expect(await screen.findByRole("button", { name: "Notifications, 2 unread" })).toBeTruthy();
  });

  it("opening the job reads that job's notice and not the conversation's", async () => {
    render(<InboxDrawer />);
    fireEvent.click(await screen.findByRole("button", { name: /Spring launch video/ }));
    await waitFor(() => expect(readBodies()).toEqual([{ ids: ["nJ"] }]));
    expect(notices.find((n) => n.id === "nA")?.read_at).toBeNull();
  });
});
