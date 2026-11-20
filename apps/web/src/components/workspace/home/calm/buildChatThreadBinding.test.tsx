// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type * as React from "react";

const run = vi.hoisted(() => ({
  send: vi.fn(),
  feedback: vi.fn(async () => ({ ok: true })),
  tabSeeds: {} as Record<string, { text: string; nonce: number }>,
  tabThreadIds: [] as Array<[string, string | null]>,
  teamNote: null as null | Record<string, unknown>,
  stripProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("../../WorkspaceShell", () => {
  const noop = () => {};
  return {
    useWorkspace: () => ({
      userEmail: "founder@example.com",
      setTabDirty: noop,
      setTabThreadId: (tabId: string, threadId: string | null) => {
        run.tabThreadIds.push([tabId, threadId]);
      },
      role: "owner",
      composerSeeds: run.tabSeeds,
      consumeComposerSeed: (tabId: string) => {
        delete run.tabSeeds[tabId];
      },
      closeTab: noop,
      openTab: () => "t",
    }),
  };
});
vi.mock("@/lib/workspace/useAgentRun", () => ({
  useAgentRun: () => ({ inflight: false, error: null, send: run.send }),
}));
vi.mock("@/lib/workspace/tenantCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/tenantCommands")>()),
  useTenantCommands: () => ({ commands: [], loaded: true, error: null }),
}));
vi.mock("@/lib/workspace/useFeedback", () => ({ submitFeedback: run.feedback }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));
vi.mock("../../ThreadBar", () => ({ ThreadBar: () => null }));
vi.mock("../../ChatExpandButton", () => ({
  ChatExpandButton: () => null,
  HEADER_CARD_SHADOW: "",
}));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: () => ({
    rows: [],
    loading: false,
    errorMsg: null,
    reload: () => {},
    refetch: () => {},
    appendOptimisticUser: () => "opt-1",
    appendOptimisticSystem: () => {},
    removeOptimisticUser: () => {},
    markRunStopped: () => {},
    unmarkRunStopped: () => {},
    activeRunId: null,
    activeRunStartedAt: null,
    activeRunTurnStartedAt: null,
    activeTrigger: null,
    activityByRun: new Map(),
    activityRows: [],
    offeredTeamNote: run.teamNote,
  }),
}));
vi.mock("../../chat/TeamNoteStrip", () => ({
  TeamNoteStrip: (props: Record<string, unknown>) => {
    run.stripProps.push(props);
    return <div data-testid="team-note-strip-mock" />;
  },
}));
vi.mock("../../ChatThread", () => ({ ChatThread: () => <div /> }));

import { HomeChatPanel } from "./HomeChatPanel";
import { buildChatKey } from "../../WebsiteTab";

Element.prototype.scrollIntoView = () => {};

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD = "11111111-1111-4111-8111-111111111111";

const base = {
  greeting: "Good afternoon.",
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

function BuildSurface({ onBind }: { onBind: (id: string | null) => void }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  return (
    <HomeChatPanel
      key={buildChatKey(SESSION)}
      {...base}
      initialThreadId={threadId}
      onThreadChange={(id) => {
        onBind(id);
        setThreadId(id);
      }}
    />
  );
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function say(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.click(sendButton());
  await flush();
}

afterEach(() => {
  cleanup();
  run.send.mockReset();
  run.tabThreadIds.length = 0;
  run.teamNote = null;
  run.stripProps.length = 0;
});

describe("the chat beside a build keeps one thread across sends", () => {
  it("sends the second message into the thread the first one created", async () => {
    run.send.mockResolvedValue({ kind: "queued", thread_id: THREAD, user_message_id: "m1", run_id: "r1" });
    const onBind = vi.fn();
    render(<BuildSurface onBind={onBind} />);

    await say("make the hero headline shorter");
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(run.send.mock.calls[0]![2]).toBe(null);
    expect(onBind).toHaveBeenLastCalledWith(THREAD);

    await say("and make the button blue");
    expect(run.send).toHaveBeenCalledTimes(2);
    expect(run.send.mock.calls[1]![2]).toBe(THREAD);

    await say("now add a footer");
    expect(run.send).toHaveBeenCalledTimes(3);
    expect(run.send.mock.calls[2]![2]).toBe(THREAD);
    expect(onBind.mock.calls[0]).toEqual([null]);
    expect(onBind.mock.calls.slice(1).filter(([id]) => id === null)).toHaveLength(0);
  });
});

describe("Report to Zavi team strip on the home chat", () => {
  it("sits above the composer, fed by the chat's offered note, bound to the panel's thread", () => {
    const note = { messageId: "m1", offerId: "o1", note: "It failed.", offerStop: false, state: "shown" };
    run.teamNote = note;
    render(<HomeChatPanel {...base} initialThreadId={THREAD} onThreadChange={() => {}} />);
    const strip = screen.getByTestId("team-note-strip-mock");
    expect(strip.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const last = run.stripProps[run.stripProps.length - 1]!;
    expect(last).toMatchObject({ teamNote: note, threadId: THREAD, replying: false });
  });
});
