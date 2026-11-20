// @vitest-environment jsdom

import { describe, it, expect, afterEach, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ThreadHistoryModal } from "./ThreadHistoryModal";
import type { ThreadMeta } from "./threadHistory";

const thread = (id: string): ThreadMeta =>
  ({
    id,
    title: `Thread ${id}`,
    last_message: "hello",
    last_message_at: "2026-07-22T00:00:00.000Z",
  }) as ThreadMeta;

function renderModal(props: {
  threads: ThreadMeta[];
  onDelete?: (id: string) => void;
  onSelect?: (id: string) => void;
}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <ThreadHistoryModal
        threads={props.threads}
        mainThreadId={null}
        onSelect={props.onSelect ?? (() => {})}
        onDelete={props.onDelete}
        onClose={() => {}}
      />,
    );
  });
}

const closeButtons = () =>
  Array.from(
    document.body.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
  ).filter((b) => b.getAttribute("aria-label")!.startsWith("Close Thread"));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Conversations modal close-thread X", () => {
  it("renders one close button per row when onDelete is given", () => {
    renderModal({ threads: [thread("a"), thread("b")], onDelete: () => {} });
    expect(closeButtons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Close Thread a",
      "Close Thread b",
    ]);
  });

  it("renders no close button when onDelete is omitted", () => {
    renderModal({ threads: [thread("a")] });
    expect(closeButtons()).toHaveLength(0);
  });

  it("calls onDelete with the thread id and does not select the row", () => {
    const onDelete = vi.fn();
    const onSelect = vi.fn();
    renderModal({ threads: [thread("a")], onDelete, onSelect });
    act(() => {
      closeButtons()[0].dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(onDelete).toHaveBeenCalledWith("a");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("hides the X at rest and reveals it on row hover", () => {
    renderModal({ threads: [thread("a")], onDelete: () => {} });
    const cls = closeButtons()[0].className;
    expect(cls).toContain("opacity-0");
    expect(cls).toContain("group-hover:opacity-100");
  });

  it("is inert while invisible and live once revealed", () => {
    renderModal({ threads: [thread("a")], onDelete: () => {} });
    const cls = closeButtons()[0].className;
    expect(cls).toContain("pointer-events-none");
    expect(cls).toContain("group-hover:pointer-events-auto");
    expect(cls).toContain("focus-visible:pointer-events-auto");
  });

  it("shows and enables the X on coarse pointers, where hover never fires", () => {
    renderModal({ threads: [thread("a")], onDelete: () => {} });
    const cls = closeButtons()[0].className;
    expect(cls).toContain("[@media(hover:none)]:opacity-100");
    expect(cls).toContain("[@media(hover:none)]:pointer-events-auto");
  });
});
