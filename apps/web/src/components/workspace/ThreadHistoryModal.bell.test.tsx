// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ThreadHistoryModal } from "./ThreadHistoryModal";
import type { ThreadMeta } from "./threadHistory";

const thread = (id: string, unread: boolean): ThreadMeta =>
  ({
    id,
    title: `Thread ${id}`,
    last_message: "hello",
    last_message_at: "2026-07-18T00:00:00.000Z",
    unread,
  }) as ThreadMeta;

function renderModal(threads: ThreadMeta[], currentThreadId?: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <ThreadHistoryModal
        threads={threads}
        currentThreadId={currentThreadId}
        mainThreadId={null}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
  });
  return document.body.innerHTML;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Conversations modal unread marker", () => {
  it("renders a bell for an unread thread", () => {
    const html = renderModal([thread("a", true)]);
    expect(html).toContain("Unread reply");
  });

  it("renders nothing for a read thread", () => {
    const html = renderModal([thread("a", false)]);
    expect(html).not.toContain("Unread reply");
  });

  it("suppresses the bell on the thread you're currently reading", () => {
    const html = renderModal([thread("a", true)], "a");
    expect(html).not.toContain("Unread reply");
  });

  it("never pairs the bell with a count", () => {
    const html = renderModal([thread("a", true), thread("b", true)]);
    expect(html.split('aria-label="Unread reply"').length - 1).toBe(2);
    expect(html).not.toContain(">2<");
  });
});
