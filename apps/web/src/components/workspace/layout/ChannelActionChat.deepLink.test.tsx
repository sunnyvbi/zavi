// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = {
  id: string;
  title: string | null;
  preview: string | null;
  last_message_at: string | null;
  channel_action_id: string | null;
  card_title: string | null;
};

const h = vi.hoisted(() => ({
  listCalls: [] as Array<[string, string | null | undefined]>,
  nextList: [] as Array<() => Promise<unknown>>,
  store: [] as unknown[],
  chatArgs: [] as unknown[][],
  messagesByThread: {} as Record<string, string[]>,
  activeRunId: null as string | null,
  composer: null as null | Record<string, unknown>,
  apiFetch: vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true, json: async () => ({}) })),
}));

vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));
vi.mock("next/navigation", () => ({ usePathname: () => "/workspace" }));
vi.mock("@/lib/workspace/channelThreadsApi", () => ({
  listChannelThreads: (channel: string, action?: string | null) => {
    h.listCalls.push([channel, action]);
    const next = h.nextList.shift();
    return next ? next() : Promise.resolve(h.store);
  },
}));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: (...args: unknown[]) => {
    h.chatArgs.push(args);
    const id = args[1] as string | null | undefined;
    const rows = (id ? h.messagesByThread[id] ?? [] : []).map((text, i) => ({
      id: `${id}-${i}`,
      kind: "chat_user",
      body: { text },
    }));
    return {
      rows,
      activityRows: [],
      loading: false,
      errorMsg: null,
      activeRunId: h.activeRunId,
      activeTrigger: h.activeRunId ? "chat" : null,
      activeRunStartedAt: null,
      activeRunTurnStartedAt: null,
      offeredTeamNote: null,
      refetch: () => {},
      markRunStopped: () => {},
      unmarkRunStopped: () => {},
      appendOptimisticUser: () => undefined,
      appendOptimisticSystem: () => {},
    };
  },
}));
vi.mock("../ChatThread", () => ({
  ChatThread: ({ state }: { state: { rows: Array<{ body: { text: string } }>; loading: boolean; pendingRunId?: string | null } }) => (
    <div data-testid="chat-thread" data-loading={state.loading ? "yes" : "no"} data-pending={state.pendingRunId ?? ""}>
      {state.rows.map((r, i) => (
        <p key={i}>{r.body.text}</p>
      ))}
    </div>
  ),
}));
vi.mock("../InlineStatusRow", () => ({ InlineStatusRow: () => null }));
vi.mock("../LowCreditsWarning", () => ({ LowCreditsWarning: () => null }));
vi.mock("../useAgentThreads", () => ({ notifyThreadsChanged: () => {} }));
vi.mock("../chat/TeamNoteStrip", () => ({ TeamNoteStrip: () => null }));
vi.mock("@/components/ZaviMascot", () => ({ ZaviMascot: () => null }));
vi.mock("../Composer", () => ({
  Composer: (props: Record<string, unknown>) => {
    h.composer = props;
    const bind = props.onThreadBound as (id: string | null) => void;
    const before = props.onBeforeSend as undefined | ((m: string) => Promise<unknown>);
    return (
      <div>
        <textarea aria-label="Message" defaultValue={(props.seed as { text?: string } | undefined)?.text ?? ""} />
        <button type="button" onClick={() => bind("T-new")}>
          stub-bind
        </button>
        <button type="button" onClick={() => void before?.("Use last month's numbers")}>
          stub-redo-note
        </button>
      </div>
    );
  },
}));

import { ChannelActionChat } from "./ChannelActionChat";
import type { ChannelChatPin } from "../actions/channelChat";

const CARD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const row = (over: Partial<Row>): Row => ({
  id: "T1",
  title: "Are my ChatGPT ads working?",
  preview: "Yes, CTR is up",
  last_message_at: new Date().toISOString(),
  channel_action_id: null,
  card_title: null,
  ...over,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const channelPin: ChannelChatPin = { target: "channel" };
const askPin = (id: string, title: string): ChannelChatPin =>
  ({ target: "action", mode: "ask", action: { id, title }, onRedo: vi.fn(async () => true) }) as unknown as ChannelChatPin;

const byAction = (rows: Row[]) => (_: string, action?: string | null) =>
  Promise.resolve(action ? rows.filter((r) => r.channel_action_id === action) : rows);

function tree(linked: string | null, pin: ChannelChatPin = channelPin) {
  return (
    <ChannelActionChat
      pin={pin}
      linkedActionId={linked}
      channelSlug="chatgpt_ads"
      channelName="ChatGPT Ads"
      open
      onClose={() => {}}
    />
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

async function mount(linked: string | null, pin: ChannelChatPin = channelPin) {
  let r!: ReturnType<typeof render>;
  await act(async () => {
    r = render(tree(linked, pin));
  });
  await flush();
  return r;
}

const threadArgs = () => h.chatArgs.map((a) => a[1]);
const lastThreadArg = () => h.chatArgs[h.chatArgs.length - 1]?.[1];

beforeEach(() => {
  h.listCalls = [];
  h.nextList = [];
  h.store = [];
  h.chatArgs = [];
  h.messagesByThread = {};
  h.activeRunId = null;
  h.composer = null;
  h.apiFetch.mockClear();
  window.localStorage.clear();
});
afterEach(cleanup);

const TB = row({ id: "T-B", channel_action_id: CARD_B, card_title: "Card B" });
const TA = row({ id: "T-A", channel_action_id: CARD_A, card_title: "Card A" });

describe("a card opened by deep link", () => {
  it("never binds the latest thread when it is pinned to another card, and starts a fresh thread pinned to the linked card", async () => {
    h.store = [TB];
    h.nextList = [() => Promise.resolve([TB])];
    await mount(CARD_A);
    expect(h.listCalls).toEqual([["chatgpt_ads", CARD_A]]);
    expect(threadArgs()).not.toContain("T-B");
    expect(lastThreadArg()).toBeNull();
    expect(h.composer?.channelActionId).toBe(CARD_A);
  });

  it("resumes the linked card's own thread even when another card's thread is newer", async () => {
    const rows = [TB, TA];
    h.nextList = [() => byAction(rows)("chatgpt_ads", CARD_A)];
    await mount(CARD_A);
    expect(threadArgs()).not.toContain("T-B");
    expect(lastThreadArg()).toBe("T-A");
    expect(h.composer?.channelActionId).toBe(CARD_A);
  });

  it("refuses a thread for another card even if the server hands one back for the linked lookup", async () => {
    h.nextList = [() => Promise.resolve([TB, TA])];
    await mount(CARD_A);
    expect(threadArgs()).not.toContain("T-B");
    expect(lastThreadArg()).toBe("T-A");
  });

  it("keeps today's behaviour with no deep link and no pin: latest thread, unscoped lookup", async () => {
    h.store = [TB, TA];
    await mount(null);
    expect(h.listCalls).toEqual([["chatgpt_ads", null]]);
    expect(lastThreadArg()).toBe("T-B");
    expect(h.composer?.channelActionId).toBe(CARD_B);
  });

  it("race: the link arrives after the unscoped list loaded and bound B; the chat moves off B to A's thread", async () => {
    const rows = [TB, TA];
    h.nextList = [() => Promise.resolve([TB, TA]), () => byAction(rows)("chatgpt_ads", CARD_A)];
    const r = await mount(null);
    expect(lastThreadArg()).toBe("T-B");
    await act(async () => {
      r.rerender(tree(CARD_A));
    });
    await flush();
    expect(h.listCalls).toEqual([
      ["chatgpt_ads", null],
      ["chatgpt_ads", CARD_A],
    ]);
    expect(lastThreadArg()).toBe("T-A");
    expect(h.composer?.channelActionId).toBe(CARD_A);
  });

  it("race: the link arrives after B loaded and A has no thread; the chat falls to a fresh thread pinned to A, not B", async () => {
    h.nextList = [() => Promise.resolve([TB]), () => Promise.resolve([])];
    const r = await mount(null);
    expect(lastThreadArg()).toBe("T-B");
    await act(async () => {
      r.rerender(tree(CARD_A));
    });
    await flush();
    expect(lastThreadArg()).toBeNull();
    expect(h.composer?.channelActionId).toBe(CARD_A);
  });

  it("race: a slow unscoped lookup answering after the link must not bind B", async () => {
    const slow = deferred<unknown>();
    h.nextList = [() => slow.promise, () => Promise.resolve([TA])];
    const r = await mount(null);
    await act(async () => {
      r.rerender(tree(CARD_A));
    });
    await flush();
    await act(async () => {
      slow.resolve([TB]);
    });
    await flush();
    expect(threadArgs()).not.toContain("T-B");
    expect(lastThreadArg()).toBe("T-A");
  });

  it("race: once the founder has acted, a late link does not pull them off their chat", async () => {
    h.nextList = [() => Promise.resolve([TB]), () => Promise.resolve([TA])];
    const r = await mount(null);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stub-bind" }));
    });
    expect(lastThreadArg()).toBe("T-new");
    await act(async () => {
      r.rerender(tree(CARD_A));
    });
    await flush();
    expect(lastThreadArg()).toBe("T-new");
    expect(h.listCalls).toEqual([["chatgpt_ads", null]]);
  });

  it("Ask Zavi on another card after a deep link still pins to that card and ignores the link", async () => {
    h.nextList = [() => Promise.resolve([TB])];
    const asked = await mount(CARD_A, askPin(CARD_B, "Card B"));
    expect(h.listCalls).toEqual([["chatgpt_ads", CARD_B]]);
    expect(threadArgs()).not.toContain("T-A");
    expect(lastThreadArg()).toBe("T-B");
    expect(h.composer?.channelActionId).toBe(CARD_B);
    asked.unmount();
  });
});
