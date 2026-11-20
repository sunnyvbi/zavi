// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, onClick, className }: { href: string; children: React.ReactNode; onClick?: () => void; className?: string }) => (
    <a href={href} onClick={(e) => { e.preventDefault(); onClick?.(); }} className={className}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(""), useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
const api = vi.hoisted(() => ({ inbox: vi.fn(), briefs: vi.fn(), markAlertRead: vi.fn(), threads: vi.fn(), accept: vi.fn(), pass: vi.fn(), jobs: vi.fn() }));
vi.mock("@/lib/creator/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/creator/api")>("@/lib/creator/api");
  return { ...actual, creatorApi: api };
});

import { CreatorInbox, inboxCount, threadAlertIds } from "./CreatorInbox";

const alert = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "message",
  title: "Acme Coffee sent you a message",
  body: "Can you film on Friday?",
  link_path: "/creator/jobs/o1",
  order_id: "o1",
  read_at: null,
  created_at: "2026-09-20T10:00:00Z",
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.briefs.mockResolvedValue({ briefs: [] });
  api.threads.mockResolvedValue({ threads: [], order: "" });
  api.jobs.mockResolvedValue({ jobs: [], scope: "active", order: "" });
  api.markAlertRead.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("Inbox updates from Zavi", () => {
  it("folds the alerts out of Messages, marks an unread one New, and marks it read when opened", async () => {
    api.inbox.mockResolvedValue({ requests: [], alerts: [alert("a1"), alert("a2", { title: "Brief closed", read_at: "2026-09-21T00:00:00Z", link_path: null })], unread_alerts: 1, order: "" });
    render(<CreatorInbox />);
    const row = await screen.findByText("Acme Coffee sent you a message");
    expect(screen.getByText("Brief closed")).toBeTruthy();
    expect(screen.getAllByText("New")).toHaveLength(1);
    expect(screen.getByText(/Updates from Zavi \(2, 1 new\)/)).toBeTruthy();
    expect(screen.getByText(/No messages yet/)).toBeTruthy();
    fireEvent.click(row);
    expect(api.markAlertRead).toHaveBeenCalledWith("a1");
    expect(screen.queryByText("New")).toBeNull();
  });

  it("keeps the empty slot and shows no Updates fold when there are no alerts", async () => {
    api.inbox.mockResolvedValue({ requests: [], alerts: [], unread_alerts: 0, order: "" });
    render(<CreatorInbox />);
    expect(await screen.findByText(/No messages yet/)).toBeTruthy();
    expect(screen.queryByText(/Updates from Zavi/)).toBeNull();
  });

  it("an already-read alert sends nothing and stays read", async () => {
    api.inbox.mockResolvedValue({ requests: [], alerts: [alert("a2", { title: "Brief closed", read_at: "2026-09-21T00:00:00Z" })], unread_alerts: 0, order: "" });
    render(<CreatorInbox />);
    fireEvent.click(await screen.findByText("Brief closed"));
    expect(api.markAlertRead).not.toHaveBeenCalled();
    expect(screen.queryByText("New")).toBeNull();
  });

  it("a failed mark-read puts the alert back to unread", async () => {
    api.markAlertRead.mockRejectedValue(new Error("down"));
    api.inbox.mockResolvedValue({ requests: [], alerts: [alert("a1")], unread_alerts: 1, order: "" });
    render(<CreatorInbox />);
    fireEvent.click(await screen.findByText("Acme Coffee sent you a message"));
    expect(await screen.findByText("New")).toBeTruthy();
  });
});

describe("Inbox conversations (D8)", () => {
  it("lists a thread in Messages with the business's open offer and opens it by id", async () => {
    api.inbox.mockResolvedValue({ requests: [], alerts: [alert("a1")], unread_alerts: 1, order: "" });
    api.threads.mockResolvedValue({
      order: "",
      threads: [
        {
          thread_id: "t-1",
          business_name: "Bloom Studio",
          last_message_at: "2026-09-20T10:00:00Z",
          last_message: { body: "Great, I sent you an offer for two.", sender_kind: "tenant", created_at: "2026-09-20T10:00:00Z" },
          open_offer: { proposed_by: "tenant", kind: "ugc_video", terms: { title: "2 UGC videos" }, price_cents: 26000, creator_payout_cents: 22100, created_at: "2026-09-20T10:00:00Z" },
        },
      ],
    });
    render(<CreatorInbox />);
    const name = await screen.findByText("Bloom Studio");
    expect(screen.getByText("Sent you a custom offer: 2 UGC videos, $260")).toBeTruthy();
    expect(screen.getByText("Offer for you")).toBeTruthy();
    expect(name.closest("a")?.getAttribute("href")).toBe("/creator/messages?thread=t-1");
    expect(await screen.findByText("Acme Coffee sent you a message")).toBeTruthy();
    expect(screen.queryByText(/No messages yet/)).toBeNull();
  });
});

describe("inboxCount", () => {
  it("counts requests plus conversations waiting on the creator", async () => {
    const { inboxCount } = await import("./CreatorInbox");
    const t = (over: Record<string, unknown>) => ({ thread_id: "t", business_name: "B", last_message_at: "", last_message: null, open_offer: null, ...over }) as never;
    expect(
      inboxCount([{} as never], [
        t({ open_offer: { proposed_by: "tenant" } }),
        t({ last_message: { body: "hi", sender_kind: "tenant", created_at: "" } }),
        t({ last_message: { body: "hi", sender_kind: "creator", created_at: "" } }),
        t({}),
      ]),
    ).toBe(3);
  });
});

describe("Accept and Pass ask once more before money moves (Ravi 2026-09-27)", () => {
  const request = {
    id: "o9",
    source: "booking",
    status: "awaiting_acceptance",
    closed_reason: null,
    created_at: "2026-09-20T10:00:00Z",
    due_at: null,
    accepted_at: null,
    closed_at: null,
    extension_state: null,
    extension_requested_due_at: null,
    package: { kind: "ugc_video", title: "1 UGC video", delivery_days: 7, video_count: 1 },
    brief: null,
    currency: "usd",
    price_cents: 15000,
    creator_fee_cents: 2250,
    creator_payout_cents: 12750,
    amount_cents: 12750,
    part_paid: false,
    payout_status: "not_due",
    payout_ready_at: null,
    deadline: null,
    due_after_accept: "7 days after you accept",
    submissions: [],
    has_thread: false,
    business_name: "Acme Coffee",
  };

  it("Accept shows what it charges and the due date, and only the confirm calls the API", async () => {
    api.inbox.mockResolvedValue({ requests: [request], alerts: [], unread_alerts: 0, order: "" });
    api.accept.mockResolvedValue({ ok: true });
    render(<CreatorInbox />);
    fireEvent.click(await screen.findByRole("button", { name: /^Accept$/ }));
    expect(api.accept).not.toHaveBeenCalled();
    const text = screen.getByText(/^Accepting charges/).textContent ?? "";
    expect(text).toMatch(/^Accepting charges Acme Coffee's card \$150(\.00)? plus Zavi's fee and starts the job\. The work is due 7 days after you accept \(.+ if you accept now\)\.$/);
    fireEvent.click(screen.getByRole("button", { name: "Yes, accept" }));
    await vi.waitFor(() => expect(api.accept).toHaveBeenCalledWith("o9"));
  });

  it("Pass says the hold is released and nothing is charged; Not now does nothing", async () => {
    api.inbox.mockResolvedValue({ requests: [request], alerts: [], unread_alerts: 0, order: "" });
    render(<CreatorInbox />);
    fireEvent.click(await screen.findByRole("button", { name: /^Pass$/ }));
    expect(screen.getByText("Passing releases the hold on Acme Coffee's card. Nothing is charged and the booking closes.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(api.pass).not.toHaveBeenCalled();
    expect(screen.queryByText(/Passing releases the hold/)).toBeNull();
  });
});

describe("the Updates count never claims an exact number it cannot see", () => {
  it("a full list of 30 reads 30+, and opening one drops the new count", async () => {
    const many = Array.from({ length: 30 }, (_, i) => alert(`n${i}`, { title: `Update ${i}`, link_path: null }));
    api.inbox.mockResolvedValue({ requests: [], alerts: many, unread_alerts: 30, order: "" });
    render(<CreatorInbox />);
    expect(await screen.findByText(/Updates from Zavi \(30\+, 30\+ new\)/)).toBeTruthy();
    fireEvent.click(screen.getByText("Update 0"));
    expect(screen.getByText(/Updates from Zavi \(30\+, 29 new\)/)).toBeTruthy();
  });
});

describe("changes asked and unread updates are where the creator looks", () => {
  it("puts a change request under Needs your answer, quoting it, with a link to the feedback", async () => {
    api.inbox.mockResolvedValue({ requests: [], alerts: [], unread_alerts: 0, order: "" });
    api.jobs.mockResolvedValue({
      jobs: [{ id: "o9", status: "revision_requested", business_name: "Couple App", change_request_note: "Show the streak screen", package: { title: "1 UGC video" }, brief: null }],
      scope: "active",
      order: "",
    });
    render(<CreatorInbox />);
    expect(await screen.findByText(/Couple App asked for changes/)).toBeTruthy();
    expect(screen.getByText(/Show the streak screen/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /See feedback and reply/ }).getAttribute("href")).toBe("/creator/jobs/o9#feedback");
  });

  it("opens Updates from Zavi while anything in it is new", async () => {
    api.inbox.mockResolvedValue({ requests: [], alerts: [alert("a1")], unread_alerts: 1, order: "" });
    const { container } = render(<CreatorInbox />);
    await screen.findByText("Acme Coffee sent you a message");
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
  });

  it("the Inbox count adds changes asked and unread updates, not message alerts twice", () => {
    const changes = [{ status: "revision_requested" } as never];
    const alerts = [alert("a1", { kind: "approved" }), alert("a2", { kind: "thread_message" }), alert("a3", { kind: "paid", read_at: "x" })] as never[];
    expect(inboxCount([], [], changes, alerts)).toBe(2);
  });

  it("a booking request and its unread alert count once", () => {
    expect(inboxCount([{} as never], [], [], [alert("a1", { kind: "booking_request_received" })] as never[])).toBe(1);
  });
});

describe("opening a conversation reads its new-message alerts", () => {
  it("picks only unread thread_message alerts that link to that thread", () => {
    const alerts = [
      alert("a1", { kind: "thread_message", link_path: "/creator?thread=t1" }),
      alert("a2", { kind: "thread_message", link_path: "/creator?thread=t2" }),
      alert("a3", { kind: "thread_message", link_path: "/creator?thread=t1", read_at: "2026-09-21T00:00:00Z" }),
      alert("a4", { kind: "creator_approved", link_path: "/creator?thread=t1" }),
    ];
    expect(threadAlertIds(alerts as never, "t1")).toEqual(["a1"]);
  });
});

describe("reading a conversation clears its Messages badge", () => {
  it("stops counting once opened, and counts again when the business writes after that", async () => {
    const { markCreatorThreadSeen, messagesWaiting } = await import("./CreatorInbox");
    localStorage.clear();
    const t = (at: string) =>
      ({ thread_id: "t1", business_name: "B", last_message_at: at, last_message: { body: "hi", sender_kind: "tenant", created_at: at }, open_offer: null }) as never;
    expect(messagesWaiting([t("2026-10-01T10:00:00Z")])).toBe(1);
    markCreatorThreadSeen("t1", "2026-10-01T10:00:00Z");
    expect(messagesWaiting([t("2026-10-01T10:00:00Z")])).toBe(0);
    expect(messagesWaiting([t("2026-10-01T11:00:00Z")])).toBe(1);
    localStorage.clear();
  });
});
