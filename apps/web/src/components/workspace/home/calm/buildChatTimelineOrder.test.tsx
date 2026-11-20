// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type * as React from "react";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  session: {} as Record<string, unknown>,
  errorMsg: null as string | null,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
}));
vi.mock("../../ThreadBar", () => ({ ThreadBar: () => null }));
vi.mock("../../ChatExpandButton", () => ({
  ChatExpandButton: () => null,
  HEADER_CARD_SHADOW: "",
}));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspace: () => ({
    userEmail: "founder@example.com",
    openTab: () => "t",
    role: "owner",
    seedComposer: vi.fn(),
    openAgentTab: vi.fn(),
  }),
}));
vi.mock("../../Composer", () => ({ Composer: () => <textarea aria-label="Message Zavi" /> }));
vi.mock("@/lib/workspace/useAgentRun", () => ({
  useAgentRun: () => ({ send: vi.fn(), inflight: false }),
}));
vi.mock("@/lib/workspace/useHandoffProgress", () => ({
  useHandoffProgress: () => [],
}));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: () => ({
    rows: state.rows,
    activityRows: [],
    activityByRun: new Map(),
    loading: false,
    errorMsg: state.errorMsg,
    activeRunId: null,
    activeTrigger: null,
    activeRunStartedAt: null,
    activeRunTurnStartedAt: null,
    refetch: () => {},
    reload: () => {},
    appendOptimisticUser: () => null,
    removeOptimisticUser: () => {},
    appendOptimisticSystem: () => {},
  }),
}));

import { HomeChatPanel } from "./HomeChatPanel";
import {
  BuildTranscriptContent,
  useBuildTimelineItems,
} from "../../build/BuildModePane";

const SESSION = "e4c88d44-683a-4a5b-ab84-5aadfc4c5b1d";
const THREAD = "6398bd6d-cb32-4759-9941-7c163ac0a925";

const OBJECTIVE = "Connect drivers, cars, owners and corporate clients in one dashboard";
const HERO = "Make the hero darker";
const FORGOT = "forgot password option is missing in signin page - Add that";
const ENGINEER = "The engineer is adding the Forgot password option to your sign-in page now.";
const SHOW = "show my website";
const OWNER = "I'm the owner but i'm unable to signin";

function session() {
  return {
    loaded: true,
    notFound: false,
    authExpired: false,
    loadError: null,
    run: {
      id: SESSION,
      objective: `Build product: Hema — ${OBJECTIVE}`,
      status: "done",
      createdAt: "2026-10-02T05:00:00.000Z",
      updatedAt: "2026-10-02T05:20:00.000Z",
      stages: [],
      failure: null,
    },
    isCurrent: true,
    previewUrl: "https://fleethub-90d6247f.onrender.com",
    previewKind: "final",
    liveUrl: "https://fleethub-90d6247f.onrender.com",
    refines: [
      {
        id: "11111111-0000-4000-8000-000000000001",
        message: HERO,
        status: "done",
        summary: "Hero now uses the deep green",
        failure_message: null,
        created_at: "2026-10-02T06:00:00.000Z",
      },
      {
        id: "11111111-0000-4000-8000-000000000002",
        message: SHOW,
        status: "failed",
        failure_message: "engineer run failed",
        created_at: "2026-10-02T12:34:00.000Z",
      },
      {
        id: "11111111-0000-4000-8000-000000000003",
        message: OWNER,
        status: "failed",
        failure_message: "engineer run failed",
        created_at: "2026-10-02T12:40:00.000Z",
      },
    ],
    refinesLoaded: true,
    stopping: false,
    continuing: false,
    retry: vi.fn(),
  };
}

function chatRows() {
  return [
    {
      id: "m:forgot",
      kind: "chat_user",
      agent_run_id: "run-forgot",
      body: { text: FORGOT },
      citations: [],
      created_at: "2026-10-02T09:57:00.123456+00:00",
      attachments: null,
    },
    {
      id: "m:engineer",
      kind: "chat_assistant",
      agent_run_id: "run-forgot",
      body: { text: ENGINEER },
      citations: [],
      created_at: "2026-10-02T09:57:30.654321+00:00",
      trigger: "chat",
      tools: [],
    },
  ];
}

const separatorProps = {} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"];

function BuildChat() {
  const s = state.session as unknown as Parameters<typeof useBuildTimelineItems>[1];
  const items = useBuildTimelineItems(SESSION, s, false, THREAD);
  return (
    <HomeChatPanel
      greeting="Good evening."
      pulse={<span>pulse</span>}
      suggestions={[]}
      expanded={false}
      onExpandedChange={() => {}}
      width={430}
      dragging={false}
      side="left"
      surface="card"
      showThreadBar={false}
      showExpand={false}
      separatorProps={separatorProps}
      initialThreadId={THREAD}
      prelude={<BuildTranscriptContent sessionId={SESSION} session={s} changesInThread />}
      timelineItems={items}
      timelineStartAt={s.run?.createdAt ?? null}
    />
  );
}

function follows(earlier: HTMLElement, later: HTMLElement): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

afterEach(() => {
  cleanup();
  state.rows = [];
  state.session = {};
  state.errorMsg = null;
});

describe("the build chat reads top to bottom in time order", () => {
  it("shows a 6 PM failed change below the 3:27 PM conversation, not above it", () => {
    state.session = session();
    state.rows = chatRows();
    render(<BuildChat />);

    const objective = screen.getByText(OBJECTIVE, { exact: false });
    const hero = screen.getByText(HERO);
    const forgot = screen.getByText(FORGOT);
    const engineer = screen.getByText(ENGINEER, { exact: false });
    const show = screen.getByText(SHOW);
    const owner = screen.getByText(OWNER);

    expect(follows(objective, hero)).toBe(true);
    expect(follows(hero, forgot)).toBe(true);
    expect(follows(forgot, engineer)).toBe(true);
    expect(follows(engineer, show)).toBe(true);
    expect(follows(show, owner)).toBe(true);
  });

  it("a change sent minutes after another still carries its own date and time", () => {
    state.session = session();
    state.rows = chatRows();
    render(<BuildChat />);
    const show = screen.getByText(SHOW);
    const owner = screen.getByText(OWNER);
    const between = screen.getAllByRole("separator").filter((sep) => follows(show, sep) && follows(sep, owner));
    expect(between).toHaveLength(1);
    const engineer = screen.getByText(ENGINEER, { exact: false });
    const forgot = screen.getByText(FORGOT);
    expect(screen.getAllByRole("separator").filter((sep) => follows(forgot, sep) && follows(sep, engineer))).toHaveLength(0);
  });

  it("draws each change once, with its failure card, inside the thread", () => {
    state.session = session();
    state.rows = chatRows();
    render(<BuildChat />);

    expect(screen.getAllByText(SHOW)).toHaveLength(1);
    expect(screen.getAllByText(OWNER)).toHaveLength(1);
    expect(screen.getAllByText("This change didn't finish")).toHaveLength(2);
    const thread = screen.getByRole("log");
    expect(thread.contains(screen.getByText(SHOW))).toBe(true);
    expect(thread.contains(screen.getByText(FORGOT))).toBe(true);
  });

  it("still shows the changes when the build has no chat messages yet", () => {
    state.session = session();
    state.rows = [];
    render(<BuildChat />);

    expect(follows(screen.getByText(HERO), screen.getByText(SHOW))).toBe(true);
    expect(follows(screen.getByText(SHOW), screen.getByText(OWNER))).toBe(true);
    expect(screen.queryByText(/No messages yet/)).toBeNull();
  });

  it("keeps the changes on screen above the error when the chat thread fails to load", () => {
    state.session = session();
    state.rows = chatRows();
    state.errorMsg = "network down";
    render(<BuildChat />);

    const error = screen.getByText(/Couldn.t load thread: network down/);
    expect(follows(screen.getByText(SHOW), error)).toBe(true);
    expect(screen.getAllByText("This change didn't finish")).toHaveLength(2);
    expect(screen.queryByText(FORGOT)).toBeNull();
  });
});

function TimelineOnly({ publishOnRequest }: { publishOnRequest: boolean }) {
  const items = useBuildTimelineItems(SESSION, state.session as never, publishOnRequest);
  return <div>{items.map((item) => <div key={item.id}>{item.node}</div>)}</div>;
}

it.each([
  { rootDeployed: true, publishOnRequest: true, label: "Nothing changes at your site's address until you press Publish.", other: "It goes live on its own once it's ready." },
  { rootDeployed: false, publishOnRequest: false, label: "It goes live on its own once it's ready.", other: "Nothing changes at your site's address until you press Publish." },
])("a running change uses the current Publish setting rather than the root's deploy stage: $label", ({ rootDeployed, publishOnRequest, label, other }) => {
  const snapshot = session();
  state.session = {
    ...snapshot,
    run: { ...snapshot.run, stages: [{ stage: "build", status: "done" }, ...(rootDeployed ? [{ stage: "deploy", status: "done" }] : [])] },
    refines: [{ ...snapshot.refines[0], status: "active" }],
  };
  render(<TimelineOnly publishOnRequest={publishOnRequest} />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText(other)).toBeNull();
});

describe("a change asked for in this Build chat shows the founder's words once", () => {
  const CARDS = "Can you add a card-type view similar to the given image for the preview, for mixed gender?";
  const ATTACHED = "chat-attachments/tnt/cards.png";
  const askBubbles = () =>
    screen.queryAllByTestId("build-user-bubble").filter((el) => el.textContent?.includes(CARDS));

  function askedWithImage(threadOfRefine: string | null) {
    const base = session();
    state.session = {
      ...base,
      refines: [
        {
          id: "11111111-0000-4000-8000-000000000009",
          message: CARDS,
          status: "active",
          failure_message: null,
          created_at: "2026-10-02T14:56:20.000Z",
          chat_thread_id: threadOfRefine,
        },
      ],
    };
    state.rows = [
      {
        id: "m:cards",
        kind: "chat_user",
        agent_run_id: "run-cards",
        body: { text: CARDS },
        citations: [],
        created_at: "2026-10-02T14:56:00.000000+00:00",
        attachments: [{ path: ATTACHED, kind: "image" }],
      },
    ];
  }

  it("draws the turn with its image once, not again as a second bubble under the change", () => {
    askedWithImage(THREAD);
    render(<BuildChat />);
    expect(screen.getAllByText(CARDS)).toHaveLength(1);
    expect(askBubbles()).toHaveLength(0);
    expect(screen.getAllByTestId("build-reply")).toHaveLength(1);
  });

  it("puts no fresh date and time between the turn and the change it started", () => {
    askedWithImage(THREAD);
    render(<BuildChat />);
    const asked = screen.getByText(CARDS);
    const reply = screen.getByTestId("build-reply");
    expect(screen.getAllByRole("separator").filter((sep) => follows(asked, sep) && follows(sep, reply))).toHaveLength(0);
  });

  it("keeps the ask on a change started from another conversation, since this thread never showed it", () => {
    askedWithImage("0f1c1a5e-6a6e-4d5a-9a3a-1c0a2b3c4f99");
    state.rows = [];
    render(<BuildChat />);
    expect(screen.getAllByText(CARDS)).toHaveLength(1);
    expect(askBubbles()).toHaveLength(1);
  });

  it("keeps the ask on a change started from the Build page, which writes no chat message", () => {
    askedWithImage(null);
    state.rows = [];
    render(<BuildChat />);
    expect(askBubbles()).toHaveLength(1);
  });
});
