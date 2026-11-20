// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/workspace" }));

import { PastChatsPopover } from "./PastChatsPopover";

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function mountAndOpen(onOpenChange = vi.fn()) {
  render(
    <div>
      <p>outside</p>
      <PastChatsPopover
        load={h.list}
        placeName="Meta Ads"
        currentThreadId={null}
        onPick={() => {}}
        onOpenChange={onOpenChange}
      />
    </div>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
  });
  await settle();
  return onOpenChange;
}

beforeEach(() => {
  h.list.mockReset();
  h.list.mockResolvedValue([]);
});
afterEach(cleanup);

describe("PastChatsPopover", () => {
  it("an outside click closes it", async () => {
    const onOpenChange = await mountAndOpen();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      fireEvent.pointerDown(screen.getByText("outside"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("Escape closes it", async () => {
    await mountAndOpen();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a failed load shows Retry, and Retry loads again", async () => {
    h.list.mockRejectedValueOnce(new Error("offline"));
    h.list.mockResolvedValueOnce([
      { id: "t1", title: "Back again", preview: null, last_message_at: null, channel_action_id: null, card_title: null },
    ]);
    await mountAndOpen();
    expect(screen.getByText("Couldn't load your past chats.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await settle();
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Back again")).toBeTruthy();
  });

  it("fetches on every open, so a chat sent a moment ago is listed", async () => {
    await mountAndOpen();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
    });
    await settle();
    expect(h.list).toHaveBeenCalledTimes(2);
  });
});

describe("PastChatsPopover from-Home tag", () => {
  it("tags a Home chat Your CGO answered in, and only that one", async () => {
    h.list.mockResolvedValue([
      { id: "a", title: "Home ask", preview: null, last_message_at: null, channel_action_id: null, card_title: null, from_home: true },
      { id: "b", title: "Own chat", preview: null, last_message_at: null, channel_action_id: null, card_title: null },
    ]);
    await mountAndOpen();
    expect(screen.getAllByText("from Home")).toHaveLength(1);
    expect(screen.getByText("Home ask").parentElement?.textContent).toContain("from Home");
  });
});
