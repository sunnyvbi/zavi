
import { act, createElement, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { MessageList } from "./MessageList";
import { Header } from "./Header";

if (!("scrollIntoView" in Element.prototype)) {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
}

function render(node: JSX.Element): string {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  const text = host.textContent ?? "";
  act(() => root.unmount());
  host.remove();
  return text;
}

const baseList = {
  messages: [],
  pending: null,
  approvals: [],
  getToken: async () => "tok",
  onDecided: () => {},
};

describe("the wait shows the work", () => {
  it("lists what the run has actually done", () => {
    const text = render(
      createElement(MessageList, {
        ...baseList,
        phase: "thinking" as const,
        steps: [
          { type: "thought" as const, key: "a", text: "Checking what we already know about pricing." },
          {
            type: "group" as const,
            key: "b",
            label: "Checked what it knows about your company",
            count: 2,
            state: "done" as const,
            tools: [
              { key: "t1", name: "search", input: '{"q":"pricing"}', output: "4 notes", ms: 0, state: "done" as const },
              { key: "t2", name: "search", input: '{"q":"plans"}', output: "2 notes", ms: 0, state: "done" as const },
            ],
          },
        ],
      }),
    );
    expect(text).toContain("Checking what we already know about pricing.");
    expect(text).toContain("Checked what it knows about your company");
    expect(text).toContain("\u00d72");
    expect(text).not.toContain("4 notes");
  });

  it("keeps a failed step visible, and says it failed", () => {
    const text = render(
      createElement(MessageList, {
        ...baseList,
        phase: "thinking" as const,
        steps: [
          {
            type: "group" as const,
            key: "a",
            label: "Checked your team chat",
            count: 1,
            state: "failed" as const,
            tools: [{ key: "t", name: "post_message", input: "{}", output: "channel_not_found", ms: 0, state: "failed" as const }],
          },
        ],
      }),
    );
    expect(text).toContain("Checked your team chat");
    expect(text).toContain("could not read");
  });

  it("still says something when there are no steps", () => {
    const text = render(
      createElement(MessageList, { ...baseList, phase: "thinking" as const, steps: [] }),
    );
    expect(text).toContain("Zavi is working");
  });

  it("shows nothing at all when no turn is in flight", () => {
    const text = render(
      createElement(MessageList, { ...baseList, phase: null, steps: [] }),
    );
    expect(text).not.toContain("Zavi is working");
  });
});

describe("the header chip still makes the promise", () => {
  it("says Screenshot on the surface, with the page title", () => {
    const text = render(
      createElement(Header, {
        liveTitle: "Upcar — Rent Cars from Local Owners",
        onNewThread: () => {},
        onOpenSettings: () => {},
      }),
    );
    expect(text).toContain("Screenshot");
    expect(text).toContain("Upcar — Rent Cars from Local Owners");
  });

  it("still names what happens when the tab has no title", () => {
    const text = render(
      createElement(Header, {
        liveTitle: null,
        onNewThread: () => {},
        onOpenSettings: () => {},
      }),
    );
    expect(text).toContain("Screenshot");
    expect(text).toContain("the tab you are on");
  });
});
