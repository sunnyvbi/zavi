// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { toast } from "@/components/ui/toast";
import { CardActions } from "../CardActions";
import { MOVE_DELAY_MS, MOVE_EXIT_MS, useMoveToHistory } from "../useMoveToHistory";
import { CHANNEL_HISTORY_CHANGED_EVENT, CHANNEL_HISTORY_VIEW_EVENT } from "../../useChannelHistory";

function Card({ active, onGone }: { active: boolean; onGone: () => void }) {
  useMoveToHistory({ id: "c1", slug: "x_organic", title: "Review the draft", active, onGone });
  return <article data-testid="action-c1" />;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useMoveToHistory", () => {
  it("removes the card after the wait, refreshes History and says where it went", () => {
    const add = vi.spyOn(toast, "add").mockImplementation(() => "t");
    const onGone = vi.fn();
    const changed = vi.fn();
    const viewed = vi.fn();
    window.addEventListener(CHANNEL_HISTORY_CHANGED_EVENT, changed);
    window.addEventListener(CHANNEL_HISTORY_VIEW_EVENT, viewed);
    render(<Card active onGone={onGone} />);
    vi.advanceTimersByTime(MOVE_DELAY_MS + MOVE_EXIT_MS - 1);
    expect(onGone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    const options = add.mock.calls[0]![0];
    expect(options.position).toBe("bottom-center");
    (options.actionProps!.onClick as () => void)();
    expect((viewed.mock.calls[0]![0] as CustomEvent).detail).toEqual({ slug: "x_organic", id: "c1" });
    window.removeEventListener(CHANNEL_HISTORY_CHANGED_EVENT, changed);
    window.removeEventListener(CHANNEL_HISTORY_VIEW_EVENT, viewed);
  });

  it("removes a card closed with the close icon without a History toast", () => {
    const add = vi.spyOn(toast, "add").mockImplementation(() => "t");
    const onGone = vi.fn();
    const changed = vi.fn();
    window.addEventListener(CHANNEL_HISTORY_CHANGED_EVENT, changed);
    function Quiet() {
      useMoveToHistory({ id: "c1", slug: "x_organic", title: "Review the draft", active: true, history: false, onGone });
      return <article data-testid="action-c1" />;
    }
    render(<Quiet />);
    vi.advanceTimersByTime(MOVE_DELAY_MS + MOVE_EXIT_MS);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    window.removeEventListener(CHANNEL_HISTORY_CHANGED_EVENT, changed);
  });

  it("keeps the card when the move is undone before the wait ends", () => {
    const add = vi.spyOn(toast, "add").mockImplementation(() => "t");
    const onGone = vi.fn();
    const view = render(<Card active onGone={onGone} />);
    vi.advanceTimersByTime(MOVE_DELAY_MS - 100);
    view.rerender(<Card active={false} onGone={onGone} />);
    vi.advanceTimersByTime(5000);
    expect(onGone).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});

describe("CardActions resolved", () => {
  const base = { primary: null, secondary: [], onRun: () => undefined, onConfirm: () => undefined };

  it("says the card is moving to History and keeps Undo", () => {
    const onUndo = vi.fn();
    render(<CardActions {...base} flow={{ s: "resolved", tone: "success", label: "Posted on X", undo: true, moving: true }} moving onUndo={onUndo} />);
    expect(screen.getByRole("status").textContent).toBe("Posted on X");
    expect(screen.getByTestId("moving-to-history").textContent).toBe("· Moving to History");
    screen.getByRole("button", { name: "Undo" }).click();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("says nothing about History for a card that stays", () => {
    render(<CardActions {...base} flow={{ s: "resolved", tone: "muted", label: "Not now", undo: true }} />);
    expect(screen.queryByTestId("moving-to-history")).toBeNull();
  });
});
