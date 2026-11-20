// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";

import { useModalFocusTrap } from "./shared";

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocusTrap(ref, onClose);
  return (
    <div ref={ref} role="dialog" tabIndex={-1}>
      <button type="button">first</button>
      <button type="button">second</button>
    </div>
  );
}

const rect = { length: 1 } as unknown as DOMRectList;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(rect);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  document.body.innerHTML = "";
});

describe("useModalFocusTrap", () => {
  it("leaves focus where the user put it when the parent hands in a new onClose", () => {
    const opener = document.createElement("button");
    opener.textContent = "open";
    document.body.append(opener);
    opener.focus();
    const returned = vi.fn();
    opener.addEventListener("focus", returned);

    const { getByText, rerender } = render(<Dialog onClose={() => {}} />);
    expect(document.activeElement).toBe(getByText("first"));

    getByText("second").focus();
    rerender(<Dialog onClose={() => {}} />);

    expect(document.activeElement).toBe(getByText("second"));
    expect(returned).not.toHaveBeenCalled();
  });

  it("calls the latest onClose on Escape, not the one it mounted with", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = render(<Dialog onClose={stale} />);
    rerender(<Dialog onClose={fresh} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the opener once on unmount", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { unmount, rerender } = render(<Dialog onClose={() => {}} />);
    rerender(<Dialog onClose={() => {}} />);
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
  });

  it("stays out of the way while its dialog sits inside a hidden container", () => {
    const onClose = vi.fn();
    const { rerender } = render(<div><Dialog onClose={onClose} /></div>);
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(true);
    rerender(<div hidden><Dialog onClose={onClose} /></div>);
    expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(document, { key: "Tab", shiftKey: true })).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
