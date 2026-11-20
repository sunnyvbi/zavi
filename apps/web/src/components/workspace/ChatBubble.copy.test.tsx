// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatBubble } from "./ChatBubble";
import { COPIED_MS } from "./CopyMessageButton";

const url =
  "http://localhost:3011/api/public/workspace-files/b92dcbf1-bac9-457a-af81-0bbe5984339b/cd9ec0c2-1c87-483f-9930-4a18bc701015/hero.jpeg";
const ASK = "Plan my **launch**\n\n- week 1\n- week 2";
const REPLY = "## Launch plan\n\n1. Ship the `beta`\n2. Post on [HN](https://news.ycombinator.com)";
const PHOTO = `put it in the hero\n\nUse this photo on the site:\nhero.jpeg: ${url}`;
const REPLY_PLAIN = "Launch plan\n\n1. Ship the beta\n2. Post on HN (https://news.ycombinator.com)";
const FOLLOW_UP = "Make it *shorter*";
const DRAFT = "## Half a reply so";

function Transcript({ variant = "bubble" as "bubble" | "flat", editable = false }) {
  return (
    <div>
      <div data-testid="ask">
        <ChatBubble role="user" text={ASK} variant={variant} onEdit={editable ? () => {} : undefined} />
      </div>
      <div data-testid="reply">
        <ChatBubble role="assistant" text={REPLY} agentSlug="operator" variant={variant} />
      </div>
      <div data-testid="photo">
        <ChatBubble role="user" text={PHOTO} variant={variant} />
      </div>
      <div data-testid="follow">
        <ChatBubble role="user" text={FOLLOW_UP} variant={variant} onEdit={editable ? () => {} : undefined} />
      </div>
      <div data-testid="draft">
        <ChatBubble role="assistant" text={DRAFT} agentSlug="operator" isStreaming />
      </div>
      <div data-testid="system">
        <ChatBubble role="system" text="Run stopped" />
      </div>
    </div>
  );
}

const copyIn = (id: string) => within(screen.getByTestId(id)).getByRole("button", { name: "Copy message" });

let writeText: Mock<[string], Promise<void>>;

beforeEach(() => {
  writeText = vi.fn((_text: string) => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChatBubble copy on your own messages", () => {
  for (const variant of ["bubble", "flat"] as const) {
    for (const editable of [false, true]) {
      it(`copies the raw text of the clicked message (${variant}, edit ${editable ? "on" : "off"})`, async () => {
        render(<Transcript variant={variant} editable={editable} />);

        await act(async () => {
          fireEvent.click(copyIn("follow"));
        });
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenLastCalledWith(FOLLOW_UP);
        expect(within(screen.getByTestId("follow")).getByRole("button", { name: "Copied" })).toBeTruthy();
        expect(copyIn("ask")).toBeTruthy();

        await act(async () => {
          fireEvent.click(copyIn("photo"));
        });
        expect(writeText).toHaveBeenLastCalledWith("put it in the hero");

        await act(async () => {
          fireEvent.click(copyIn("ask"));
        });
        expect(writeText).toHaveBeenLastCalledWith(ASK);

        await act(async () => {
          fireEvent.click(copyIn("reply"));
        });
        expect(writeText).toHaveBeenLastCalledWith(REPLY_PLAIN);
        expect(writeText).toHaveBeenCalledTimes(4);

        const editButtons = screen.queryAllByRole("button", { name: "Edit message" });
        expect(editButtons).toHaveLength(editable ? 2 : 0);
      });
    }
  }

  it("shows no copy on the streaming draft, the system line, or an empty user turn", () => {
    render(
      <>
        <Transcript />
        <div data-testid="empty">
          <ChatBubble role="user" text={"   \n "} attachments={[{ path: "a/b.pdf", kind: "doc" }]} />
        </div>
      </>,
    );
    for (const id of ["draft", "system", "empty"]) {
      expect(within(screen.getByTestId(id)).queryByRole("button", { name: /Copy|Copied/ })).toBeNull();
    }
    expect(within(screen.getByTestId("draft")).getByText("working…")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(4);
  });
});

describe("CopyMessageButton failure and timing", () => {
  it("never shows Copied, even for a moment, while writeText is pending and then rejects", async () => {
    let fail!: (reason: unknown) => void;
    writeText.mockImplementation(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    render(<Transcript />);
    await act(async () => {
      fireEvent.click(copyIn("ask"));
    });
    expect(writeText).toHaveBeenCalledWith(ASK);
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    await act(async () => {
      fail(new DOMException("denied", "NotAllowedError"));
    });
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    expect(copyIn("ask")).toBeTruthy();
  });

  it("does not throw when the clipboard API is missing", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<Transcript />);
    await act(async () => {
      fireEvent.click(copyIn("follow"));
    });
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });

  it("drops a stale Copied when a later copy of the same message fails", async () => {
    render(<Transcript />);
    await act(async () => {
      fireEvent.click(copyIn("follow"));
    });
    const copied = within(screen.getByTestId("follow")).getByRole("button", { name: "Copied" });
    writeText.mockImplementation(() => Promise.reject(new Error("blocked")));
    await act(async () => {
      fireEvent.click(copied);
    });
    expect(within(screen.getByTestId("follow")).queryByRole("button", { name: "Copied" })).toBeNull();
  });

  it("flips back after the timeout and leaves no timer behind on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<Transcript />);
    await act(async () => {
      fireEvent.click(copyIn("ask"));
    });
    expect(within(screen.getByTestId("ask")).getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(COPIED_MS - 1);
    });
    expect(within(screen.getByTestId("ask")).getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(copyIn("ask")).toBeTruthy();

    await act(async () => {
      fireEvent.click(copyIn("ask"));
    });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not set state when the write settles after the message unmounted", async () => {
    let settle!: () => void;
    writeText.mockImplementation(() => new Promise<void>((resolve) => (settle = resolve)));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    const { unmount } = render(<Transcript />);
    fireEvent.click(copyIn("reply"));
    unmount();
    await act(async () => {
      settle();
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("ChatBubble copy on a message that carries Files photos", () => {
  const SHOT = `can you use this img\n\nUse the "landing page" photos on the site:\n#wallpaper #musashi #vagabond #colored #instagram #aesthetic.jpeg: ${url}`;

  for (const variant of ["bubble", "flat"] as const) {
    it(`copies only the words you typed, never the photo link (${variant})`, async () => {
      render(<ChatBubble role="user" text={SHOT} variant={variant} onEdit={() => {}} />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
      });
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenLastCalledWith("can you use this img");
      expect(writeText.mock.calls[0]![0]).not.toMatch(/workspace-files|localhost|#wallpaper/);
    });

    it(`offers no copy on a photo-only message, since there are no words to copy (${variant})`, () => {
      render(<ChatBubble role="user" text={`Use this photo on the site:\nhero.jpeg: ${url}`} variant={variant} />);
      expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
    });
  }
});

describe("ChatBubble copy and edit hover shape", () => {
  it("draws the copy and edit affordances as circles, like every other icon button on the Build tab", () => {
    render(<ChatBubble role="user" text="hello" onEdit={() => {}} />);
    const copy = screen.getByRole("button", { name: "Copy message" });
    const edit = screen.getByRole("button", { name: /edit/i });
    for (const b of [copy, edit]) {
      expect(b.className).toContain("rounded-full");
      expect(b.className).not.toMatch(/rounded-(md|lg)\b/);
    }
  });
});

describe("Reply action buttons do not keep a focus ring after a click", () => {
  it("drops focus from Copy and the thumbs after a pointer click, but keeps it for a keyboard press", async () => {
    render(<ChatBubble role="assistant" text="Here is the plan" agentSlug="operator" feedbackRunId="run-1" />);
    const copy = screen.getByRole("button", { name: "Copy message" });
    const good = screen.getByRole("button", { name: "Good response" });

    for (const b of [copy, good]) {
      b.focus();
      await act(async () => {
        fireEvent.click(b, { detail: 1 });
      });
      expect(document.activeElement).not.toBe(b);
    }

    const copyAgain = screen.getByRole("button", { name: /Cop/ });
    copyAgain.focus();
    await act(async () => {
      fireEvent.click(copyAgain, { detail: 0 });
    });
    expect(document.activeElement).toBe(copyAgain);
  });
});

describe("Zavi reply copies formatted where the browser allows it", () => {
  it("writes HTML (bold, links made absolute) plus clean text in one clipboard item", async () => {
    const items: Record<string, Blob>[] = [];
    const write = vi.fn((list: { data: Record<string, Blob> }[]) => {
      items.push(list[0]!.data);
      return Promise.resolve();
    });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public data: Record<string, Blob>) {}
      },
    );
    Object.defineProperty(navigator, "clipboard", { value: { writeText, write }, configurable: true });
    render(
      <ChatBubble
        role="assistant"
        agentSlug="operator"
        text={"**Keep it.** See the [Growth page](/workspace?tab=growth-strategy)."}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();
    const read = (b: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsText(b);
      });
    const html = await read(items[0]!["text/html"]!);
    const plain = await read(items[0]!["text/plain"]!);
    expect(html).toContain("<strong>Keep it.</strong>");
    expect(html).toContain(`href="${window.location.origin}/workspace?tab=growth-strategy"`);
    expect(html).not.toMatch(/class=|<button/);
    expect(plain).toBe("Keep it. See the Growth page.");
    vi.unstubAllGlobals();
  });

  it("copyMarkdown null shows no Copy; a string copies that whole turn", async () => {
    render(
      <>
        <div data-testid="first">
          <ChatBubble role="assistant" agentSlug="operator" text="First." copyMarkdown={null} />
        </div>
        <div data-testid="last">
          <ChatBubble role="assistant" agentSlug="operator" text="Second." copyMarkdown={"First.\n\nSecond."} />
        </div>
      </>,
    );
    expect(within(screen.getByTestId("first")).queryByRole("button", { name: "Copy message" })).toBeNull();
    await act(async () => {
      fireEvent.click(copyIn("last"));
    });
    expect(writeText).toHaveBeenLastCalledWith("First.\n\nSecond.");
  });
});
