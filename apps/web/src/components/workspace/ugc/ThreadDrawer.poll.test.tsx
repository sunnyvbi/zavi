// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

type Msg = { id: string; thread_id: string; sender_kind: "tenant" | "creator"; body: string; created_at: string };
type Res = { ok: true; data: unknown } | { ok: false; message: string; status: number };

const net = vi.hoisted(() => ({ calls: [] as string[], hold: null as null | ((path: string) => Promise<Res> | null), failList: false, offers: [] as unknown[] }));
let server: Msg[];

vi.mock("./useCards", async (orig) => ({
  ...(await orig<typeof import("./useCards")>()),
  useCreatorCards: () => ({}),
  callJson: vi.fn(async (path: string): Promise<Res> => {
    net.calls.push(path);
    const held = net.hold?.(path);
    if (held) return held;
    if (path === "/api/creators/threads") {
      if (net.failList) return { ok: false, message: "Upstream hiccup", status: 502 };
      const last = server[server.length - 1];
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
              unread_count: server.filter((m) => m.sender_kind === "creator").length,
            },
          ],
        },
      };
    }
    if (path === "/api/creators/invites/threads") return { ok: true, data: { threads: [] } };
    if (path === "/api/creators/threads/t1/messages") return { ok: true, data: { messages: [...server] } };
    if (path === "/api/creators/threads/t1/offers") return { ok: true, data: { offers: [...net.offers] } };
    if (path === "/api/creators/offers/of1/withdraw") return { ok: true, data: { offer: { ...(net.offers[0] as object), status: "withdrawn" } } };
    return { ok: true, data: {} };
  }),
}));

const T1 = "2026-10-16T10:00:00.000Z";
const T2 = "2026-10-16T10:05:00.000Z";

function setVisibility(v: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
}

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount() {
  vi.resetModules();
  const { ThreadDrawer } = await import("./ThreadDrawer");
  const r = render(<ThreadDrawer />);
  await flush();
  return r;
}

const reads = () => net.calls.filter((p) => p === "/api/creators/threads" || p === "/api/creators/threads/t1/messages").length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
  setVisibility("visible");
  localStorage.clear();
  net.calls.length = 0;
  net.hold = null;
  net.failList = false;
  net.offers = [];
  server = [{ id: "m1", thread_id: "t1", sender_kind: "creator", body: "Hi, happy to help", created_at: T1 }];
  window.history.replaceState(null, "", "/workspace?channel=ugc&drawer=thread&creator=m1");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the business thread drawer keeps the open conversation current", () => {
  it("a creator reply on the server shows within 3 seconds, the draft survives, and the thread is marked seen up to it", async () => {
    await mount();
    expect(screen.getByText("Hi, happy to help")).toBeTruthy();
    expect(localStorage.getItem("zavi.ugc.seen.t1")).toBe(T1);

    fireEvent.change(screen.getByLabelText("Message Maya"), { target: { value: "half written" } });
    server.push({ id: "m2", thread_id: "t1", sender_kind: "creator", body: "Shipping address?", created_at: T2 });

    await flush(2_999);
    expect(screen.queryByText("Shipping address?")).toBeNull();

    await flush(1);
    expect(screen.getByText("Shipping address?")).toBeTruthy();
    expect((screen.getByLabelText("Message Maya") as HTMLTextAreaElement).value).toBe("half written");
    expect(localStorage.getItem("zavi.ugc.seen.t1")).toBe(T2);
  });

  it("a slow conversation read is never stacked, and the conversation list keeps its 20s clock", async () => {
    await mount();
    const convo = () => net.calls.filter((p) => p === "/api/creators/threads/t1/messages").length;
    const list = () => net.calls.filter((p) => p === "/api/creators/threads").length;
    const c0 = convo();
    const l0 = list();
    let release!: (r: Res) => void;
    net.hold = (path) => (path === "/api/creators/threads/t1/messages" ? new Promise<Res>((r) => (release = r)) : null);
    await flush(3_000);
    net.hold = null;
    expect(convo()).toBe(c0 + 1);
    await flush(11_000);
    expect(convo()).toBe(c0 + 1);
    expect(list()).toBe(l0);
    await act(async () => {
      release({ ok: true, data: { messages: [...server] } });
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush(3_000);
    expect(convo()).toBe(c0 + 2);
    await flush(3_000);
    expect(list()).toBe(l0 + 1);
  });

  it("a conversation read that never answers does not stop the 3 second check for good", async () => {
    await mount();
    const convo = () => net.calls.filter((p) => p === "/api/creators/threads/t1/messages").length;
    const c0 = convo();
    net.hold = (path) => (path === "/api/creators/threads/t1/messages" ? new Promise<Res>(() => {}) : null);
    await flush(3_000);
    expect(convo()).toBe(c0 + 1);
    await flush(12_000);
    expect(convo()).toBe(c0 + 1);
    net.hold = null;
    server.push({ id: "m2", thread_id: "t1", sender_kind: "creator", body: "Still there?", created_at: T2 });
    await flush(3_000);
    expect(convo()).toBe(c0 + 2);
    expect(screen.getByText("Still there?")).toBeTruthy();
  });

  it("an offer you just withdrew is not flipped back by a read that started before you pressed", async () => {
    net.offers = [
      {
        id: "of1",
        human_member_id: "m1",
        thread_id: "t1",
        proposed_by: "tenant",
        kind: "ugc_video",
        terms: { title: "1 UGC video", content_type: "ugc", count: 1 },
        price_cents: 14_000,
        delivery_days: 7,
        note: null,
        status: "open",
        expires_at: "2026-10-24T00:00:00Z",
        responded_at: null,
        created_at: T1,
        fees: { price_cents: 14_000, business_fee_cents: 1_400, business_total_cents: 15_400, business_fee_label: "10%" },
        expired: false,
      },
    ];
    await mount();
    const card = () => screen.getByTestId("offer-card");
    let release!: (r: Res) => void;
    net.hold = (path) => (path === "/api/creators/threads/t1/offers" ? new Promise<Res>((r) => (release = r)) : null);
    await flush(3_000);
    net.hold = (path) => (path === "/api/creators/threads/t1/offers" ? new Promise<Res>(() => {}) : null);
    fireEvent.click(within(card()).getByRole("button", { name: "Withdraw" }));
    await flush();
    expect(within(card()).getByText("Withdrawn")).toBeTruthy();
    await act(async () => {
      release({ ok: true, data: { offers: [...net.offers] } });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(card()).getByText("Withdrawn")).toBeTruthy();
    expect(within(card()).queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("a stalled read that answers late does not put back an offer state a newer read already replaced", async () => {
    const offer = {
      id: "of1",
      human_member_id: "m1",
      thread_id: "t1",
      proposed_by: "tenant",
      kind: "ugc_video",
      terms: { title: "1 UGC video", content_type: "ugc", count: 1 },
      price_cents: 14_000,
      delivery_days: 7,
      note: null,
      status: "open",
      expires_at: "2026-10-24T00:00:00Z",
      responded_at: null,
      created_at: T1,
      fees: { price_cents: 14_000, business_fee_cents: 1_400, business_total_cents: 15_400, business_fee_label: "10%" },
      expired: false,
    };
    net.offers = [offer];
    await mount();
    let releaseOld!: (r: Res) => void;
    net.hold = (path) => (path === "/api/creators/threads/t1/offers" ? new Promise<Res>((r) => (releaseOld = r)) : null);
    await flush(3_000);
    net.hold = null;
    net.offers = [{ ...offer, status: "declined", responded_at: T2 }];
    await flush(15_000);
    expect(within(screen.getByTestId("offer-card")).getByText("Maya declined")).toBeTruthy();
    await act(async () => {
      releaseOld({ ok: true, data: { offers: [offer] } });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(screen.getByTestId("offer-card")).getByText("Maya declined")).toBeTruthy();
    expect(within(screen.getByTestId("offer-card")).queryByRole("button", { name: "Withdraw" })).toBeNull();
  });

  it("a failed background read keeps the conversation and shows no error", async () => {
    await mount();
    net.failList = true;
    await flush(20_000);
    expect(screen.queryByText("Upstream hiccup")).toBeNull();
    expect(screen.getByText("Hi, happy to help")).toBeTruthy();
  });

  it("a hidden tab does not poll, and polling resumes when it is visible again", async () => {
    await mount();
    const before = reads();
    setVisibility("hidden");
    server.push({ id: "m2", thread_id: "t1", sender_kind: "creator", body: "Shipping address?", created_at: T2 });
    await flush(100_000);
    expect(reads()).toBe(before);
    expect(screen.queryByText("Shipping address?")).toBeNull();
    setVisibility("visible");
    await flush(20_000);
    expect(screen.getByText("Shipping address?")).toBeTruthy();
  });

  it("stops polling after the drawer closes, even with a read in flight", async () => {
    const { unmount } = await mount();
    let release!: (r: Res) => void;
    net.hold = (path) => (path === "/api/creators/threads/t1/messages" ? new Promise<Res>((r) => (release = r)) : null);
    await flush(20_000);
    net.hold = null;
    const before = reads();
    unmount();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => {
      release({ ok: true, data: { messages: [...server] } });
      await vi.advanceTimersByTimeAsync(100_000);
    });
    expect(reads()).toBe(before);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
