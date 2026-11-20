// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type * as React from "react";

import { HomeChatPanel } from "./HomeChatPanel";
import { commitTabsAndLocation } from "../../navigation/workspaceRoutes";

vi.mock("../../ThreadBar", () => ({
  ThreadBar: () => <div data-testid="thread-strip">pills</div>,
}));
vi.mock("../../ChatExpandButton", () => ({
  ChatExpandButton: () => <button type="button" aria-label="Expand chat" />,
  HEADER_CARD_SHADOW: "",
}));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspace: () => ({ userEmail: "founder@example.com", openTab: () => "t", role: "owner" }),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: () => ({ rows: [], loading: false, errorMsg: null, reload: () => {} }),
}));
vi.mock("../../Composer", () => ({ Composer: () => <textarea /> }));
vi.mock("../../ChatThread", () => ({ ChatThread: () => <div /> }));

afterEach(cleanup);

const base = {
  greeting: "Good afternoon, Ravi.",
  pulse: <span>pulse</span>,
  suggestions: [] as string[],
  expanded: false,
  onExpandedChange: () => {},
  width: 430,
  dragging: false,
  separatorProps: {} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"],
};

describe("the chat panel's header strip", () => {
  it("is absent on Build — no pills, no new-thread, no history", () => {
    const { container } = render(
      <HomeChatPanel {...base} side="left" showThreadBar={false} showExpand={false} />,
    );
    expect(screen.queryByTestId("thread-strip")).toBeNull();
    expect(screen.queryByLabelText("Expand chat")).toBeNull();
    expect(container.querySelector(".border-b")).toBeNull();
  });

  it("is present by default, so Home and the Website tab keep it", () => {
    render(<HomeChatPanel {...base} />);
    expect(screen.getByTestId("thread-strip")).toBeTruthy();
    expect(screen.getByLabelText("Expand chat")).toBeTruthy();
  });

  it("names the product in its place on Build", () => {
    render(
      <HomeChatPanel
        {...base}
        side="left"
        showThreadBar={false}
        showExpand={false}
        title={<span>Hush</span>}
      />,
    );
    expect(screen.getByText("Hush")).toBeTruthy();
  });

  it("never stacks the title on top of the strip", () => {
    render(<HomeChatPanel {...base} title={<span>Hush</span>} />);
    expect(screen.queryByText("Hush")).toBeNull();
    expect(screen.getByTestId("thread-strip")).toBeTruthy();
  });

  const narrowBuild = {
    side: "left" as const,
    showThreadBar: false,
    showExpand: false,
    fullWidthBelowLg: true,
    narrowTrailing: (
      <button type="button" aria-label="Show the app">
        app
      </button>
    ),
  };

  it("keeps the one way back to the app when the title is there", () => {
    render(<HomeChatPanel {...base} {...narrowBuild} title={<span>Hush</span>} />);
    expect(screen.getByLabelText("Show the app")).toBeTruthy();
  });

  it("keeps it when nothing could name the app, so the app is still reachable", () => {
    render(<HomeChatPanel {...base} {...narrowBuild} title={null} />);
    expect(screen.getByLabelText("Show the app")).toBeTruthy();
  });

  it("keeps it when the panel has no nav button beside it either", () => {
    render(
      <HomeChatPanel
        {...base}
        {...narrowBuild}
        title={null}
        narrowLeading={undefined}
      />,
    );
    expect(screen.getByLabelText("Show the app")).toBeTruthy();
  });
});

describe("reporting the bound thread back to the tab that owns it", () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));

  function renderBound(onThreadChange: (id: string | null) => void) {
    render(
      <HomeChatPanel
        {...base}
        side="left"
        showThreadBar={false}
        showExpand={false}
        initialThreadId="thread-1"
        onThreadChange={onThreadChange}
      />,
    );
  }

  it("does not navigate from inside the commit React is still running", async () => {
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(String(args[0]));
      });
    renderBound(() =>
      commitTabsAndLocation(
        () => {},
        () => window.history.replaceState(null, "", "/workspace?tab=build"),
      ),
    );
    await settle();
    spy.mockRestore();
    window.history.replaceState(null, "", "/");
    expect(errors.join("\n")).not.toMatch(/flushSync/i);
  });

  it("still reports the thread, so the deferral did not drop the binding", async () => {
    const seen: (string | null)[] = [];
    renderBound((id) => seen.push(id));
    await settle();
    expect(seen).toEqual(["thread-1"]);
  });

  it("reports nothing while the panel is still resolving the latest thread", async () => {
    const seen: (string | null)[] = [];
    render(
      <HomeChatPanel
        {...base}
        side="left"
        showThreadBar={false}
        showExpand={false}
        onThreadChange={(id) => seen.push(id)}
      />,
    );
    await settle();
    expect(seen).toEqual([]);
  });
});
