// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelActionChat } from "./ChannelActionChat";
import { ChannelActionsLane } from "../actions/ChannelActionsLane";
import { makeAction } from "../actions/__tests__/fixtures";
import { CHANNEL_ACTIONS_CHANGED_EVENT } from "../actions/topActions/api";
import type { ChannelChatPin } from "../actions/channelChat";
import type { ActionItem } from "../actions/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  seq: 0,
  rows: [] as Array<{ kind: string; agent_run_id: string }>,
  status: [] as Array<{ runId: string; onComplete: (s: "success" | "error" | "failed" | "cancelled", c: number | null) => void }>,
}));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: () => ({
    rows: h.rows,
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
  }),
}));
vi.mock("../ChatThread", () => ({ ChatThread: () => <div data-testid="chat-thread" /> }));
vi.mock("../InlineStatusRow", () => ({
  InlineStatusRow: (p: { runId: string; onComplete: (s: "success" | "error" | "failed" | "cancelled", c: number | null) => void }) => {
    h.status.push({ runId: p.runId, onComplete: p.onComplete });
    return null;
  },
}));
vi.mock("../LowCreditsWarning", () => ({ LowCreditsWarning: () => null }));
vi.mock("../useAgentThreads", () => ({ notifyThreadsChanged: () => {} }));
vi.mock("../chat/TeamNoteStrip", () => ({ TeamNoteStrip: () => null }));
vi.mock("@/components/ZaviMascot", () => ({ ZaviMascot: () => null }));
vi.mock("../Composer", () => ({
  Composer: ({ onSent }: { onSent: (runId: string) => void }) => (
    <div>
      <textarea aria-label="Message Zavi" />
      <button type="button" onClick={() => onSent(`run-redraft-${++h.seq}`)}>
        stub-send-run
      </button>
    </div>
  ),
}));

const SLUG = "email_marketing";
const PIN: ChannelChatPin = {
  target: "action",
  mode: "ask",
  action: { id: "ca-old", title: "Old card", channel_slug: SLUG, kind: "send_message", body: {} } as unknown as ActionItem,
  onRedo: () => {},
};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const oldCard = makeAction("text_post", { id: "ca-old", channel_slug: SLUG, title: "The old card" });
const newCard = makeAction("text_post", { id: "ca-new", channel_slug: SLUG, title: "The redrafted card" });
let actions = [oldCard];
const actionReads = () =>
  h.apiFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes(`/api/channels/${SLUG}/actions`));

let events: Array<{ slug?: string }> = [];
const onEvent = (e: Event) => events.push((e as CustomEvent<{ slug?: string }>).detail);

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function Chat({ slug = SLUG }: { slug?: string }) {
  return <ChannelActionChat pin={PIN} channelSlug={slug} channelName="Email" open onClose={() => {}} />;
}

async function sendRun() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "stub-send-run" }));
  });
}
const finish = (status: "success" | "error" | "failed" | "cancelled" = "success") =>
  act(() => h.status[h.status.length - 1].onComplete(status, null));

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = () => {};
  events = [];
  h.status.length = 0;
  h.rows = [];
  actions = [oldCard];
  h.apiFetch.mockReset();
  h.apiFetch.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes(`/api/channels/${SLUG}/actions`)) return ok({ actions, more: 0, store: "channel_actions" });
    if (u.includes(`/metrics`)) return ok({ metrics: [] });
    return ok({});
  });
  window.addEventListener(CHANNEL_ACTIONS_CHANGED_EVENT, onEvent);
});
afterEach(() => {
  window.removeEventListener(CHANNEL_ACTIONS_CHANGED_EVENT, onEvent);
  cleanup();
  vi.useRealTimers();
});

describe("a chat run that redrafts a card", () => {
  it("announces the change exactly once when the run finishes, even if the finish is delivered twice", async () => {
    render(<Chat />);
    await sendRun();
    expect(events).toHaveLength(0);
    await finish();
    await finish();
    expect(events).toEqual([{ slug: SLUG }]);
  });

  it("announces when the run ends in an error, since it may have filed the new card first", async () => {
    render(<Chat />);
    await sendRun();
    await finish("error");
    expect(events).toEqual([{ slug: SLUG }]);
  });

  it("announces nothing while the run is still going, and nothing when the chat unmounts mid-run", async () => {
    const view = render(<Chat />);
    await sendRun();
    await flush(60_000);
    expect(events).toHaveLength(0);
    view.unmount();
    await flush(60_000);
    expect(events).toHaveLength(0);
  });

  it("announces once per run, not once per chat", async () => {
    render(<Chat />);
    await sendRun();
    await finish();
    await flush(3000);
    await sendRun();
    await finish();
    expect(events).toHaveLength(2);
  });

  it("makes the lane refetch and drop the old card for the redrafted one without a reload", async () => {
    render(
      <>
        <ChannelActionsLane slug={SLUG} legacy={<p>LEGACY RAIL</p>} workState="idle" lastRunAt="2026-09-20T10:00:00Z" actionCount={0} connected hasConnectors>
          <li>an approvals row</li>
        </ChannelActionsLane>
        <Chat />
      </>,
    );
    await flush();
    expect(actionReads()).toHaveLength(1);
    expect(screen.queryAllByText("The old card").length).toBeGreaterThan(0);
    actions = [newCard];
    await sendRun();
    await flush();
    expect(actionReads()).toHaveLength(1);
    await finish();
    await flush();
    expect(actionReads()).toHaveLength(2);
    expect(screen.queryAllByText("The old card")).toHaveLength(0);
    expect(screen.queryAllByText("The redrafted card").length).toBeGreaterThan(0);
  });

  it("still refreshes the lane when the reply lands but the run end is never heard", async () => {
    const view = render(
      <>
        <ChannelActionsLane slug={SLUG} legacy={<p>LEGACY RAIL</p>} workState="idle" lastRunAt="2026-09-20T10:00:00Z" actionCount={0} connected hasConnectors>
          <li>an approvals row</li>
        </ChannelActionsLane>
        <Chat />
      </>,
    );
    await flush();
    expect(screen.queryAllByText("The old card").length).toBeGreaterThan(0);
    actions = [newCard];
    await sendRun();
    await flush();
    const runId = h.status[h.status.length - 1].runId;
    h.rows = [{ kind: "chat_assistant", agent_run_id: runId }];
    view.rerender(
      <>
        <ChannelActionsLane slug={SLUG} legacy={<p>LEGACY RAIL</p>} workState="idle" lastRunAt="2026-09-20T10:00:00Z" actionCount={0} connected hasConnectors>
          <li>an approvals row</li>
        </ChannelActionsLane>
        <Chat />
      </>,
    );
    await flush(2500);
    await flush(120_000);
    expect(events).toEqual([{ slug: SLUG }]);
    expect(actionReads().length).toBeGreaterThanOrEqual(2);
    expect(screen.queryAllByText("The old card")).toHaveLength(0);
    expect(screen.queryAllByText("The redrafted card").length).toBeGreaterThan(0);
  });
  it("announces once when the reply lands and the run end follows it", async () => {
    const view = render(<Chat />);
    await sendRun();
    await flush();
    const runId = h.status[h.status.length - 1].runId;
    h.rows = [{ kind: "chat_assistant", agent_run_id: runId }];
    view.rerender(<Chat />);
    await flush();
    expect(events).toEqual([{ slug: SLUG }]);
    await finish("failed");
    await flush(3000);
    expect(events).toEqual([{ slug: SLUG }]);
  });
});
