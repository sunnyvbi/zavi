// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const callJson = vi.hoisted(() => vi.fn());
vi.mock("./useCards", () => ({ callJson }));

import { NOTICES_CHANGED, UgcNotificationBell, drawerFromLink, noticeIdsFor } from "./NotificationBell";

const JOB = "11111111-1111-1111-1111-111111111111";
const rows = [
  {
    id: "n1",
    kind: "submission_received",
    title: "Tarun delivered 1 video",
    body: "Review it by Oct 2.",
    link_path: `/workspace?tab=channels&channel=ugc&drawer=job&job=${JOB}`,
    read_at: null,
    created_at: "2026-09-29T08:07:00Z",
  },
  {
    id: "n2",
    kind: "creator_accepted",
    title: "Tarun accepted your booking",
    body: null,
    link_path: `/workspace?tab=channels&channel=ugc&drawer=job&job=${JOB}`,
    read_at: "2026-09-29T09:00:00Z",
    created_at: "2026-09-28T08:07:00Z",
  },
];

beforeEach(() => {
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=ugc");
  callJson.mockReset();
  callJson.mockImplementation(async (path: string) =>
    path === "/api/humans/notifications"
      ? { ok: true, data: { notifications: rows, unread: 1 } }
      : { ok: true, data: { ok: true } },
  );
});
afterEach(cleanup);

describe("drawerFromLink", () => {
  it("reads a hub link as a drawer and its keys", () => {
    expect(drawerFromLink(`/workspace?tab=channels&channel=ugc&drawer=job&job=${JOB}`)).toEqual({
      name: "job",
      params: { job: JOB },
    });
  });

  it("is null for a link that is not a hub drawer", () => {
    expect(drawerFromLink("/humans/jobs")).toBeNull();
    expect(drawerFromLink("/workspace?tab=channels&channel=ugc")).toBeNull();
  });
});

describe("UgcNotificationBell", () => {
  it("says unread without printing a number on the bell", async () => {
    render(<UgcNotificationBell />);
    const bell = await screen.findByRole("button", { name: "Notifications, 1 unread" });
    const visible = Array.from(bell.childNodes)
      .filter((n) => !(n instanceof HTMLElement && n.classList.contains("sr-only")))
      .map((n) => n.textContent ?? "")
      .join("");
    expect(visible).not.toMatch(/\d/);
  });

  it("opens the job drawer from a notification and marks it read", async () => {
    render(<UgcNotificationBell />);
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    fireEvent.click(await screen.findByText("Tarun delivered 1 video"));
    expect(window.location.search).toBe(`?tab=channels&channel=ugc&drawer=job&job=${JOB}`);
    await waitFor(() =>
      expect(callJson).toHaveBeenCalledWith("/api/humans/notifications/read", { body: { ids: ["n1"] } }),
    );
  });

  it("marks everything read from the panel", async () => {
    render(<UgcNotificationBell />);
    fireEvent.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    fireEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
    expect(callJson).toHaveBeenCalledWith("/api/humans/notifications/read", { body: { all: true } });
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeTruthy();
  });

  it("re-reads the count when another drawer says notices changed, without waiting for its poll or a focus", async () => {
    render(<UgcNotificationBell />);
    await screen.findByRole("button", { name: "Notifications, 1 unread" });
    callJson.mockImplementation(async (path: string) =>
      path === "/api/humans/notifications"
        ? { ok: true, data: { notifications: rows.map((r) => ({ ...r, read_at: r.read_at ?? "2026-09-30T00:00:00Z" })), unread: 0 } }
        : { ok: true, data: { ok: true } },
    );
    window.dispatchEvent(new Event(NOTICES_CHANGED));
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeTruthy();
  });

  it("stops listening once unmounted", async () => {
    const { unmount } = render(<UgcNotificationBell />);
    await screen.findByRole("button", { name: "Notifications, 1 unread" });
    unmount();
    const before = callJson.mock.calls.length;
    window.dispatchEvent(new Event(NOTICES_CHANGED));
    expect(callJson.mock.calls.length).toBe(before);
  });
});

describe("noticeIdsFor", () => {
  const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const D = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const hub = "/workspace?tab=channels&channel=ugc";
  const list = [
    { id: "t1", link_path: `${hub}&drawer=thread&creator=${C}`, read_at: null },
    { id: "t2", link_path: `${hub}&drawer=thread&creator=${C}&over=find`, read_at: null },
    { id: "t3", link_path: `${hub}&drawer=thread&creator=${C}`, read_at: "2026-10-01T00:00:00Z" },
    { id: "t4", link_path: `${hub}&drawer=thread&creator=${D}`, read_at: null },
    { id: "j1", link_path: `${hub}&drawer=job&job=${JOB}`, read_at: null },
    { id: "r1", link_path: `${hub}&drawer=review&job=${JOB}`, read_at: null },
    { id: "x1", link_path: `/humans/jobs?creator=${C}`, read_at: null },
    { id: "x2", link_path: null, read_at: null },
  ];

  it("picks a creator's unread conversation notices and nothing about their jobs or other creators", () => {
    expect(noticeIdsFor(list, "thread", { creator: C })).toEqual(["t1", "t2"]);
  });

  it("picks a job's unread notices from both its job and review links, never a conversation", () => {
    expect(noticeIdsFor(list, "job", { job: JOB })).toEqual(["j1", "r1"]);
    expect(noticeIdsFor(list, "review", { job: JOB })).toEqual(["j1", "r1"]);
  });

  it("picks nothing without the key it matches on", () => {
    expect(noticeIdsFor(list, "thread", {})).toEqual([]);
    expect(noticeIdsFor(list, "job", {})).toEqual([]);
  });
});
