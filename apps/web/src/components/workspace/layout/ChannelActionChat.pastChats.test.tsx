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
        {}
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

const CARD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARD_Y = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
function cardPin(mode: "ask" | "redo", onRedo = vi.fn(async () => true)): ChannelChatPin {
  return {
    target: "action",
    mode,
    action: { id: CARD, title: "Raise budget on Search" },
    onRedo,
  } as unknown as ChannelChatPin;
}

async function mount(pin: ChannelChatPin = channelPin) {
  let r!: ReturnType<typeof render>;
  await act(async () => {
    r = render(
      <ChannelActionChat
        pin={pin}
        channelSlug="chatgpt_ads"
        channelName="ChatGPT Ads"
        open
        onClose={() => {}}
      />,
    );
  });
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  return r;
}

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

describe("reopening the page's chat", () => {
  it("talks to the channel's own agent, not the operator, with no channels[] tag", async () => {
    await mount();
    expect(h.chatArgs[h.chatArgs.length - 1]?.[0]).toBe("chatgpt_ads");
    expect(h.composer?.agentSlug).toBe("chatgpt_ads");
    expect(h.composer?.stickyChannels).toBeUndefined();
    expect(h.composer?.pageChannel).toBe("chatgpt_ads");
  });

  it('"I went back to ChatGPT Ads and my message is gone": after a send, a remount loads the same thread with the message', async () => {
    const first = await mount();
    expect(h.listCalls).toEqual([["chatgpt_ads", null]]);
    expect(lastThreadArg()).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stub-bind" }));
    });
    expect(lastThreadArg()).toBe("T-new");
    first.unmount();

    h.store = [row({ id: "T-new" })];
    h.messagesByThread["T-new"] = ["How are my ChatGPT ads doing?"];
    await mount();
    expect(lastThreadArg()).toBe("T-new");
    expect(screen.getByText("How are my ChatGPT ads doing?")).toBeTruthy();
  });

  it("no page chats: empty state with the channel chips, and no flash of chips while the lookup is pending", async () => {
    const d = deferred<unknown>();
    h.nextList.push(() => d.promise);
    await mount();
    expect(screen.getByTestId("chat-thread").getAttribute("data-loading")).toBe("yes");
    expect(h.composer!.starterChips).toEqual([]);
    await act(async () => {
      d.resolve([]);
    });
    expect(screen.getByTestId("chat-thread").getAttribute("data-loading")).toBe("no");
    expect((h.composer!.starterChips as string[]).length).toBeGreaterThan(0);
    expect(lastThreadArg()).toBeNull();
  });

  it("race: a send that binds a thread while the lookup is pending wins over the lookup's older chat", async () => {
    const d = deferred<unknown>();
    h.nextList.push(() => d.promise);
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stub-bind" }));
    });
    expect(lastThreadArg()).toBe("T-new");
    await act(async () => {
      d.resolve([row({ id: "T-old" })]);
    });
    expect(lastThreadArg()).toBe("T-new");
    expect(h.composer!.threadId).toBe("T-new");
  });

  it("a failed lookup starts fresh (the popover shows its own error)", async () => {
    h.nextList.push(() => Promise.reject(new Error("offline")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mount();
    expect(lastThreadArg()).toBeNull();
    expect(screen.getByTestId("chat-thread").getAttribute("data-loading")).toBe("no");
    warn.mockRestore();
  });

  it("the Composer is told the page on every turn", async () => {
    await mount();
    expect(h.composer!.pageChannel).toBe("chatgpt_ads");
  });

  it("a channel chat that was about a card carries that card and shows it in the bar", async () => {
    h.store = [row({ id: "T-card", channel_action_id: CARD_Y, card_title: "Pause Brand Exact" })];
    await mount();
    expect(lastThreadArg()).toBe("T-card");
    expect(h.composer!.channelActionId).toBe(CARD_Y);
    expect(screen.getByText("Pause Brand Exact")).toBeTruthy();
  });
});

describe("Ask about this (a card)", () => {
  it("reopens the card's latest chat, with no 'About this action' prefill", async () => {
    h.store = [row({ id: "T-card", channel_action_id: CARD, card_title: "Raise budget on Search" })];
    await mount(cardPin("ask"));
    expect(h.listCalls).toEqual([["chatgpt_ads", CARD]]);
    expect(lastThreadArg()).toBe("T-card");
    expect(h.composer!.seed).toBeUndefined();
    expect(h.composer!.channelActionId).toBe(CARD);
    expect(screen.getByText("On this action")).toBeTruthy();
  });

  it("no chat for the card yet: a fresh chat with the prefill, only once the lookup proves it", async () => {
    const d = deferred<unknown>();
    h.nextList.push(() => d.promise);
    await mount(cardPin("ask"));
    expect(h.composer!.seed).toBeUndefined();
    await act(async () => {
      d.resolve([]);
    });
    expect((h.composer!.seed as { text: string }).text).toMatch(/^About this action on ChatGPT Ads/);
    expect(lastThreadArg()).toBeNull();
    expect(h.composer!.channelActionId).toBe(CARD);
  });

  it("Redo does not look anything up and hides Past chats / New chat until the note is sent", async () => {
    await mount(cardPin("redo"));
    expect(h.listCalls).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Past chats" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stub-redo-note" }));
    });
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Past chats" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
  });
});

describe("the Past chats popover", () => {
  async function openPast() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
    });
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  }

  it('"Show my channel chat list so I can click on history": lists the page chats, marks the open one, opens a clicked one', async () => {
    h.store = [
      row({ id: "T1", title: "Are my ChatGPT ads working?", preview: "Yes, CTR is up" }),
      row({ id: "T2", title: "Budget question", preview: "Spend is on pace", channel_action_id: CARD_Y, card_title: "Pause Brand Exact" }),
    ];
    await mount();
    expect(lastThreadArg()).toBe("T1");
    await openPast();
    const dialog = screen.getByRole("dialog", { name: "Past chats on ChatGPT Ads" });
    expect(dialog.textContent).toContain("Are my ChatGPT ads working?");
    expect(dialog.textContent).toContain("Yes, CTR is up");
    expect(dialog.textContent).toContain("Budget question");
    expect(dialog.textContent).toContain("Pause Brand Exact");
    const current = dialog.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain("Are my ChatGPT ads working?");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Budget question/ }));
    });
    expect(lastThreadArg()).toBe("T2");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.composer!.channelActionId).toBe(CARD_Y);
    expect(screen.getByText("Pause Brand Exact")).toBeTruthy();
  });

  it("from a card column, opening a plain channel chat carries no card and drops the card bar", async () => {
    h.store = [];
    await mount(cardPin("ask"));
    expect(h.composer!.channelActionId).toBe(CARD);
    h.store = [row({ id: "T-plain", title: "General question" })];
    await openPast();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /General question/ }));
    });
    expect(lastThreadArg()).toBe("T-plain");
    expect(h.composer!.channelActionId).toBeUndefined();
    expect(screen.queryByText("Raise budget on Search")).toBeNull();
    expect(screen.queryByText("On this action")).toBeNull();
  });

  it('an empty list says "No earlier chats on ChatGPT Ads yet."', async () => {
    await mount();
    await openPast();
    expect(screen.getByText("No earlier chats on ChatGPT Ads yet.")).toBeTruthy();
  });

  it("New chat clears to a fresh chat; the previous one is still listed", async () => {
    h.store = [row({ id: "T1", title: "Earlier chat" })];
    await mount();
    expect(lastThreadArg()).toBe("T1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    });
    expect(lastThreadArg()).toBeNull();
    expect((screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(true);
    await openPast();
    expect(screen.getByRole("dialog").textContent).toContain("Earlier chat");
  });

  it("a reply still running in the chat you leave does not follow you to New chat", async () => {
    h.store = [row({ id: "T1", title: "Earlier chat" })];
    await mount();
    expect(lastThreadArg()).toBe("T1");
    await act(async () => {
      (h.composer!.onSent as (runId: string) => void)("run-9");
    });
    expect(screen.getByTestId("chat-thread").getAttribute("data-pending")).toBe("run-9");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    });
    expect(lastThreadArg()).toBeNull();
    expect(screen.getByTestId("chat-thread").getAttribute("data-pending")).toBe("");
  });

  it("New chat in a card column starts a plain channel chat: no card, no card bar", async () => {
    h.store = [row({ id: "T-card", title: "About the card", channel_action_id: CARD, card_title: "Raise budget on Search" })];
    await mount(cardPin("ask"));
    expect(lastThreadArg()).toBe("T-card");
    expect(h.composer!.channelActionId).toBe(CARD);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    });
    expect(lastThreadArg()).toBeNull();
    expect(h.composer!.channelActionId).toBeUndefined();
    expect(screen.queryByText("Raise budget on Search")).toBeNull();
    expect(screen.queryByText("On this action")).toBeNull();
  });

  it("Escape with the popover open closes it and does NOT stop the running reply", async () => {
    h.activeRunId = "run-1";
    h.store = [row({ id: "T1" })];
    await mount();
    await openPast();
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.apiFetch.mock.calls.filter((c) => String(c[0]).includes("/cancel"))).toHaveLength(0);

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(h.apiFetch.mock.calls.filter((c) => String(c[0]).includes("/cancel"))).toHaveLength(1);
  });
});
