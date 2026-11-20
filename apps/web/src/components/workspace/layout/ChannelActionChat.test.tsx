
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiFetch = vi.hoisted(() => vi.fn());
const sendResults = vi.hoisted(() => [] as Array<{ handled: boolean; system?: string }>);
const systemRows = vi.hoisted(() => vi.fn());
const optimisticUsers = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const useChatThreadSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: (...args: unknown[]) => {
    useChatThreadSpy(...args);
    return {
      rows: [],
      activityRows: [],
      loading: false,
      errorMsg: null,
      activeRunId: null,
      activeTrigger: null,
      activeRunStartedAt: null,
      activeRunTurnStartedAt: null,
      refetch: () => {},
      markRunStopped: () => {},
      unmarkRunStopped: () => {},
      appendOptimisticUser: optimisticUsers,
      appendOptimisticSystem: systemRows,
    };
  },
}));
vi.mock("../ChatThread", () => ({ ChatThread: () => <div data-testid="chat-thread" /> }));
vi.mock("../InlineStatusRow", () => ({ InlineStatusRow: () => null }));
vi.mock("../LowCreditsWarning", () => ({ LowCreditsWarning: () => null }));
vi.mock("../AgentAvatar", () => ({ AgentAvatar: () => <span /> }));
vi.mock("../useAgentThreads", () => ({ notifyThreadsChanged: () => {} }));
vi.mock("../Composer", () => ({
  Composer: ({
    seed,
    onBeforeSend,
    onOptimistic,
  }: {
    seed?: { text: string };
    onBeforeSend?: (m: string) => Promise<{ handled: boolean; system?: string }>;
    onOptimistic?: (
      text: string,
      attachments?: { path: string; kind?: "image" | "doc" }[],
    ) => string | undefined;
  }) => (
    <div>
      <textarea aria-label="Message Zavi…" defaultValue={seed?.text ?? ""} />
      <button
        type="button"
        onClick={() => {
          void onBeforeSend?.("Use last month's numbers").then((r) => {
            sendResults.push(r);
          });
        }}
      >
        stub-send
      </button>
      {}
      <button
        type="button"
        onClick={() => void onOptimistic?.("here is the file", [{ path: "a.png", kind: "image" }])}
      >
        stub-send-with-file
      </button>
    </div>
  ),
}));

import { ChannelsPage, type ChannelEntry } from "./ChannelsPage";
import { TaskFooter } from "../actions/ActionFooter";
import { useChannelActions } from "../actions/useChannelActions";
import type { ActionItem } from "../actions/types";

const ACTION = {
  id: "act-1",
  title: "Raise the cap on Brand Exact",
  channel_slug: "google_ads",
  kind: "task",
  body: "",
} as unknown as ActionItem;

const ENTRY: ChannelEntry = {
  channel: {
    slug: "google_ads",
    name: "Google Ads",
    connectors: [],
  } as unknown as ChannelEntry["channel"],
  count: 1,
  waiting: 1,
  subtitle: null,
  lock: null,
};

function Card() {
  const channel = useChannelActions("google_ads");
  return <TaskFooter a={ACTION} handlers={channel.handlers} />;
}

function ok(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

async function mountPage(entry: ChannelEntry = ENTRY) {
  window.history.replaceState({}, "", `/workspace?tab=channels&channel=${entry.channel.slug}`);
  await act(async () => {
    render(
      <ChannelsPage
        entries={[entry]}
        loading={false}
        onShow={() => {}}
        onUpgrade={() => {}}
        renderDetail={() => <Card />}
      />,
    );
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useChatThreadSpy.mockReset();
  sendResults.length = 0;
  systemRows.mockReset();
  optimisticUsers.mockReset();
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) => {
    if (String(path).includes("/metrics")) return ok({ metrics: [] });
    if (String(path).includes("/redo")) return ok({ ok: true });
    return ok({ actions: [], more: 0, store: "channel_actions" });
  });
});
afterEach(cleanup);

it("a channel page is ONE column of content plus the folded chat rail", async () => {
  await mountPage();
  expect(screen.getByRole("button", { name: "Show the chat" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Hide the chat" })).toBeNull();
  expect(screen.queryByText(/^Pinned to:/)).toBeNull();
  expect(useChatThreadSpy).not.toHaveBeenCalled();
});

it("the rail opens channel chat without a channel subtitle or pinned banner", async () => {
  await mountPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Show the chat" }));
  });
  expect(screen.queryByText("On this channel")).toBeNull();
  expect(screen.queryByText(/^Pinned to:/)).toBeNull();
  expect(
    screen.getByRole("separator", { name: "Resize the Google Ads conversation" }),
  ).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Hide the chat" }));
  });
  expect(screen.getByRole("button", { name: "Show the chat" })).toBeTruthy();
});

it("Meta Ads chart chat opens without channel labels", async () => {
  await mountPage({
    ...ENTRY,
    channel: { ...ENTRY.channel, slug: "meta_ads", name: "Meta Ads" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Show the chat" }));
  });
  expect(screen.queryByText("On this channel")).toBeNull();
  expect(screen.queryByText(/^Pinned to:/)).toBeNull();
  expect(screen.getByRole("button", { name: "Hide the chat" })).toBeTruthy();
});

it("Ask Zavi renders on the card and opens the column, pinned to that action", async () => {
  await mountPage();
  const ask = screen.getByRole("button", { name: "Ask Zavi" });
  await act(async () => {
    fireEvent.click(ask);
  });
  expect(screen.getByRole("button", { name: "Hide the chat" })).toBeTruthy();
  expect(screen.getByText("Raise the cap on Brand Exact")).toBeTruthy();
  expect(screen.getByText("On this action")).toBeTruthy();
  expect(screen.queryByText(/^Pinned to:/)).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Hide the chat" }));
  });
  expect(screen.queryByRole("button", { name: "Hide the chat" })).toBeNull();
  expect(screen.getByRole("button", { name: "Show the chat" })).toBeTruthy();
});

it("the width is stored PER CHANNEL, so widening one does not resize another", async () => {
  await mountPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Show the chat" }));
  });
  const separator = screen.getByRole("separator", {
    name: "Resize the Google Ads conversation",
  });
  await act(async () => {
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
  });
  expect(window.localStorage.getItem("zavi.channelChat.google_ads.width")).toBeTruthy();
  expect(window.localStorage.getItem("zavi.channelChat.reddit_organic.width")).toBeNull();
});

it("Redo opens the same column, and the founder's first message IS the redo note", async () => {
  await mountPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  });
  expect(screen.getByText("Running this again")).toBeTruthy();
  expect(screen.queryByLabelText("What should Zavi do differently?")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "stub-send" }));
  });
  const redoCalls = apiFetch.mock.calls.filter((c) => String(c[0]).includes("/redo"));
  expect(redoCalls).toHaveLength(1);
  expect(String(redoCalls[0][0])).toBe("/api/channel-actions/act-1/redo");
  expect(JSON.parse(String(redoCalls[0][1].body))).toEqual({
    note: "Use last month's numbers",
  });
});

it("WITHOUT a provider nothing on a card changes: no Ask Zavi, Redo keeps its inline note", async () => {
  await act(async () => {
    render(<Card />);
  });
  expect(screen.queryByRole("button", { name: "Ask Zavi" })).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  });
  expect(screen.getByText("What should Zavi do differently?")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Close chat" })).toBeNull();
});

it("a REFUSED redo does not claim a run started, and can be tried again", async () => {
  apiFetch.mockImplementation((path: string) => {
    if (String(path).includes("/metrics")) return ok({ metrics: [] });
    if (String(path).includes("/redo"))
      return Promise.resolve({
        ok: false,
        status: 409,
        json: async () => ({
          error: { code: "exec_action_use_revise", message: "This is an account change." },
        }),
      });
    return ok({ actions: [], more: 0, store: "channel_actions" });
  });
  await mountPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "stub-send" }));
  });

  expect(sendResults).toHaveLength(1);
  expect(systemRows).toHaveBeenCalledTimes(1);
  const [refusalText, refusalOpts] = systemRows.mock.calls[0];
  expect(String(refusalText)).not.toMatch(/running this channel again/i);
  expect(String(refusalText)).toMatch(/could not start/i);
  expect(refusalOpts).toEqual({ persists: false });
  expect(sendResults[0].handled).toBe(true);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "stub-send" }));
  });
  expect(apiFetch.mock.calls.filter((c) => String(c[0]).includes("/redo"))).toHaveLength(2);
});

it("two sends in the same breath start ONE run, not two", async () => {
  let release: (() => void) | null = null;
  apiFetch.mockImplementation((path: string) => {
    if (String(path).includes("/metrics")) return ok({ metrics: [] });
    if (String(path).includes("/redo"))
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      });
    return ok({ actions: [], more: 0, store: "channel_actions" });
  });
  await mountPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "stub-send" }));
    fireEvent.click(screen.getByRole("button", { name: "stub-send" }));
  });
  expect(apiFetch.mock.calls.filter((c) => String(c[0]).includes("/redo"))).toHaveLength(1);

  await act(async () => {
    release?.();
  });
  expect(apiFetch.mock.calls.filter((c) => String(c[0]).includes("/redo"))).toHaveLength(1);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "stub-send" }));
  });
  expect(apiFetch.mock.calls.filter((c) => String(c[0]).includes("/redo"))).toHaveLength(1);
});

it("a redo turn carrying a FILE is an ordinary chat write, so its bubble stays sweepable", async () => {
  await mountPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "stub-send-with-file" }));
  });
  expect(optimisticUsers).toHaveBeenCalledTimes(1);
  const [, attachments, opts] = optimisticUsers.mock.calls[0];
  expect(attachments).toEqual([{ path: "a.png", kind: "image" }]);
  expect(opts).toEqual({ persists: true });
});

it("pressing Enter over and over during one send explains itself ONCE", async () => {
  let release: (() => void) | null = null;
  apiFetch.mockImplementation((path: string) => {
    if (String(path).includes("/metrics")) return ok({ metrics: [] });
    if (String(path).includes("/redo"))
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      });
    return ok({ actions: [], more: 0, store: "channel_actions" });
  });
  await mountPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  });
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "stub-send" }));
    }
  });
  expect(apiFetch.mock.calls.filter((c) => String(c[0]).includes("/redo"))).toHaveLength(1);
  const swallowLines = systemRows.mock.calls.filter(([t]) =>
    String(t).includes("Still sending your note"),
  );
  expect(swallowLines).toHaveLength(1);

  await act(async () => {
    release?.();
  });
  expect(
    systemRows.mock.calls.filter(([t]) => String(t).includes("running this channel again")),
  ).toHaveLength(1);
});
