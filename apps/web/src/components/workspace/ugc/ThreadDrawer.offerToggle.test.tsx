// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const net = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body?: unknown }> }));

vi.mock("@/lib/creator/introVideo", () => ({ openIntroVideo: vi.fn() }));
vi.mock("./useCards", async (orig) => ({
  ...(await orig<typeof import("./useCards")>()),
  useCreatorCards: () => ({}),
  callJson: vi.fn(async (path: string, init?: { body?: unknown }) => {
    net.calls.push({ path, body: init?.body });
    if (path === "/api/creators/threads")
      return {
        ok: true,
        data: {
          threads: [
            {
              thread_id: "t1",
              human_member_id: "m1",
              display_name: "Maya Films",
              last_message: { body: "Hi", sender_kind: "creator", created_at: "2026-10-21T10:00:00Z" },
              last_message_at: "2026-10-21T10:00:00Z",
              unread_count: 0,
            },
          ],
        },
      };
    if (path === "/api/creators/invites/threads") return { ok: true, data: { threads: [] } };
    if (path === "/api/creators/threads/t1/messages")
      return { ok: true, data: { messages: [{ id: "x1", thread_id: "t1", sender_kind: "creator", body: "Hi", created_at: "2026-10-21T10:00:00Z" }] } };
    if (path === "/api/creators/threads/t1/offers") return init?.body ? { ok: true, data: { offer: { thread_id: "t1" } } } : { ok: true, data: { offers: [] } };
    return { ok: true, data: {} };
  }),
}));

import { OFFER_SENT_MS, ThreadDrawer } from "./ThreadDrawer";

beforeEach(() => {
  net.calls.length = 0;
  window.history.replaceState(null, "", "/workspace?tab=channels&channel=ugc&drawer=thread&creator=m1");
});
afterEach(cleanup);

const offerButton = () => screen.queryByRole("button", { name: "Send a custom offer" });
const composer = () => screen.queryByPlaceholderText("Message Maya");

describe("the custom offer opens only when asked", () => {
  it("starts with the message box and a Send a custom offer button, not the form", async () => {
    render(<ThreadDrawer />);
    await waitFor(() => expect(offerButton()).not.toBeNull());
    const pinned = screen.getByTestId("thread-composer");
    expect(pinned.className).toContain("sticky bottom-0");
    expect(pinned.className).not.toMatch(/\bpt-\d/);
    expect(pinned.querySelector("form")?.className).not.toMatch(/\bmt-\d/);
    expect(pinned.className).toContain("before:bg-gradient-to-t");
    const gap = Number(/\bmt-(\d+)\b/.exec(pinned.className)?.[1]);
    const fade = Number(/before:h-(\d+)\b/.exec(pinned.className)?.[1]);
    expect(gap).toBeGreaterThan(fade);
    expect(composer()).not.toBeNull();
    expect(screen.queryByText("Send a custom offer", { selector: "p" })).toBeNull();
    expect(screen.queryByLabelText("Price")).toBeNull();
  });

  it("opens scrolled to the latest message, opens the form above the message box and scrolls the drawer to the bottom, and Cancel closes it without sending", async () => {
    const scrolls: Array<{ el: Element; opts: unknown }> = [];
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      value: function (this: Element, opts: unknown) {
        scrolls.push({ el: this, opts });
      },
      configurable: true,
    });
    render(<ThreadDrawer />);
    await waitFor(() => expect(offerButton()).not.toBeNull());
    fireEvent.click(offerButton()!);
    const form = screen.getByTestId("offer-form");
    expect(screen.getByLabelText("Price")).toBeTruthy();
    expect(composer()).not.toBeNull();
    expect(form.compareDocumentPosition(composer()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((offerButton() as HTMLButtonElement).disabled).toBe(true);
    expect(scrolls[0].opts).toMatchObject({ behavior: "auto" });
    const last = scrolls.at(-1)!;
    expect(last.el.hasAttribute("data-scroll-root")).toBe(true);
    expect(last.el.contains(form)).toBe(true);
    expect(last.opts).toMatchObject({ behavior: "smooth" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Price")).toBeNull();
    expect((offerButton() as HTMLButtonElement).disabled).toBe(false);
    expect(net.calls.some((c) => c.path === "/api/creators/threads/t1/offers" && c.body)).toBe(false);
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it("after sending, the form closes, says it was sent, and another offer can be started", async () => {
    render(<ThreadDrawer />);
    await waitFor(() => expect(offerButton()).not.toBeNull());
    fireEvent.click(offerButton()!);
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "150" } });
    fireEvent.change(screen.getByLabelText("Days to deliver"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    await waitFor(() => expect(screen.queryByLabelText("Price")).toBeNull());
    expect(net.calls.filter((c) => c.path === "/api/creators/threads/t1/offers" && c.body)).toHaveLength(1);
    expect(screen.getByText("Offer sent. Maya gets an email.")).toBeTruthy();
    expect(composer()).not.toBeNull();
    fireEvent.click(offerButton()!);
    expect((screen.getByLabelText("Price") as HTMLInputElement).value).toBe("");
  });

  it("the Offer sent line goes away on its own after a couple of seconds", async () => {
    render(<ThreadDrawer />);
    await waitFor(() => expect(offerButton()).not.toBeNull());
    fireEvent.click(offerButton()!);
    fireEvent.change(screen.getByLabelText("Price"), { target: { value: "150" } });
    fireEvent.change(screen.getByLabelText("Days to deliver"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Send offer" }));
    await waitFor(() => expect(screen.getByText("Offer sent. Maya gets an email.")).toBeTruthy());
    expect(OFFER_SENT_MS).toBeGreaterThanOrEqual(2000);
    expect(OFFER_SENT_MS).toBeLessThanOrEqual(3000);
    await waitFor(() => expect(screen.queryByText("Offer sent. Maya gets an email.")).toBeNull(), { timeout: OFFER_SENT_MS + 1500 });
    expect(offerButton()).not.toBeNull();
  });
});
