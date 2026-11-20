// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExtraTable, type ExtraTableData } from "../ExtraTable";
import { ChannelChatProvider } from "../channelChat";

const data: ExtraTableData = {
  title: "Top issues",
  columns: [{ label: "Issue", align: "left" }],
  rows: [
    {
      id: "h1_missing",
      cells: [{ text: "5 pages have no H1 heading" }],
      actions: [{ label: "Fix with Zavi", chatDraft: "Help me fix this on my site: 5 pages have no H1 heading." }],
    },
  ],
  empty: "Nothing found.",
};

afterEach(cleanup);

describe("a chat-draft row action", () => {
  it("opens the channel chat with the draft, unsent", () => {
    const open = vi.fn();
    render(
      <ChannelChatProvider open={open}>
        <ExtraTable data={data} />
      </ChannelChatProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fix with Zavi" }));
    expect(open).toHaveBeenCalledTimes(1);
    const pin = open.mock.calls[0][0];
    expect(pin.target).toBe("channel");
    expect(pin.draft.text).toBe("Help me fix this on my site: 5 pages have no H1 heading.");
    expect(typeof pin.draft.nonce).toBe("number");
  });

  it("draws no button where the page has no chat to open", () => {
    render(<ExtraTable data={data} />);
    expect(screen.queryByRole("button", { name: "Fix with Zavi" })).toBeNull();
  });
});
