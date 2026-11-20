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
  location: "/workspace?tab=channels&channel=email_marketing",
  compact: false,
  replaced: [] as string[],
  listCalls: [] as Array<[string, string | null | undefined]>,
  nextList: [] as Array<() => Promise<unknown>>,
  store: [] as Array<{ id: string; channel_action_id: string | null }>,
  chatArgs: [] as unknown[][],
  messagesByThread: {} as Record<string, string[]>,
  composer: null as null | Record<string, unknown>,
  sends: [] as Array<{ threadId: unknown; channelActionId: unknown }>,
  apiFetch: vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true, json: async () => ({}) })),
}));

vi.mock("@/lib/responsive", () => ({
  useIsCompact: () => h.compact,
  useMediaMatch: () => false,
}));
vi.mock("../navigation/useWorkspaceLocation", () => ({
  useWorkspaceLocation: () => h.location,
}));
vi.mock("../navigation/workspaceRoutes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../navigation/workspaceRoutes")>()),
  readWorkspaceLocation: () => h.location,
  replaceWorkspaceLocation: (href: string) => {
    h.replaced.push(href);
    h.location = href;
  },
  pushWorkspaceLocation: () => {},
}));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));
vi.mock("next/navigation", () => ({ usePathname: () => "/workspace" }));
vi.mock("@/lib/workspace/channelThreadsApi", () => ({
  listChannelThreads: (channel: string, action?: string | null) => {
    h.listCalls.push([channel, action]);
    const next = h.nextList.shift();
    if (next) return next();
    return Promise.resolve(action ? h.store.filter((r) => r.channel_action_id === action) : h.store);
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
      activeRunId: null,
      activeTrigger: null,
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
  ChatThread: ({ state }: { state: { rows: Array<{ body: { text: string } }> } }) => (
    <div data-testid="chat-thread">
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
    return (
      <div>
        <p data-testid="seed">{(props.seed as { text?: string } | undefined)?.text ?? ""}</p>
        <button
          type="button"
          onClick={() => {
            const threadId = props.threadId ?? null;
            h.sends.push({ threadId, channelActionId: props.channelActionId });
            const bound = (threadId as string | null) ?? `T-sent-${h.sends.length}`;
            h.messagesByThread[bound] = [...(h.messagesByThread[bound] ?? []), "founder message"];
            bind(bound);
          }}
        >
          stub-send
        </button>
      </div>
    );
  },
}));

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";
import { useChannelChatOpener } from "../actions/channelChat";

const CARD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SLUG = "email_marketing";

const row = (over: Partial<Row>): Row => ({
  id: "T1",
  title: "Chat",
  preview: null,
  last_message_at: new Date().toISOString(),
  channel_action_id: null,
  card_title: null,
  ...over,
});
const TA = row({ id: "T-A", title: "Subject line for A", channel_action_id: CARD_A, card_title: "Spring sale email" });
const TB = row({ id: "T-B", title: "Older chat on B", channel_action_id: CARD_B, card_title: "Win-back email" });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const entry = (slug: string, name: string): ChannelEntry =>
  ({ channel: { slug, name, connectors: [] }, count: 0, waiting: 0, subtitle: null, lock: null }) as unknown as ChannelEntry;

function Detail() {
  const openChat = useChannelChatOpener();
  const ask = (id: string, title: string) =>
    openChat?.({ target: "action", mode: "ask", action: { id, title }, onRedo: async () => true } as never);
  return (
    <>
      <button type="button" onClick={() => ask(CARD_A, "Spring sale email")}>
        card-a-ask
      </button>
      <button type="button" onClick={() => ask(CARD_B, "Win-back email")}>
        card-b-ask
      </button>
      <button type="button" onClick={() => openChat?.({ target: "channel" })}>
        open-channel-chat
      </button>
    </>
  );
}

const page = () => (
  <ChannelsPage
    entries={[entry(SLUG, "Email campaigns")]}
    loading={false}
    onShow={() => {}}
    onUpgrade={() => {}}
    renderDetail={() => <Detail />}
  />
);

async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
  await flush();
}
async function mountPage() {
  let r!: ReturnType<typeof render>;
  await act(async () => {
    r = render(page());
  });
  await flush();
  return r;
}

const lastThreadArg = () => h.chatArgs[h.chatArgs.length - 1]?.[1];
const lastSend = () => h.sends[h.sends.length - 1];
const seedText = () => screen.getByTestId("seed").textContent ?? "";

async function onAThreadInsideBColumn() {
  h.nextList = [() => Promise.resolve([])];
  await mountPage();
  await click("card-b-ask");
  expect(lastThreadArg()).toBeNull();
  expect(h.composer?.channelActionId).toBe(CARD_B);
  h.store = [TA];
  h.messagesByThread["T-A"] = ["Make the subject shorter", "Done: 'Spring sale ends Sunday'"];
  await click("Past chats");
  await click(/Subject line for A/);
  expect(lastThreadArg()).toBe("T-A");
  expect(screen.getByText("Spring sale email")).toBeTruthy();
  await click("stub-send");
  expect(lastSend()).toEqual({ threadId: "T-A", channelActionId: CARD_A });
  expect(screen.getByText("Make the subject shorter")).toBeTruthy();
}

beforeEach(() => {
  window.localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  h.location = `/workspace?tab=channels&channel=${SLUG}`;
  h.compact = false;
  h.replaced = [];
  h.listCalls = [];
  h.nextList = [];
  h.store = [];
  h.chatArgs = [];
  h.messagesByThread = {};
  h.composer = null;
  h.sends = [];
  h.apiFetch.mockClear();
});
afterEach(cleanup);

describe("Ask Zavi on an Overview card always lands on that card", () => {
  it("from card A's thread with sent messages, Ask Zavi on B opens a fresh chat pinned to B with B's prefill, and the send carries B", async () => {
    await onAThreadInsideBColumn();
    h.store = [TA];
    const before = h.listCalls.length;
    await click("card-b-ask");
    expect(h.listCalls.slice(before)).toEqual([[SLUG, CARD_B]]);
    expect(lastThreadArg()).toBeNull();
    expect(h.composer?.channelActionId).toBe(CARD_B);
    expect(seedText()).toContain('"Win-back email"');
    expect(screen.queryByText("Spring sale email")).toBeNull();
    expect(screen.getByText("Win-back email")).toBeTruthy();
    expect(screen.getByText("On this action")).toBeTruthy();
    expect(screen.queryByText("Make the subject shorter")).toBeNull();
    await click("stub-send");
    expect(lastSend()).toEqual({ threadId: null, channelActionId: CARD_B });
  });

  it("from card A's thread, Ask Zavi on B reopens B's own thread when it has one", async () => {
    await onAThreadInsideBColumn();
    h.store = [TA, TB];
    await click("card-b-ask");
    expect(lastThreadArg()).toBe("T-B");
    expect(h.composer?.channelActionId).toBe(CARD_B);
    expect(seedText()).toBe("");
    await click("stub-send");
    expect(lastSend()).toEqual({ threadId: "T-B", channelActionId: CARD_B });
  });

  it("after New chat in B's column, Ask Zavi on B pins the column back to B", async () => {
    h.store = [TB];
    await mountPage();
    await click("card-b-ask");
    expect(lastThreadArg()).toBe("T-B");
    await click("New chat");
    expect(h.composer?.channelActionId).toBeUndefined();
    await click("stub-send");
    expect(lastSend()).toEqual({ threadId: null, channelActionId: undefined });
    await click("card-b-ask");
    expect(lastThreadArg()).toBe("T-B");
    expect(h.composer?.channelActionId).toBe(CARD_B);
    await click("stub-send");
    expect(lastSend()).toEqual({ threadId: "T-B", channelActionId: CARD_B });
  });

  it("pressing Ask Zavi on B again while already on B's thread does not reload or move the chat", async () => {
    h.store = [TB];
    await mountPage();
    await click("card-b-ask");
    expect(lastThreadArg()).toBe("T-B");
    const before = h.listCalls.length;
    await click("card-b-ask");
    expect(h.listCalls.length).toBe(before);
    expect(lastThreadArg()).toBe("T-B");
  });

  it("from A's column with A's thread and a send, Ask Zavi on B moves to B", async () => {
    h.store = [TA];
    h.messagesByThread["T-A"] = ["old"];
    await mountPage();
    await click("card-a-ask");
    expect(lastThreadArg()).toBe("T-A");
    await click("stub-send");
    await click("card-b-ask");
    expect(lastThreadArg()).toBeNull();
    expect(h.composer?.channelActionId).toBe(CARD_B);
    await click("stub-send");
    expect(lastSend()).toEqual({ threadId: null, channelActionId: CARD_B });
  });

  it("race: a late answer from B's first lookup cannot pull the column off B's re-anchored thread", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    h.nextList = [() => first.promise];
    await mountPage();
    await click("card-b-ask");
    h.store = [TA];
    h.messagesByThread["T-A"] = ["Make the subject shorter"];
    await click("Past chats");
    await click(/Subject line for A/);
    await click("stub-send");
    expect(lastSend()).toEqual({ threadId: "T-A", channelActionId: CARD_A });
    h.nextList = [() => second.promise];
    await click("card-b-ask");
    await act(async () => {
      second.resolve([TB]);
    });
    await flush();
    expect(lastThreadArg()).toBe("T-B");
    await act(async () => {
      first.resolve([]);
    });
    await flush();
    expect(lastThreadArg()).toBe("T-B");
    expect(h.composer?.channelActionId).toBe(CARD_B);
    expect(seedText()).toBe("");
    await click("stub-send");
    expect(lastSend()).toEqual({ threadId: "T-B", channelActionId: CARD_B });
  });

  it("race: the re-anchor lookup answers after the stale one and still wins", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    h.nextList = [() => first.promise];
    await mountPage();
    await click("card-b-ask");
    h.store = [TA];
    await click("Past chats");
    await click(/Subject line for A/);
    await click("stub-send");
    h.nextList = [() => second.promise];
    await click("card-b-ask");
    await act(async () => {
      first.resolve([TA]);
    });
    await flush();
    expect(lastThreadArg()).not.toBe("T-A");
    await act(async () => {
      second.resolve([]);
    });
    await flush();
    expect(lastThreadArg()).toBeNull();
    expect(h.composer?.channelActionId).toBe(CARD_B);
    expect(seedText()).toContain('"Win-back email"');
  });

  it("plain channel chat with Past chats and New chat is unchanged", async () => {
    h.store = [row({ id: "T-plain", title: "General question" }), TA];
    await mountPage();
    await click("open-channel-chat");
    expect(lastThreadArg()).toBe("T-plain");
    expect(h.composer?.channelActionId).toBeUndefined();
    await click("Past chats");
    await click(/Subject line for A/);
    expect(h.composer?.channelActionId).toBe(CARD_A);
    const before = h.listCalls.length;
    await click("open-channel-chat");
    expect(h.listCalls.length).toBe(before);
    expect(lastThreadArg()).toBe("T-A");
    await click("New chat");
    expect(lastThreadArg()).toBeNull();
    expect(h.composer?.channelActionId).toBeUndefined();
  });
});

describe("the ?action= deep link", () => {
  it("an uppercase card id in the link still reopens that card's thread", async () => {
    h.location = `/workspace?tab=channels&channel=${SLUG}&action=${CARD_A.toUpperCase()}`;
    h.store = [TA];
    await mountPage();
    await click("open-channel-chat");
    expect(h.listCalls).toEqual([[SLUG, CARD_A]]);
    expect(lastThreadArg()).toBe("T-A");
    await click("stub-send");
    expect(lastSend()).toEqual({ threadId: "T-A", channelActionId: CARD_A });
  });

  it("after New chat and a send, a remount of the column does not jump back to the linked card", async () => {
    h.location = `/workspace?tab=channels&channel=${SLUG}&action=${CARD_A}`;
    h.store = [TA];
    const r = await mountPage();
    await click("open-channel-chat");
    expect(lastThreadArg()).toBe("T-A");
    await click("New chat");
    await click("stub-send");
    const sent = h.chatArgs[h.chatArgs.length - 1]?.[1] as string;
    expect(sent).toMatch(/^T-sent-/);
    expect(h.location).not.toContain("action=");
    h.store = [row({ id: sent, title: "New plain chat" }), TA];
    h.compact = true;
    await act(async () => {
      r.rerender(page());
    });
    await flush();
    expect(lastThreadArg()).toBe(sent);
    expect(h.composer?.channelActionId).toBeUndefined();
  });

  it("Ask Zavi on another card drops the link, so a later channel column does not reopen the linked card", async () => {
    h.location = `/workspace?tab=channels&channel=${SLUG}&action=${CARD_A}`;
    h.store = [row({ id: "T-plain", title: "General question" }), TA];
    await mountPage();
    await click("card-b-ask");
    expect(h.composer?.channelActionId).toBe(CARD_B);
    expect(h.location).not.toContain("action=");
  });
});
