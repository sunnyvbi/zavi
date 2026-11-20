// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { ThreadHistoryModal } from "./ThreadHistoryModal";
import type { ThreadMeta } from "./threadHistory";

afterEach(cleanup);

function mk(over: Partial<ThreadMeta> & { id: string }): ThreadMeta {
  return {
    title: null,
    last_message_at: null,
    created_at: null,
    last_message: null,
    run_status: null,
    presentation_status: null,
    pending: null,
    ...over,
  };
}

const THREADS: ThreadMeta[] = [
  mk({ id: "old", title: "Older chat", last_message_at: "2026-07-01T00:00:00Z" }),
  mk({
    id: "new",
    title: "Newest chat",
    last_message_at: "2026-07-10T00:00:00Z",
    last_message: "## Plan Add a `GET /health` endpoint",
  }),
  mk({ id: "mid", title: "Middle chat", last_message_at: "2026-07-05T00:00:00Z" }),
];

function renderModal(over: Partial<React.ComponentProps<typeof ThreadHistoryModal>> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <ThreadHistoryModal
      threads={THREADS}
      currentThreadId="mid"
      mainThreadId="old"
      onSelect={onSelect}
      onClose={onClose}
      {...over}
    />,
  );
  return { onSelect, onClose, ...utils };
}

describe("ThreadHistoryModal", () => {
  it("renders a dialog with rows in recency-desc order", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const titles = within(dialog)
      .getAllByRole("button")
      .map((b) => b.textContent || "")
      .filter((t) => /chat/i.test(t));
    expect(titles[0]).toMatch(/Newest chat/);
    expect(titles[1]).toMatch(/Middle chat/);
    expect(titles[2]).toMatch(/Older chat/);
  });

  it("renders the message preview as clean plain text (markdown stripped)", () => {
    renderModal();
    expect(screen.getByText("Plan Add a GET /health endpoint")).toBeTruthy();
    expect(screen.queryByText(/##|`/)).toBeNull();
  });

  it("marks the current thread row with aria-current", () => {
    renderModal({ currentThreadId: "new" });
    const active = screen.getByRole("button", { current: true });
    expect(active.textContent).toMatch(/Newest chat/);
  });

  it("clicking a row resumes that thread then closes", () => {
    const { onSelect, onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /Middle chat/ }));
    expect(onSelect).toHaveBeenCalledWith("mid");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ESC closes the modal", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ESC-to-close does NOT reach a competing document ESC listener (AgentTab run-cancel)", () => {
    const runCancel = vi.fn();
    const onKey = (e: Event) => {
      if ((e as KeyboardEvent).key === "Escape") runCancel();
    };
    document.addEventListener("keydown", onKey);
    try {
      const { onClose } = renderModal();
      fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(runCancel).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", onKey);
    }
  });

  it("backdrop mousedown closes; clicking inside the dialog does not", () => {
    const { onClose } = renderModal();
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement as HTMLElement;
    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state when there are no threads", () => {
    renderModal({ threads: [] });
    expect(screen.getByText(/No conversations yet/i)).toBeTruthy();
  });

  it("restores focus to the opener element on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = renderModal();
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
