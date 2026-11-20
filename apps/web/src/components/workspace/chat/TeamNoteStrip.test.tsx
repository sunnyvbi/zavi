// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));

import { TeamNoteStrip } from "./TeamNoteStrip";
import type { OfferedTeamNote } from "@/lib/workspace/teamNote";

const A = "44444444-4444-4444-4444-44444444000a";
const B = "44444444-4444-4444-4444-44444444000b";
const TH = "thread-1";
const note = (state: "drafted" | "shown", offerStop = false, messageId = A): OfferedTeamNote =>
  ({ messageId, offerId: "o", note: `Note for ${messageId.slice(-1)}.`, offerStop, state, surface: "strip", anchorMessageId: messageId });
const panel = () => within(screen.getByRole("dialog", { name: "Tell the Zavi team" }));
const json = (b: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => b });
const url = (i: number) => String(apiFetch.mock.calls[i][0]);
const bodyOf = (i: number) => JSON.parse(apiFetch.mock.calls[i][1].body);
const STRIP = "That went badly. I wrote a note for the Zavi team.";
const SENT = "Sent to the Zavi team. Thanks for telling us.";
const expectNothing = (c: HTMLElement) => {
  expect(c.textContent).toBe("");
  expect(c.querySelector('[data-testid="team-note-strip"]')).toBeNull();
  expect(c.querySelectorAll("button").length).toBe(0);
};

beforeEach(() => apiFetch.mockReset());
afterEach(() => cleanup());

describe("TeamNoteStrip", () => {
  it("renders nothing without a note", () => {
    const { container } = render(<TeamNoteStrip threadId={TH} teamNote={null} replying={false} />);
    expectNothing(container);
  });

  it("renders nothing and asks nothing while the agent is replying", () => {
    const { container } = render(<TeamNoteStrip threadId={TH} teamNote={note("drafted")} replying />);
    expectNothing(container);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("drafted: asks the server to show it; renders only on show=true", async () => {
    apiFetch.mockResolvedValueOnce(json({ show: true, offer_stop: false }));
    render(<TeamNoteStrip threadId={TH} teamNote={note("drafted")} replying={false} />);
    await screen.findByText(STRIP);
    expect(url(0)).toBe(`/api/team-notes/${A}/shown`);
    expect(apiFetch.mock.calls[0][1].body).toBe("{}");
  });

  it("a note with no anchor (drafted before surfaces existed) is never a strip", () => {
    const { container } = render(<TeamNoteStrip threadId={TH} teamNote={{ ...note("shown"), surface: "flag", anchorMessageId: null }} replying={false} />);
    expectNothing(container);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("drafted: caps said no (or disabled), nothing renders", async () => {
    apiFetch.mockResolvedValueOnce(json({ show: false }));
    const { container } = render(<TeamNoteStrip threadId={TH} teamNote={note("drafted")} replying={false} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expectNothing(container);
  });

  it("drafted: /shown failure = no strip (fail quiet)", async () => {
    apiFetch.mockRejectedValueOnce(new Error("offline"));
    const { container } = render(<TeamNoteStrip threadId={TH} teamNote={note("drafted")} replying={false} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expectNothing(container);
  });

  it("shown (after reload): renders without another /shown call", () => {
    render(<TeamNoteStrip threadId={TH} teamNote={note("shown")} replying={false} />);
    expect(screen.getByText(STRIP)).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("one click sends the drafted note and confirms only after a 2xx; the confirmation survives the refetch to null", async () => {
    apiFetch.mockResolvedValueOnce(json({ status: "sent" }));
    const { rerender } = render(<TeamNoteStrip threadId={TH} teamNote={note("shown")} replying={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Send to Zavi team" }));
    await screen.findByText(SENT);
    expect(url(0)).toBe(`/api/team-notes/${A}/send`);
    expect(bodyOf(0)).toEqual({ note: "Note for a." });
    rerender(<TeamNoteStrip threadId={TH} teamNote={null} replying={false} />);
    expect(screen.getByText(SENT)).toBeTruthy();
  });

  it("the confirmation ends with the turn: once the founder sends a new message it is gone", async () => {
    apiFetch.mockResolvedValueOnce(json({ status: "sent" }));
    const { rerender, container } = render(<TeamNoteStrip threadId={TH} teamNote={note("shown")} replying={false} turnKey="m:u1" />);
    fireEvent.click(screen.getByRole("button", { name: "Send to Zavi team" }));
    await screen.findByText(SENT);
    rerender(<TeamNoteStrip threadId={TH} teamNote={null} replying={false} turnKey="m:u1" />);
    expect(screen.getByText(SENT)).toBeTruthy();
    rerender(<TeamNoteStrip threadId={TH} teamNote={null} replying turnKey="optimistic-u2" />);
    expectNothing(container);
    rerender(<TeamNoteStrip threadId={TH} teamNote={null} replying={false} turnKey="m:u2" />);
    expectNothing(container);
  });

  it("R12: A sent -> B offered -> null: B never shows A's confirmation, and nothing stale remains", async () => {
    apiFetch.mockResolvedValueOnce(json({ status: "sent" }));
    const { rerender, container } = render(<TeamNoteStrip threadId={TH} teamNote={note("shown", false, A)} replying={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Send to Zavi team" }));
    await screen.findByText(SENT);
    rerender(<TeamNoteStrip threadId={TH} teamNote={note("shown", false, B)} replying={false} />);
    expect(screen.queryByText(SENT)).toBeNull();
    expect(screen.getByText(STRIP)).toBeTruthy();
    rerender(<TeamNoteStrip threadId={TH} teamNote={null} replying={false} />);
    expectNothing(container);
  });

  it("R12: a thread switch resets everything, including a sent confirmation", async () => {
    apiFetch.mockResolvedValueOnce(json({ status: "sent" }));
    const { rerender, container } = render(<TeamNoteStrip threadId={TH} teamNote={note("shown")} replying={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Send to Zavi team" }));
    await screen.findByText(SENT);
    rerender(<TeamNoteStrip threadId="thread-2" teamNote={null} replying={false} />);
    expectNothing(container);
  });

  it("R12: an edited draft never leaks to the next message", () => {
    const { rerender } = render(<TeamNoteStrip threadId={TH} teamNote={note("shown", false, A)} replying={false} />);
    fireEvent.click(screen.getByRole("button", { name: "See note" }));
    fireEvent.change(screen.getByLabelText("Note to the Zavi team"), { target: { value: "Edited A" } });
    rerender(<TeamNoteStrip threadId={TH} teamNote={note("shown", false, B)} replying={false} />);
    expect(screen.queryByLabelText("Note to the Zavi team")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "See note" }));
    expect((screen.getByLabelText("Note to the Zavi team") as HTMLTextAreaElement).value).toBe("Note for b.");
  });

  it("a failed or thrown send never says Sent", async () => {
    apiFetch.mockResolvedValueOnce(json({}, false));
    render(<TeamNoteStrip threadId={TH} teamNote={note("shown")} replying={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Send to Zavi team" }));
    await screen.findByText("Not sent, try again");
    expect(screen.queryByText(SENT)).toBeNull();
    apiFetch.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Send to Zavi team" }));
    await screen.findByText("Not sent, try again");
  });

  it("See note: records the open, edit + add, then Send posts both", async () => {
    apiFetch.mockResolvedValue(json({ status: "sent" }));
    render(<TeamNoteStrip threadId={TH} teamNote={note("shown")} replying={false} />);
    fireEvent.click(screen.getByRole("button", { name: "See note" }));
    expect(url(0)).toBe(`/api/team-notes/${A}/opened`);
    fireEvent.change(screen.getByLabelText("Note to the Zavi team"), { target: { value: "Edited note." } });
    fireEvent.change(screen.getByLabelText("Anything to add?"), { target: { value: "Also on Tuesday." } });
    fireEvent.click(panel().getByRole("button", { name: "Send to Zavi team" }));
    await screen.findByText(SENT);
    const i = apiFetch.mock.calls.findIndex((c) => String(c[0]).endsWith("/send"));
    expect(bodyOf(i)).toEqual({ note: "Edited note.", extra: "Also on Tuesday." });
  });

  it("the panel's Dismiss dismisses and hides the strip", async () => {
    apiFetch.mockResolvedValue(json({ status: "dismissed" }));
    const { container } = render(<TeamNoteStrip threadId={TH} teamNote={note("shown")} replying={false} />);
    fireEvent.click(screen.getByRole("button", { name: "See note" }));
    fireEvent.click(panel().getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(apiFetch.mock.calls.some((c) => String(c[0]).endsWith("/dismiss"))).toBe(true));
    await waitFor(() => expectNothing(container));
  });

  it("See note opens a modal with focus in the note; closing hands focus back to See note", async () => {
    render(<TeamNoteStrip threadId={TH} teamNote={note("shown")} replying={false} />);
    const see = screen.getByRole("button", { name: "See note" });
    see.focus();
    fireEvent.click(see);
    expect(document.activeElement).toBe(panel().getByLabelText("Note to the Zavi team"));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "See note" }));
  });

  it("closing the panel (Close or Escape) changes nothing on the server", () => {
    render(<TeamNoteStrip threadId={TH} teamNote={note("shown")} replying={false} />);
    fireEvent.click(screen.getByRole("button", { name: "See note" }));
    fireEvent.click(panel().getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Tell the Zavi team" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "See note" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Tell the Zavi team" })).toBeNull();
    expect(apiFetch.mock.calls.every((c) => String(c[0]).endsWith("/opened"))).toBe(true);
    expect(screen.getByText(STRIP)).toBeTruthy();
  });

  it("Dismiss hides the strip once the server saved it", async () => {
    apiFetch.mockResolvedValue(json({ status: "dismissed" }));
    const { container } = render(<TeamNoteStrip threadId={TH} teamNote={note("shown")} replying={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(bodyOf(0)).toEqual({ stop: false });
    await waitFor(() => expectNothing(container));
  });

  it.each([
    ["a 500", () => apiFetch.mockResolvedValueOnce(json({}, false))],
    ["a network error", () => apiFetch.mockRejectedValueOnce(new Error("offline"))],
  ])("a failed dismiss (%s) keeps the strip up with an error, so Stop suggesting is never silently lost", async (_l, fail) => {
    fail();
    render(<TeamNoteStrip threadId={TH} teamNote={note("shown", true)} replying={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop suggesting these" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(STRIP)).toBeTruthy();
  });

  it("off screen (folded SideChat / background tab): never calls /shown, so no cap is spent", async () => {
    const { rerender } = render(<TeamNoteStrip threadId={TH} teamNote={note("drafted")} replying={false} visible={false} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiFetch).not.toHaveBeenCalled();
    apiFetch.mockResolvedValueOnce(json({ show: true }));
    rerender(<TeamNoteStrip threadId={TH} teamNote={note("drafted")} replying={false} visible />);
    await screen.findByText(STRIP);
    expect(url(0)).toBe(`/api/team-notes/${A}/shown`);
  });

  it("hidden by an ancestor (inactive workspace tab, display:none): never calls /shown until laid out", async () => {
    let cb: ((e: Array<{ isIntersecting: boolean }>) => void) | null = null;
    const IO = vi.fn(function (this: unknown, f: typeof cb) { cb = f; return { observe: () => cb?.([{ isIntersecting: false }]), disconnect: () => {} }; });
    vi.stubGlobal("IntersectionObserver", IO);
    try {
      render(<TeamNoteStrip threadId={TH} teamNote={note("drafted")} replying={false} />);
      await new Promise((r) => setTimeout(r, 0));
      expect(apiFetch).not.toHaveBeenCalled();
      apiFetch.mockResolvedValueOnce(json({ show: true }));
      await act(async () => { cb?.([{ isIntersecting: true }]); });
      await screen.findByText(STRIP);
      expect(url(0)).toBe(`/api/team-notes/${A}/shown`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("browser tab hidden: never calls /shown", async () => {
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<TeamNoteStrip threadId={TH} teamNote={note("drafted")} replying={false} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiFetch).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("Stop suggesting these: only when the server says so", async () => {
    apiFetch.mockResolvedValueOnce(json({ show: true, offer_stop: true })).mockResolvedValue(json({ status: "dismissed" }));
    render(<TeamNoteStrip threadId={TH} teamNote={note("drafted")} replying={false} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop suggesting these" }));
    expect(bodyOf(1)).toEqual({ stop: true });
  });

  it("no Stop suggesting these by default", () => {
    render(<TeamNoteStrip threadId={TH} teamNote={note("shown")} replying={false} />);
    expect(screen.queryByRole("button", { name: "Stop suggesting these" })).toBeNull();
  });
});
