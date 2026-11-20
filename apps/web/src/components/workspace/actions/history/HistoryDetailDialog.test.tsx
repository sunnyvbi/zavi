// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { FIXTURES, makeAction } from "../__tests__/fixtures";
import type { ChannelClosedRow } from "../useChannelHistory";
import { HistoryDetailDialog } from "./HistoryDetailDialog";

const api = vi.hoisted(() => ({ readHistoryCard: vi.fn() }));
vi.mock("@/lib/workspace/channelActionsApi", async (orig) => ({ ...(await orig<typeof import("@/lib/workspace/channelActionsApi")>()), readHistoryCard: api.readHistoryCard }));

const item = {
  source: "action",
  row: {
    id: "ca-1", run_id: "r", position: 1, run_of: 1, action_type: "send_message", title: "Launch", status: "acted", status_at: "2026-10-16T06:31:00Z", note: null,
    proposed_at: "2026-10-16T06:30:46Z", impact: 1, impact_reason: null, score: 1,
  } as ChannelClosedRow,
} as const;

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(() => {
  cleanup();
  api.readHistoryCard.mockReset();
});

describe("HistoryDetailDialog single exit", () => {
  it("has exactly one Done button, no X and nothing named Close", () => {
    render(<HistoryDetailDialog item={item} onClose={() => undefined} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Done" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    expect(document.querySelector("dialog svg")).toBeNull();
  });

  it("puts Done in a footer after the content", () => {
    render(<HistoryDetailDialog item={item} onClose={() => undefined} />);
    const footer = screen.getByRole("button", { name: "Done" }).closest("footer")!;
    expect(footer.className).toContain("justify-end");
    expect(footer.previousElementSibling?.textContent).toContain("What happened");
  });

  it("Done closes it once", () => {
    const onClose = vi.fn();
    render(<HistoryDetailDialog item={item} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape still closes it", () => {
    const onClose = vi.fn();
    render(<HistoryDetailDialog item={item} onClose={onClose} />);
    fireEvent(document.querySelector("dialog")!, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("HistoryDetailDialog card", () => {
  const post = makeAction("text_post", {
    id: "ca-1",
    channel_slug: "linkedin_organic",
    title: "Post about the first ads test",
    status: "acted",
    body: { step: { title: "Post about the first ads test", body: "b", deliverable: { kind: "post", content: "Our first paid ads test is live." } }, media: { kind: "image", url: "https://cdn.example.com/a.png", alt: "The ad" } },
  });

  it("shows the card with its text and image, read only", async () => {
    api.readHistoryCard.mockResolvedValue(post);
    render(<HistoryDetailDialog item={item} showCard onClose={() => undefined} />);
    const card = await screen.findByTestId("history-card");
    expect(api.readHistoryCard).toHaveBeenCalledWith("ca-1");
    expect(within(card).getByText("Our first paid ads test is live.")).toBeTruthy();
    expect(card.querySelector("img")?.getAttribute("src")).toBe("https://cdn.example.com/a.png");
    expect(within(card).queryByRole("button", { name: /approve|reject|post|edit/i })).toBeNull();
  });

  it("shows the exact change of an ad change", async () => {
    api.readHistoryCard.mockResolvedValue(makeAction("pause_ad", { ...FIXTURES.pause_ad, id: "ca-1", status: "acted", exec_status: "executed" }));
    render(<HistoryDetailDialog item={item} showCard onClose={() => undefined} />);
    expect((await screen.findByTestId("history-card")).textContent?.length).toBeGreaterThan(0);
  });

  it("keeps the timeline when the card cannot be read", async () => {
    api.readHistoryCard.mockRejectedValue(new Error("offline"));
    render(<HistoryDetailDialog item={item} showCard onClose={() => undefined} />);
    await vi.waitFor(() => expect(screen.queryByRole("status", { name: "Loading the card" })).toBeNull());
    expect(screen.queryByTestId("history-card")).toBeNull();
    expect(screen.getByText("Zavi suggested it")).toBeTruthy();
  });

  it("reads no card unless asked", () => {
    render(<HistoryDetailDialog item={item} onClose={() => undefined} />);
    expect(api.readHistoryCard).not.toHaveBeenCalled();
  });
});

describe("HistoryDetailDialog for a LinkedIn audience card saved from Create audience", () => {
  const LINE = 'Saved to LinkedIn on Main: "Clinic owners". Saved under LinkedIn\'s own names: Design as "Arts and Design". Add them in Campaign Manager.';
  const saved = { source: "action", row: { ...item.row, note: LINE } } as const;

  it("lists what was saved line by line and never loads the card's unfilled draft text", () => {
    api.readHistoryCard.mockResolvedValue(FIXTURES.other);
    render(<HistoryDetailDialog item={saved} showCard onClose={() => undefined} />);
    const lines = within(screen.getByTestId("history-saved-audiences")).getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toEqual(['Saved to LinkedIn on Main: "Clinic owners".', 'Saved under LinkedIn\'s own names: Design as "Arts and Design".', "Add them in Campaign Manager."]);
    expect(api.readHistoryCard).not.toHaveBeenCalled();
    expect(screen.queryByTestId("history-card")).toBeNull();
    expect(screen.getByText("Saved to LinkedIn")).toBeTruthy();
  });

  it("still loads the card for any other done item", () => {
    api.readHistoryCard.mockResolvedValue(null);
    render(<HistoryDetailDialog item={{ source: "action", row: { ...item.row, note: "Looks fine" } }} showCard onClose={() => undefined} />);
    expect(api.readHistoryCard).toHaveBeenCalledWith("ca-1");
    expect(screen.queryByTestId("history-saved-audiences")).toBeNull();
  });
});
