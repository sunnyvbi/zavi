// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ThreadPane,
  clampPaneWidthPct,
  THREAD_PANE_DEFAULT_PCT,
  THREAD_PANE_MIN_PX,
} from "./ThreadPane";
import { THREAD_REPLY_PLACEHOLDER } from "./ThreadPaneComposer";
import type { ChatRow } from "./ChatThread";

const rowProps: Array<{ id: string; variant?: string }> = [];

vi.mock("./ChatThread", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./ChatThread");
  return {
    ...actual,
    RowRenderer: ({ row, variant }: { row: { id: string }; variant?: string }) => {
      rowProps.push({ id: row.id, variant });
      return <div data-testid={`row-${row.id}`}>{row.id}</div>;
    },
  };
});

function row(id: string): ChatRow {
  return {
    id,
    kind: "chat_user",
    created_at: "2026-07-18T00:00:00.000Z",
    body: { text: id },
  } as unknown as ChatRow;
}

type Box = { client: number; scrollH: number; offsetParent: unknown };
const boxes = new WeakMap<HTMLElement, Box>();
const scrollTops = new WeakMap<HTMLElement, number>();
const roCallbacks: Array<() => void> = [];

function giveMetrics(el: HTMLElement, box: Box) {
  boxes.set(el, box);
}

function flushResize() {
  act(() => {
    roCallbacks.forEach((cb) => cb());
  });
}

beforeEach(() => {
  rowProps.length = 0;
  roCallbacks.length = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(cb: () => void) {
      roCallbacks.push(cb);
    }
    observe() {}
    disconnect() {}
  };
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return boxes.get(this)?.client ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return boxes.get(this)?.scrollH ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      scrollTops.set(this, v);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      const b = boxes.get(this);
      return b ? b.offsetParent : ({} as unknown);
    },
  });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function baseProps(over: Partial<React.ComponentProps<typeof ThreadPane>> = {}) {
  return {
    threadId: "t1",
    agentSlug: "research",
    rootRow: row("root"),
    replies: [row("r1"), row("r2")],
    onClose: vi.fn(),
    ...over,
  } as React.ComponentProps<typeof ThreadPane>;
}

describe("ThreadPane — scroll structure (constraint 1)", () => {
  it("owns a scroller that is a strict ancestor of the rows and a strict descendant of the pane root", () => {
    render(<ThreadPane {...baseProps()} />);
    const pane = screen.getByTestId("thread-pane");
    const scroller = screen.getByTestId("thread-pane-scroller");
    const rows = screen.getByTestId("thread-pane-rows");

    expect(scroller.className).toContain("overflow-y-auto");
    expect(pane.contains(scroller)).toBe(true);
    expect(scroller).not.toBe(pane);
    expect(scroller.contains(rows)).toBe(true);
    expect(scroller).not.toBe(rows);
  });

  it("puts no horizontally-scrolling wrapper between the rows and the scroller", () => {
    render(<ThreadPane {...baseProps()} />);
    const scroller = screen.getByTestId("thread-pane-scroller");
    let node: HTMLElement | null = screen.getByTestId("thread-pane-rows");
    while (node && node !== scroller) {
      expect(node.className).not.toMatch(/overflow-x-(auto|scroll)/);
      node = node.parentElement;
    }
    expect(node).toBe(scroller);
  });
});

describe("ThreadPane — pin to bottom", () => {
  it("constraint 2: a pane that was hidden pins to the bottom once it becomes measurable", () => {
    const { container } = render(<ThreadPane {...baseProps()} />);
    const scroller = container.querySelector(
      '[data-testid="thread-pane-scroller"]',
    ) as HTMLElement;

    giveMetrics(scroller, { client: 0, scrollH: 0, offsetParent: null });
    expect(scroller.scrollTop).toBe(0);

    giveMetrics(scroller, { client: 500, scrollH: 2000, offsetParent: {} });
    flushResize();

    expect(scroller.scrollTop).toBe(2000);
  });

  it("constraint 3: swapping threadId on a STILL-MOUNTED pane re-pins to the bottom", () => {
    const { container, rerender } = render(<ThreadPane {...baseProps()} />);
    const scroller = container.querySelector(
      '[data-testid="thread-pane-scroller"]',
    ) as HTMLElement;
    giveMetrics(scroller, { client: 500, scrollH: 2000, offsetParent: {} });
    flushResize();
    expect(scroller.scrollTop).toBe(2000);

    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    giveMetrics(scroller, { client: 500, scrollH: 3000, offsetParent: {} });
    rerender(
      <ThreadPane {...baseProps({ threadId: "t2", replies: [row("z1")] })} />,
    );

    expect(scroller.scrollTop).toBe(3000);
  });

  it("constraint 3 (belt): a genuine remount via key also opens at the bottom", () => {
    const { container, rerender } = render(
      <ThreadPane key="t1" {...baseProps()} />,
    );
    let scroller = container.querySelector(
      '[data-testid="thread-pane-scroller"]',
    ) as HTMLElement;
    giveMetrics(scroller, { client: 500, scrollH: 2000, offsetParent: {} });
    flushResize();
    scroller.scrollTop = 50;
    fireEvent.scroll(scroller);

    rerender(<ThreadPane key="t2" {...baseProps({ threadId: "t2" })} />);
    scroller = container.querySelector(
      '[data-testid="thread-pane-scroller"]',
    ) as HTMLElement;
    giveMetrics(scroller, { client: 500, scrollH: 1500, offsetParent: {} });
    flushResize();

    expect(scroller.scrollTop).toBe(1500);
  });

  it("does not yank a user who scrolled up when a new reply lands", () => {
    const { container, rerender } = render(<ThreadPane {...baseProps()} />);
    const scroller = container.querySelector(
      '[data-testid="thread-pane-scroller"]',
    ) as HTMLElement;
    giveMetrics(scroller, { client: 500, scrollH: 2000, offsetParent: {} });
    flushResize();

    scroller.scrollTop = 100;
    fireEvent.scroll(scroller);

    giveMetrics(scroller, { client: 500, scrollH: 2600, offsetParent: {} });
    rerender(
      <ThreadPane
        {...baseProps({ replies: [row("r1"), row("r2"), row("r3")] })}
      />,
    );
    expect(scroller.scrollTop).toBe(100);
  });
});

describe("ThreadPane — focus + Esc", () => {
  it("moves focus into the pane on open", () => {
    render(<ThreadPane {...baseProps()} />);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Thread" }),
    );
  });

  it("Esc closes and returns focus to the thread line that opened it — not document.body", () => {
    const opener = document.createElement("button");
    opener.textContent = "thread line";
    document.body.appendChild(opener);
    const returnFocusRef = { current: opener };
    const onClose = vi.fn();

    render(<ThreadPane {...baseProps({ onClose, returnFocusRef })} />);
    fireEvent.keyDown(screen.getByTestId("thread-pane"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
    expect(document.activeElement).not.toBe(document.body);
    opener.remove();
  });

  it("falls back to whatever had focus at mount when no returnFocusRef is given", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    render(<ThreadPane {...baseProps()} />);
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});

describe("ThreadPane — resizer a11y", () => {
  it("is a keyboard-resizable separator with an accessible name", () => {
    render(<ThreadPane {...baseProps()} />);
    const sep = screen.getByRole("separator", { name: "Resize thread pane" });
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.getAttribute("tabindex")).toBe("0");
    expect(sep.getAttribute("aria-valuenow")).not.toBeNull();
    expect(sep.getAttribute("aria-valuemin")).toBe(String(THREAD_PANE_MIN_PX));
  });

  it("arrow keys resize and commit a clamped percentage", () => {
    const onWidthCommit = vi.fn();
    render(<ThreadPane {...baseProps({ onWidthCommit })} />);
    const sep = screen.getByRole("separator");
    const before = Number(sep.getAttribute("aria-valuenow"));

    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    const after = Number(
      screen.getByRole("separator").getAttribute("aria-valuenow"),
    );

    expect(after).toBeGreaterThan(before);
    expect(onWidthCommit).toHaveBeenCalled();
    const pct = onWidthCommit.mock.calls.at(-1)?.[0] as number;
    expect(pct).toBeGreaterThanOrEqual(20);
    expect(pct).toBeLessThanOrEqual(80);
  });

  it("leaves at least 340px for the feed at the widest, and floors the pane at 340px", () => {
    render(<ThreadPane {...baseProps()} />);
    const sep = screen.getByRole("separator");
    const vw = window.innerWidth;

    fireEvent.keyDown(sep, { key: "End" });
    const max = Number(
      screen.getByRole("separator").getAttribute("aria-valuenow"),
    );
    expect(vw - max).toBeGreaterThanOrEqual(THREAD_PANE_MIN_PX);

    fireEvent.keyDown(screen.getByRole("separator"), { key: "Home" });
    const min = Number(
      screen.getByRole("separator").getAttribute("aria-valuenow"),
    );
    expect(min).toBe(THREAD_PANE_MIN_PX);
  });
});

describe("ThreadPane — loading", () => {
  it("renders a skeleton, not a visible loading sentence", () => {
    const { container } = render(<ThreadPane {...baseProps({ loading: true })} />);
    expect(container.querySelector(".sr-only")?.textContent).toContain("Loading");
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(8);
  });

  it("shows the error message instead of the skeleton when the load fails", () => {
    const { container } = render(
      <ThreadPane {...baseProps({ loading: true, errorMsg: "nope" })} />,
    );
    expect(container.textContent).toContain("nope");
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });
});

describe("ThreadPane — composer slot", () => {
  it("renders the injected composer instead of the built-in one", () => {
    render(
      <ThreadPane
        {...baseProps()}
        composer={<div data-testid="injected-composer">real composer</div>}
      />,
    );
    expect(screen.getByTestId("injected-composer")).toBeTruthy();
    expect(screen.queryByTestId("thread-pane-composer")).toBeNull();
  });

  it("falls back to the built-in composer when no slot is passed", () => {
    render(<ThreadPane {...baseProps()} />);
    expect(screen.getByTestId("thread-pane-composer")).toBeTruthy();
  });
});

describe("clampPaneWidthPct", () => {
  it("holds the persisted pref inside 20-80", () => {
    expect(clampPaneWidthPct(52)).toBe(52);
    expect(clampPaneWidthPct(5)).toBe(20);
    expect(clampPaneWidthPct(95)).toBe(80);
    expect(clampPaneWidthPct(Number.NaN)).toBe(THREAD_PANE_DEFAULT_PCT);
  });

  it("defaults to the design's ~388px-of-1440 proportion", () => {
    expect(THREAD_PANE_DEFAULT_PCT).toBe(27);
    expect(clampPaneWidthPct(THREAD_PANE_DEFAULT_PCT)).toBe(
      THREAD_PANE_DEFAULT_PCT,
    );
  });
});

describe("ThreadPane — contents + composer", () => {
  it("renders the root message and every reply through the shared RowRenderer", () => {
    render(<ThreadPane {...baseProps()} />);
    expect(screen.getByTestId("row-root")).toBeTruthy();
    expect(screen.getByTestId("row-r1")).toBeTruthy();
    expect(screen.getByTestId("row-r2")).toBeTruthy();
    expect(
      screen.getByTestId("thread-pane-root").contains(screen.getByTestId("row-root")),
    ).toBe(true);
  });

  it("announces streaming replies politely, never assertively", () => {
    render(<ThreadPane {...baseProps({ streamingText: "thinking…" })} />);
    const live = screen.getByTestId("thread-pane-live");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.getAttribute("aria-live")).not.toBe("assertive");
    expect(live.textContent).toContain("thinking…");
  });

  it("has its OWN composer that reads 'Reply…' — not 'Message <agent>…'", () => {
    render(<ThreadPane {...baseProps()} />);
    const ta = screen.getByPlaceholderText(THREAD_REPLY_PLACEHOLDER);
    expect(ta).toBeTruthy();
    expect(THREAD_REPLY_PLACEHOLDER).toBe("Reply…");
    expect(screen.queryByPlaceholderText(/^Message /)).toBeNull();
  });

  it("keeps an EXPLICIT accessible name — placement is not a screen-reader cue", () => {
    render(<ThreadPane {...baseProps({ agentSlug: "research" })} />);
    expect(
      screen.getByLabelText("Reply in this research thread"),
    ).toBeTruthy();
  });

  it("does not ship dead formatting/attach controls", () => {
    render(<ThreadPane {...baseProps()} />);
    const buttons = screen
      .getByTestId("thread-pane-composer")
      .querySelectorAll("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0].getAttribute("aria-label")).toMatch(/send reply/i);
  });

  it("sends a reply on Enter and clears the box", () => {
    const onSendReply = vi.fn();
    render(<ThreadPane {...baseProps({ onSendReply })} />);
    const ta = screen.getByPlaceholderText(
      THREAD_REPLY_PLACEHOLDER,
    ) as HTMLTextAreaElement;

    fireEvent.change(ta, { target: { value: "  continue this run  " } });
    fireEvent.keyDown(ta, { key: "Enter" });

    expect(onSendReply).toHaveBeenCalledWith("continue this run");
    expect(ta.value).toBe("");
  });

  it("Shift+Enter does not send", () => {
    const onSendReply = vi.fn();
    render(<ThreadPane {...baseProps({ onSendReply })} />);
    const ta = screen.getByPlaceholderText(THREAD_REPLY_PLACEHOLDER);
    fireEvent.change(ta, { target: { value: "line one" } });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(onSendReply).not.toHaveBeenCalled();
  });
});

describe("ThreadPane — Slack-shaped rows", () => {
  it("renders EVERY row flat — root and replies alike", () => {
    render(<ThreadPane {...baseProps()} />);
    expect(rowProps.length).toBeGreaterThan(0);
    expect(rowProps.every((p) => p.variant === "flat")).toBe(true);
    expect([...new Set(rowProps.map((p) => p.id))]).toEqual([
      "root",
      "r1",
      "r2",
    ]);
  });

  it("labels the reply run with a count", () => {
    render(<ThreadPane {...baseProps()} />);
    expect(screen.getByTestId("thread-pane-reply-count").textContent).toContain(
      "2 replies",
    );
  });

  it("singularises a lone reply", () => {
    render(<ThreadPane {...baseProps({ replies: [row("only")] })} />);
    expect(screen.getByTestId("thread-pane-reply-count").textContent).toContain(
      "1 reply",
    );
  });

  it("omits the divider entirely when nothing has replied yet", () => {
    render(<ThreadPane {...baseProps({ replies: [] })} />);
    expect(screen.queryByTestId("thread-pane-reply-count")).toBeNull();
    expect(screen.getByTestId("row-root")).toBeTruthy();
  });

  it("keeps the reply count between the root message and the first reply", () => {
    const { container } = render(<ThreadPane {...baseProps()} />);
    const text = container.textContent ?? "";
    expect(text.indexOf("root")).toBeLessThan(text.indexOf("2 replies"));
    expect(text.indexOf("2 replies")).toBeLessThan(text.indexOf("r1"));
  });
});
