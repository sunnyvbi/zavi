// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));

import { TEAM_NOTE_FLAG_TOOLTIP, TeamNoteFlag } from "./TeamNoteFlag";
import { ChatBubble } from "../ChatBubble";
import type { OfferedTeamNote } from "@/lib/workspace/teamNote";

const A = "44444444-4444-4444-4444-44444444000a";
const B = "44444444-4444-4444-4444-44444444000b";
const flag = (messageId = A, state: "drafted" | "shown" = "drafted"): OfferedTeamNote =>
  ({ messageId, offerId: "o", note: `Note for ${messageId.slice(-1)}.`, offerStop: false, state, surface: "flag", anchorMessageId: null });
const json = (b: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => b });
const url = (i: number) => String(apiFetch.mock.calls[i][0]);
const bodyOf = (i: number) => JSON.parse(apiFetch.mock.calls[i][1].body);
const button = () => screen.getByRole("button", { name: "Tell the Zavi team this reply may have gone wrong" });
const panel = () => within(screen.getByRole("dialog", { name: "Tell the Zavi team" }));

beforeEach(() => apiFetch.mockReset());
afterEach(() => cleanup());

describe("TeamNoteFlag", () => {
  it("renders a quiet flag with the tooltip, and asks the server nothing until clicked", () => {
    render(<TeamNoteFlag note={flag()} />);
    expect(button().getAttribute("title")).toBe(TEAM_NOTE_FLAG_TOOLTIP);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("renders nothing without a note", () => {
    const { container } = render(<TeamNoteFlag note={null} />);
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });

  it("click: awaits /shown {via:'flag'} on the raw message id, then opens the panel and records the open", async () => {
    apiFetch.mockResolvedValueOnce(json({ show: true, offer_stop: false })).mockResolvedValue(json({}));
    render(<TeamNoteFlag note={flag()} />);
    fireEvent.click(button());
    expect(screen.queryByRole("dialog", { name: "Tell the Zavi team" })).toBeNull();
    await screen.findByRole("dialog", { name: "Tell the Zavi team" });
    expect(url(0)).toBe(`/api/team-notes/${A}/shown`);
    expect(bodyOf(0)).toEqual({ via: "flag" });
    expect(url(1)).toBe(`/api/team-notes/${A}/opened`);
    expect((panel().getByLabelText("Note to the Zavi team") as HTMLTextAreaElement).value).toBe("Note for a.");
  });

  it("the server says no (sent elsewhere, suggestions off): the flag goes away, no panel", async () => {
    apiFetch.mockResolvedValueOnce(json({ show: false }));
    const { container } = render(<TeamNoteFlag note={flag()} />);
    fireEvent.click(button());
    await waitFor(() => expect(container.querySelector("button")).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Tell the Zavi team" })).toBeNull();
  });

  it.each([
    ["a 500", () => apiFetch.mockResolvedValueOnce(json({}, false))],
    ["a network error", () => apiFetch.mockRejectedValueOnce(new Error("offline"))],
  ])("a failed open (%s) says so and keeps the flag for a retry", async (_l, fail) => {
    fail();
    render(<TeamNoteFlag note={flag()} />);
    fireEvent.click(button());
    expect((await screen.findByRole("alert")).textContent).toMatch(/try again/);
    apiFetch.mockResolvedValueOnce(json({ show: true })).mockResolvedValue(json({}));
    fireEvent.click(button());
    await screen.findByRole("dialog", { name: "Tell the Zavi team" });
  });

  it("edit + add, Send to Zavi team posts both; Sent survives the refetch that drops the note", async () => {
    apiFetch.mockResolvedValueOnce(json({ show: true })).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ status: "sent" }));
    const { rerender } = render(<TeamNoteFlag note={flag()} />);
    fireEvent.click(button());
    await screen.findByRole("dialog", { name: "Tell the Zavi team" });
    fireEvent.change(panel().getByLabelText("Note to the Zavi team"), { target: { value: "Edited." } });
    fireEvent.change(panel().getByLabelText("Anything to add?"), { target: { value: "More." } });
    fireEvent.click(panel().getByRole("button", { name: "Send to Zavi team" }));
    await screen.findByText("Sent to the Zavi team");
    expect(url(2)).toBe(`/api/team-notes/${A}/send`);
    expect(bodyOf(2)).toEqual({ note: "Edited.", extra: "More." });
    rerender(<TeamNoteFlag note={null} />);
    expect(screen.getByText("Sent to the Zavi team")).toBeTruthy();
  });

  it("a failed send never says Sent", async () => {
    apiFetch.mockResolvedValueOnce(json({ show: true })).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({}, false));
    render(<TeamNoteFlag note={flag()} />);
    fireEvent.click(button());
    await screen.findByRole("dialog", { name: "Tell the Zavi team" });
    fireEvent.click(panel().getByRole("button", { name: "Send to Zavi team" }));
    await screen.findByText("Not sent, try again");
    expect(screen.queryByText("Sent to the Zavi team")).toBeNull();
  });

  it("Dismiss posts stop:false and removes the flag", async () => {
    apiFetch.mockResolvedValueOnce(json({ show: true })).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ status: "dismissed" }));
    const { container } = render(<TeamNoteFlag note={flag()} />);
    fireEvent.click(button());
    await screen.findByRole("dialog", { name: "Tell the Zavi team" });
    fireEvent.click(panel().getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(bodyOf(2)).toEqual({ stop: false });
  });

  it("Close keeps the flag and changes nothing on the server", async () => {
    apiFetch.mockResolvedValueOnce(json({ show: true })).mockResolvedValue(json({}));
    render(<TeamNoteFlag note={flag()} />);
    fireEvent.click(button());
    await screen.findByRole("dialog", { name: "Tell the Zavi team" });
    fireEvent.click(panel().getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Tell the Zavi team" })).toBeNull();
    expect(button()).toBeTruthy();
    expect(apiFetch.mock.calls.map((c) => String(c[0]).split("/").pop())).toEqual(["shown", "opened"]);
  });

  it("a different note starts over (a Sent line never carries to another reply)", async () => {
    apiFetch.mockResolvedValueOnce(json({ show: true })).mockResolvedValueOnce(json({})).mockResolvedValueOnce(json({ status: "sent" }));
    const { rerender } = render(<TeamNoteFlag note={flag(A)} />);
    fireEvent.click(button());
    await screen.findByRole("dialog", { name: "Tell the Zavi team" });
    fireEvent.click(panel().getByRole("button", { name: "Send to Zavi team" }));
    await screen.findByText("Sent to the Zavi team");
    rerender(<TeamNoteFlag note={flag(B)} />);
    expect(screen.queryByText("Sent to the Zavi team")).toBeNull();
    expect(button()).toBeTruthy();
  });
});

describe("TeamNotePanel is an accessible modal", () => {
  const openPanel = async () => {
    apiFetch.mockResolvedValueOnce(json({ show: true })).mockResolvedValue(json({}));
    render(<TeamNoteFlag note={flag()} />);
    button().focus();
    fireEvent.click(button());
    return screen.findByRole("dialog", { name: "Tell the Zavi team" });
  };

  it("is a labelled modal dialog and focus starts in the note field", async () => {
    const dialog = await openPanel();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(panel().getByLabelText("Note to the Zavi team"));
    expect(button().getAttribute("aria-expanded")).toBe("true");
  });

  it("Escape closes it and focus goes back to the flag that opened it", async () => {
    await openPanel();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(button());
  });

  it("Close returns focus to the flag too", async () => {
    await openPanel();
    fireEvent.click(panel().getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(button());
  });

  it("Tab and Shift+Tab wrap inside the panel", async () => {
    const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    try {
      await openPanel();
      const close = panel().getByRole("button", { name: "Close" });
      const dismiss = panel().getByRole("button", { name: "Dismiss" });
      dismiss.focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(document.activeElement).toBe(close);
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(dismiss);
    } finally {
      rects.mockRestore();
    }
  });

  it("Escape is ignored while a send is in flight", async () => {
    await openPanel();
    let release: (v: unknown) => void = () => {};
    apiFetch.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    fireEvent.click(panel().getByRole("button", { name: "Send to Zavi team" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    release(json({ status: "sent" }));
    await screen.findByText("Sent to the Zavi team");
  });
});

describe("ChatBubble footer", () => {
  it("shows the flag next to Copy on a settled reply with a note", () => {
    render(<ChatBubble role="assistant" text="Here is the answer." teamNoteFlag={flag()} />);
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
    expect(button()).toBeTruthy();
  });

  it("no flag without a note, while streaming, or on surfaces that pass nothing", () => {
    const { rerender } = render(<ChatBubble role="assistant" text="Answer." teamNoteFlag={null} />);
    expect(screen.queryByTestId("team-note-flag")).toBeNull();
    rerender(<ChatBubble role="assistant" text="Answer." teamNoteFlag={flag()} isStreaming />);
    expect(screen.queryByTestId("team-note-flag")).toBeNull();
    rerender(<ChatBubble role="assistant" text="Answer." />);
    expect(screen.queryByTestId("team-note-flag")).toBeNull();
  });
});
