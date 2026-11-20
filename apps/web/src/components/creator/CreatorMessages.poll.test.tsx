// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@zavi/shared", () => ({ CREATOR_MARKETPLACE_ENABLED: true }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("thread=t1"),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/creator/messages",
}));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
const api = vi.hoisted(() => ({
  threads: vi.fn(),
  threadMessages: vi.fn(),
  threadOffers: vi.fn(),
  inbox: vi.fn(),
  markAlertRead: vi.fn(),
  sendThreadMessage: vi.fn(),
}));
vi.mock("@/lib/creator/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/creator/api")>()),
  creatorApi: api,
}));

import { CreatorMessages } from "./CreatorMessages";

type Msg = { id: string; sender_kind: "tenant" | "creator"; body: string; created_at: string };
let server: Msg[];
const T1 = "2026-10-16T10:00:00.000Z";
const T2 = "2026-10-16T10:05:00.000Z";
const T3 = "2026-10-16T10:06:00.000Z";

function summary() {
  const last = server[server.length - 1];
  return {
    thread_id: "t1",
    business_name: "Bloom Co",
    last_message_at: last.created_at,
    last_message: { body: last.body, sender_kind: last.sender_kind, created_at: last.created_at },
    open_offer: null,
  };
}

function setVisibility(v: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
}

const thread = () => within(document.querySelector("section") as HTMLElement);

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  setVisibility("visible");
  localStorage.clear();
  server = [{ id: "m1", sender_kind: "tenant", body: "Hi from Bloom", created_at: T1 }];
  for (const f of Object.values(api)) f.mockReset();
  api.threads.mockImplementation(async () => ({ threads: [summary()], order: "" }));
  api.threadMessages.mockImplementation(async () => ({ ok: true, messages: [...server] }));
  api.threadOffers.mockImplementation(async () => ({ ok: true, offers: [] }));
  api.inbox.mockResolvedValue({ requests: [], alerts: [], unread_alerts: 0, order: "" });
  api.markAlertRead.mockResolvedValue({});
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("an open creator conversation keeps itself current", () => {
  it("a business reply on the server shows in the open thread within 3 seconds, the draft survives, and it is marked seen at once", async () => {
    render(<CreatorMessages />);
    await flush();
    expect(thread().getByText("Hi from Bloom")).toBeTruthy();
    expect(localStorage.getItem("zavi.creator.seen.t1")).toBe(T1);

    fireEvent.change(screen.getByLabelText("Write a message"), { target: { value: "half written" } });
    server.push({ id: "m2", sender_kind: "tenant", body: "Are you free Friday?", created_at: T2 });

    await flush(2_999);
    expect(thread().queryByText("Are you free Friday?")).toBeNull();
    expect(localStorage.getItem("zavi.creator.seen.t1")).toBe(T1);

    await flush(1);
    expect(thread().getByText("Are you free Friday?")).toBeTruthy();
    expect((screen.getByLabelText("Write a message") as HTMLTextAreaElement).value).toBe("half written");
    expect(localStorage.getItem("zavi.creator.seen.t1")).toBe(T2);
  });

  it("a slow read is never stacked, and the conversation list keeps its 30s clock", async () => {
    render(<CreatorMessages />);
    await flush();
    const msgs = api.threadMessages.mock.calls.length;
    const lists = api.threads.mock.calls.length;
    let release!: (v: { ok: true; messages: Msg[] }) => void;
    api.threadMessages.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await flush(3_000);
    expect(api.threadMessages.mock.calls.length).toBe(msgs + 1);
    await flush(11_000);
    expect(api.threadMessages.mock.calls.length).toBe(msgs + 1);
    expect(api.threads.mock.calls.length).toBe(lists);
    await act(async () => {
      release({ ok: true, messages: [...server] });
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush(3_000);
    expect(api.threadMessages.mock.calls.length).toBe(msgs + 2);
    await flush(13_000);
    expect(api.threads.mock.calls.length).toBe(lists + 1);
  });

  it("a read that never answers does not stop the 3 second check for good", async () => {
    render(<CreatorMessages />);
    await flush();
    const msgs = api.threadMessages.mock.calls.length;
    api.threadMessages.mockImplementationOnce(() => new Promise(() => {}));
    await flush(3_000);
    expect(api.threadMessages.mock.calls.length).toBe(msgs + 1);
    await flush(12_000);
    expect(api.threadMessages.mock.calls.length).toBe(msgs + 1);
    server.push({ id: "m2", sender_kind: "tenant", body: "Still there?", created_at: T2 });
    await flush(3_000);
    expect(api.threadMessages.mock.calls.length).toBe(msgs + 2);
    expect(thread().getByText("Still there?")).toBeTruthy();
  });

  it("an offer you just withdrew is not flipped back by a read that started before you pressed", async () => {
    const offer = {
      id: "of1",
      thread_id: "t1",
      proposed_by: "creator",
      kind: "ugc_video",
      terms: { title: "1 UGC video" },
      price_cents: 5_000,
      delivery_days: 7,
      note: null,
      status: "open",
      expires_at: "2026-10-20T00:00:00.000Z",
      created_at: T1,
      expired: false,
      fees: { price_cents: 5_000, creator_fee_cents: 750, creator_payout_cents: 4_250 },
    };
    api.threadOffers.mockImplementation(async () => ({ ok: true, offers: [offer] }));
    render(<CreatorMessages />);
    await flush();
    let release!: (v: { ok: true; offers: unknown[] }) => void;
    api.threadOffers.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await flush(3_000);
    (api as unknown as { withdrawOffer: ReturnType<typeof vi.fn> }).withdrawOffer = vi.fn(async () => ({ ok: true, offer: { ...offer, status: "withdrawn" } })) as unknown as ReturnType<typeof vi.fn>;
    fireEvent.click(thread().getByRole("button", { name: "Withdraw" }));
    await flush();
    const cardText = () => (document.querySelector("section") as HTMLElement).textContent ?? "";
    expect(cardText()).toContain("You withdrew this offer");
    await act(async () => {
      release({ ok: true, offers: [offer] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(cardText()).toContain("You withdrew this offer");
    expect(thread().queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("a poll that started before a send and lands after it does not drop the sent message", async () => {
    render(<CreatorMessages />);
    await flush();
    let release!: (v: { ok: true; messages: Msg[] }) => void;
    api.threadMessages.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await flush(30_000);
    const stale = [...server];
    const sent: Msg = { id: "m3", sender_kind: "creator", body: "Yes, Friday works", created_at: T3 };
    api.sendThreadMessage.mockResolvedValueOnce({ ok: true, message: sent });
    server.push(sent);
    fireEvent.change(screen.getByLabelText("Write a message"), { target: { value: "Yes, Friday works" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    expect(thread().getByText("Yes, Friday works")).toBeTruthy();
    await act(async () => {
      release({ ok: true, messages: stale });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(thread().getByText("Yes, Friday works")).toBeTruthy();
  });

  it("a hidden tab does not poll, and polling resumes when it is visible again", async () => {
    render(<CreatorMessages />);
    await flush();
    const msgs = api.threadMessages.mock.calls.length;
    const lists = api.threads.mock.calls.length;
    setVisibility("hidden");
    server.push({ id: "m2", sender_kind: "tenant", body: "Are you free Friday?", created_at: T2 });
    await flush(120_000);
    expect(api.threadMessages.mock.calls.length).toBe(msgs);
    expect(api.threads.mock.calls.length).toBe(lists);
    expect(thread().queryByText("Are you free Friday?")).toBeNull();
    setVisibility("visible");
    await flush(30_000);
    expect(thread().getByText("Are you free Friday?")).toBeTruthy();
  });

  it("stops polling after unmount, even with a read in flight", async () => {
    const { unmount } = render(<CreatorMessages />);
    await flush();
    let release!: (v: { ok: true; messages: Msg[] }) => void;
    api.threadMessages.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await flush(30_000);
    const msgs = api.threadMessages.mock.calls.length;
    const lists = api.threads.mock.calls.length;
    unmount();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => {
      release({ ok: true, messages: [...server] });
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(api.threadMessages.mock.calls.length).toBe(msgs);
    expect(api.threads.mock.calls.length).toBe(lists);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
