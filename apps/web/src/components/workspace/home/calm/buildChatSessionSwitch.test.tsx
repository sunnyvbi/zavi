// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";

import type * as React from "react";

const spy = vi.hoisted(() => ({
  threads: [] as Array<string | null | undefined>,
  mounts: 0,
}));

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
  useChatThread: (_slug: string, threadId: string | null | undefined) => {
    spy.threads.push(threadId);
    return { rows: [], loading: false, errorMsg: null, reload: () => {} };
  },
}));
vi.mock("../../ChatThread", () => ({ ChatThread: () => <div /> }));

import { HomeChatPanel } from "./HomeChatPanel";
import { buildChatKey } from "../../WebsiteTab";
import { buildThreadOnOpen } from "@/lib/workspace/buildEntry";

vi.mock("../../Composer", () => ({
  Composer: () => {
    useEffect(() => {
      spy.mounts += 1;
    }, []);
    return <textarea />;
  },
}));

afterEach(() => {
  cleanup();
  spy.threads.length = 0;
  spy.mounts = 0;
});

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THREAD_A = "11111111-1111-4111-8111-111111111111";

const base = {
  greeting: "Good afternoon, Ravi.",
  pulse: <span>pulse</span>,
  suggestions: [] as string[],
  expanded: false,
  onExpandedChange: () => {},
  width: 430,
  dragging: false,
  side: "left" as const,
  surface: "card" as const,
  showThreadBar: false,
  showExpand: false,
  separatorProps: {} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"],
};

type BuildPayload = { sessionId: string | null; threadId?: string | null };

function BuildSurface({ payload }: { payload: BuildPayload }) {
  return (
    <HomeChatPanel
      key={buildChatKey(payload.sessionId)}
      {...base}
      initialThreadId={payload.threadId ?? null}
      onThreadChange={() => {}}
    />
  );
}

const lastThread = () => spy.threads[spy.threads.length - 1];

describe("the chat beside a build follows the build", () => {
  it("starts the new build on its own thread, not the one before it", () => {
    const { rerender } = render(
      <BuildSurface payload={{ sessionId: SESSION_A, threadId: THREAD_A }} />,
    );
    expect(lastThread()).toBe(THREAD_A);

    rerender(<BuildSurface payload={{ sessionId: SESSION_B }} />);

    expect(lastThread()).not.toBe(THREAD_A);
    expect(lastThread()).toBe(null);
    expect(spy.mounts).toBe(2);
  });

  it("does not remount when the same build binds a thread", () => {
    const { rerender } = render(<BuildSurface payload={{ sessionId: SESSION_A }} />);
    expect(spy.mounts).toBe(1);

    rerender(<BuildSurface payload={{ sessionId: SESSION_A, threadId: THREAD_A }} />);

    expect(lastThread()).toBe(THREAD_A);
    expect(spy.mounts).toBe(1);
  });

  it("hands the new build a blank chat, never the resolve-latest sentinel", () => {
    const openedWith = buildThreadOnOpen(SESSION_A, SESSION_B, THREAD_A);
    expect(openedWith).toBe(null);

    const { rerender } = render(
      <BuildSurface payload={{ sessionId: SESSION_A, threadId: THREAD_A }} />,
    );
    rerender(<BuildSurface payload={{ sessionId: SESSION_B, threadId: openedWith }} />);

    expect(lastThread()).toBe(null);
    expect(lastThread()).not.toBeUndefined();
  });

  it("opens a first-ever Build tab on a blank chat, never the latest Grow thread", () => {
    const openedWith = buildThreadOnOpen(undefined, SESSION_A, undefined);
    render(<BuildSurface payload={{ sessionId: SESSION_A, threadId: openedWith }} />);

    expect(spy.threads.length).toBeGreaterThan(0);
    expect(spy.threads.every((t) => t === null)).toBe(true);
  });

  it("gives an unstarted build its own key, distinct from every session", () => {
    expect(buildChatKey(null)).not.toBe(buildChatKey(SESSION_A));
    expect(buildChatKey(SESSION_A)).not.toBe(buildChatKey(SESSION_B));
    expect(buildChatKey(SESSION_A)).toBe(buildChatKey(SESSION_A));
  });
});
