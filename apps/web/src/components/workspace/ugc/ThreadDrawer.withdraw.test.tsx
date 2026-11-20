// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Res = { ok: boolean; data?: unknown; message?: string };
const net = vi.hoisted(() => ({
  calls: [] as string[],
  holdThreads: null as null | Promise<void>,
  offerReads: 0,
  withdraw: null as null | ((r: Res) => void),
}));

const openOffer = {
  id: "o1",
  human_member_id: "m1",
  thread_id: "t1",
  proposed_by: "tenant",
  kind: "ugc_video",
  terms: { title: "1 UGC video", content_type: "ugc", count: 1 },
  price_cents: 14000,
  delivery_days: 7,
  note: null,
  status: "open",
  expires_at: "2026-10-24T00:00:00Z",
  responded_at: null,
  created_at: "2026-10-21T14:00:00Z",
  fees: { price_cents: 14000, business_fee_cents: 1400, business_total_cents: 15400, business_fee_label: "10%" },
  expired: false,
};

vi.mock("@/lib/creator/introVideo", () => ({ openIntroVideo: vi.fn() }));
vi.mock("./useCards", async (orig) => ({
  ...(await orig<typeof import("./useCards")>()),
  useCreatorCards: () => ({}),
  callJson: vi.fn(async (path: string): Promise<Res> => {
    net.calls.push(path);
    if (path === "/api/creators/threads") {
      if (net.holdThreads) await net.holdThreads;
      return {
        ok: true,
        data: {
          threads: [
            {
              thread_id: "t1",
              human_member_id: "m1",
              display_name: "Mohit Dudhat",
              last_message: null,
              last_message_at: "2026-10-21T14:00:00Z",
              unread_count: 0,
            },
          ],
        },
      };
    }
    if (path === "/api/creators/invites/threads") return { ok: true, data: { threads: [] } };
    if (path === "/api/creators/threads/t1/messages") return { ok: true, data: { messages: [] } };
    if (path === "/api/creators/threads/t1/offers") {
      net.offerReads += 1;
      if (net.offerReads > 1) return new Promise<Res>(() => {});
      return { ok: true, data: { offers: [openOffer] } };
    }
    if (path === "/api/creators/offers/o1/withdraw") return new Promise<Res>((resolve) => (net.withdraw = resolve));
    return { ok: true, data: {} };
  }),
}));

beforeEach(() => {
  vi.resetModules();
  net.calls.length = 0;
  net.holdThreads = null;
  net.offerReads = 0;
  net.withdraw = null;
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=ugc&drawer=thread&creator=m1");
});
afterEach(cleanup);

const card = () => screen.getByTestId("offer-card");

describe("withdrawing your own offer", () => {
  it("shows Withdrawing at once, ignores a second press, and flips to Withdrawn from the answer without waiting for the thread to re-read", async () => {
    const { ThreadDrawer } = await import("./ThreadDrawer");
    render(<ThreadDrawer />);
    await waitFor(() => expect(within(card()).getByRole("button", { name: "Withdraw" })).toBeTruthy());

    fireEvent.click(within(card()).getByRole("button", { name: "Withdraw" }));
    const busy = within(card()).getByRole("button", { name: "Withdrawing..." }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(net.calls.filter((p) => p.endsWith("/withdraw"))).toHaveLength(1);

    await act(async () => net.withdraw!({ ok: true, data: { offer: { ...openOffer, status: "withdrawn", responded_at: "2026-10-22T05:00:00Z" } } }));
    await waitFor(() => expect(within(card()).getByText("Withdrawn")).toBeTruthy());
    expect(within(card()).queryByRole("button", { name: /Withdraw/ })).toBeNull();
    expect(net.offerReads).toBeGreaterThan(1);
  });

  it("a failed withdraw shows the server's reason on the card, once, and lets you try again", async () => {
    const { ThreadDrawer } = await import("./ThreadDrawer");
    render(<ThreadDrawer />);
    await waitFor(() => expect(within(card()).getByRole("button", { name: "Withdraw" })).toBeTruthy());
    fireEvent.click(within(card()).getByRole("button", { name: "Withdraw" }));
    await act(async () => net.withdraw!({ ok: false, message: "Offer is no longer open." }));
    expect(within(card()).getByRole("alert").textContent).toBe("Offer is no longer open.");
    expect(screen.getAllByText("Offer is no longer open.")).toHaveLength(1);
    const again = within(card()).getByRole("button", { name: "Withdraw" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(within(card()).getByText("Waiting for Mohit")).toBeTruthy();
  });
});

describe("the message box while the conversation loads", () => {
  it("is pinned at the bottom from the first paint, with typing, Send and the offer button held until the list lands", async () => {
    let release!: () => void;
    net.holdThreads = new Promise<void>((r) => (release = r));
    const { ThreadDrawer } = await import("./ThreadDrawer");
    render(<ThreadDrawer />);

    expect(screen.getAllByText("Loading messages.").length).toBeGreaterThan(0);
    const pinned = screen.getByTestId("thread-composer");
    expect(pinned.className).toContain("sticky bottom-0");
    const body = screen.getByTestId("thread-drawer-body");
    expect(body.className).toContain("min-h-full");
    let el: HTMLElement | null = pinned.parentElement;
    while (el && el !== body) {
      expect(el.className).toMatch(/\bflex-1\b/);
      el = el.parentElement;
    }
    expect(el).toBe(body);
    const box = within(pinned).getByRole("textbox") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect((within(pinned).getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    const offer = within(pinned).getByRole("button", { name: "Send a custom offer" }) as HTMLButtonElement;
    expect(offer.disabled).toBe(true);
    fireEvent.click(offer);
    expect(screen.queryByLabelText("Price")).toBeNull();

    await act(async () => release());
    await waitFor(() => expect((screen.getByPlaceholderText("Message Mohit") as HTMLTextAreaElement).disabled).toBe(false));
    expect(screen.getAllByTestId("thread-composer")).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Send a custom offer" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
