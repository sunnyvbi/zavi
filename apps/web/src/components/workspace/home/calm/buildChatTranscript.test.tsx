// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type * as React from "react";

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  session: {} as Record<string, unknown>,
  sessionIds: [] as Array<string | null>,
  composerProps: {} as Record<string, unknown>,
}));

vi.mock("../../ThreadBar", () => ({ ThreadBar: () => null }));
vi.mock("../../ChatExpandButton", () => ({
  ChatExpandButton: () => null,
  HEADER_CARD_SHADOW: "",
}));
vi.mock("../../WorkspaceShell", () => ({
  useWorkspace: () => ({ userEmail: "founder@example.com", openTab: () => "t", role: "owner" }),
}));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: () => ({
    rows: state.rows,
    loading: false,
    errorMsg: null,
    reload: () => {},
    refetch: () => {},
  }),
}));
vi.mock("../../ChatThread", () => ({
  ChatThread: ({ state: s, hideEmptyState }: { state: { rows: unknown[] }; hideEmptyState?: boolean }) =>
    s.rows.length === 0 ? (
      hideEmptyState ? null : <p>No messages yet with Zavi.</p>
    ) : (
      <div data-testid="operator-thread">{s.rows.length} operator rows</div>
    ),
}));
vi.mock("../../Composer", () => ({
  Composer: (props: Record<string, unknown>) => {
    state.composerProps = props;
    return <textarea aria-label="Message Zavi" />;
  },
}));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  useBuildSession: (id: string | null) => {
    state.sessionIds.push(id);
    return state.session;
  },
}));

import { HomeChatPanel } from "./HomeChatPanel";
import { BuildTranscript } from "../../build/BuildModePane";

const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const IDEA =
  "Help me to build a simple and sober coming-soon landing page for my car rental website, which I am going to launch.";

function liveSession(overrides: Record<string, unknown> = {}) {
  return {
    loaded: true,
    notFound: false,
    authExpired: false,
    loadError: null,
    run: {
      id: SESSION,
      objective: `Build product: Mohit — ${IDEA}`,
      status: "done",
      createdAt: "2026-09-24T06:55:08.359Z",
      updatedAt: "2026-09-24T07:04:00.000Z",
      stages: [],
      failure: null,
    },
    isCurrent: true,
    previewUrl: "https://mohit-93bd8436.onrender.com",
    previewKind: "final",
    liveUrl: "https://mohit-93bd8436.onrender.com",
    repoUrl: "https://github.com/Praxis-build/mohit-93bd8436",
    refines: [
      {
        id: "r1r1r1r1-0000-4000-8000-000000000000",
        message: "Make the hero darker",
        status: "done",
        summary: "Hero now uses the deep green",
        failure_message: null,
      },
    ],
    refinesLoaded: true,
    sendRefine: vi.fn(),
    refineSubmitting: false,
    cancelRun: vi.fn(),
    stopping: false,
    continueRun: vi.fn(),
    continuing: false,
    retry: vi.fn(),
    ...overrides,
  };
}

function renderBuildChat() {
  return render(
    <HomeChatPanel
      greeting="Good afternoon, Mohit."
      pulse={<span>Your team ran 3 tasks today</span>}
      suggestions={["What did the team do this week?"]}
      expanded={false}
      onExpandedChange={() => {}}
      width={430}
      dragging={false}
      side="left"
      surface="card"
      showThreadBar={false}
      showExpand={false}
      separatorProps={{} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"]}
      initialThreadId={null}
      prelude={<BuildTranscript sessionId={SESSION} />}
    />,
  );
}

afterEach(() => {
  cleanup();
  state.rows = [];
  state.session = {};
  state.sessionIds.length = 0;
  state.composerProps = {};
});

describe("the chat beside a live app shows the build it came from", () => {
  it("opens a loaded build conversation at its newest message", () => {
    const props = {
      greeting: "Good afternoon, Mohit.",
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
      initialThreadId: null,
      prelude: <div>Loaded build conversation</div>,
    };
    const { rerender } = render(
      <HomeChatPanel {...props} preludeLastAt={null} />,
    );
    const feed = screen.getByTestId("build-chat-feed");
    let scrollTop = 0;
    Object.defineProperties(feed, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 2_000 },
      offsetParent: { configurable: true, value: document.body },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    const originalRaf = window.requestAnimationFrame;
    let nowMs = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => {
      nowMs += 1_000;
      return nowMs;
    });
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(1_000);
      return 1;
    };
    try {
      rerender(
        <HomeChatPanel
          {...props}
          preludeLastAt="2026-09-28T10:15:00.000Z"
        />,
      );
      expect(feed.scrollTop).toBe(feed.scrollHeight);

      feed.scrollTop = 100;
      fireEvent.scroll(feed);
      rerender(
        <HomeChatPanel
          {...props}
          preludeLastAt="2026-09-28T10:16:00.000Z"
        />,
      );
      expect(feed.scrollTop).toBe(100);
    } finally {
      window.requestAnimationFrame = originalRaf;
      now.mockRestore();
    }
  });

  it("shows contextual next steps as a title-free horizontal chip row and prefills one without sending it", () => {
    const suggestions = [
      {
        key: "fleet",
        label: "Add fleet cards",
        prompt: "Add a fleet section with bike cards and daily prices.",
      },
      {
        key: "locations",
        label: "Show pickup locations",
        prompt: "Add a pickup locations section with hours and addresses.",
      },
    ];
    render(
      <HomeChatPanel
        greeting="Good afternoon, Mohit."
        pulse={<span>pulse</span>}
        suggestions={[]}
        composerSuggestions={suggestions}
        expanded={false}
        onExpandedChange={() => {}}
        width={430}
        dragging={false}
        side="left"
        surface="card"
        showThreadBar={false}
        showExpand={false}
        separatorProps={{} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"]}
        initialThreadId={null}
        prelude={<div>Finished build</div>}
      />,
    );

    const list = screen.getByRole("list", { name: "Suggested next improvements" });
    expect(list.className).toContain("w-max");
    expect(list.className).toContain("gap-2");
    expect(list.parentElement?.className).toContain("overflow-x-auto");
    expect(screen.queryByText("Suggested pages & sections")).toBeNull();
    expect(screen.queryByText(suggestions[0].prompt)).toBeNull();
    expect(screen.queryByText(suggestions[1].prompt)).toBeNull();
    const suggestion = screen.getByRole("button", { name: "Add fleet cards" });
    expect(suggestion.className).toContain("whitespace-nowrap");
    const composer = screen.getByRole("textbox", { name: "Message Zavi" });
    expect(
      suggestion.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(suggestion);
    expect(state.composerProps.seed).toMatchObject({
      text: suggestions[0].prompt,
      autoSend: false,
    });
  });

  it("opens on the founder's build conversation, not a blank greeting", () => {
    state.session = liveSession();
    renderBuildChat();
    expect(screen.getByText(IDEA)).toBeTruthy();
    expect(screen.getByText("Make the hero darker")).toBeTruthy();
    expect(screen.getByText("Live on your app")).toBeTruthy();
    expect(screen.queryByText("Good afternoon, Mohit.")).toBeNull();
    expect(screen.getByText("What did the team do this week?").closest(".hidden")).not.toBeNull();
    expect(screen.queryByText("No messages yet with Zavi.")).toBeNull();
    expect(state.sessionIds.every((id) => id === SESSION)).toBe(true);
  });

  it("shows a photo sent with a change as a chip, even after the server flattened its lines", () => {
    const url =
      "http://localhost:3011/api/public/workspace-files/b92dcbf1-bac9-457a-af81-0bbe5984339b/cd9ec0c2-1c87-483f-9930-4a18bc701015/musashi.jpeg";
    state.session = liveSession({
      refines: [
        {
          id: "r2r2r2r2-0000-4000-8000-000000000000",
          message: `put this in the hero Use this photo on the site: musashi.jpeg: ${url}`,
          status: "done",
          summary: null,
          failure_message: null,
        },
      ],
    });
    renderBuildChat();
    const chips = screen.getByRole("list", { name: "Attached photo" });
    expect(chips.textContent).toBe("");
    expect(chips.querySelector("img")!.getAttribute("src")).toBe(url);
    expect(chips.querySelector("img")!.getAttribute("alt")).toBe("musashi.jpeg");
    expect(chips.querySelector("li")!.getAttribute("title")).toBe("musashi.jpeg");
    expect(screen.getByText("put this in the hero")).toBeTruthy();
    expect(document.body.textContent).not.toContain(url);
    expect(document.body.textContent).not.toContain("Use this photo on the site");
  });

  it("keeps the build conversation above later chat turns", () => {
    state.session = liveSession();
    state.rows = [{ id: "m1", kind: "chat_user" }];
    renderBuildChat();
    const idea = screen.getByText(IDEA);
    const thread = screen.getByTestId("operator-thread");
    expect(idea.compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers no Stop button on a finished build's log", () => {
    state.session = liveSession();
    renderBuildChat();
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("shows no build conversation until the build loads", () => {
    state.session = liveSession({ loaded: false, run: null, refines: [] });
    renderBuildChat();
    expect(screen.queryByText(IDEA)).toBeNull();
  });

  it("marks the welcome wordmark so dark mode can invert it", () => {
    render(
      <HomeChatPanel
        greeting="Good afternoon, Mohit."
        pulse={<span>pulse</span>}
        suggestions={[]}
        expanded={false}
        onExpandedChange={() => {}}
        width={430}
        dragging={false}
        separatorProps={{} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"]}
        initialThreadId={null}
      />,
    );
    expect(screen.getByAltText("Zavi").classList.contains("theme-logo")).toBe(true);
  });

  it("keeps the header buttons when the app has no name yet", () => {
    render(
      <HomeChatPanel
        greeting="Good afternoon, Mohit."
        pulse={<span>pulse</span>}
        suggestions={[]}
        expanded={false}
        onExpandedChange={() => {}}
        width={430}
        dragging={false}
        showThreadBar={false}
        showExpand={false}
        separatorProps={{} as React.ComponentProps<typeof HomeChatPanel>["separatorProps"]}
        initialThreadId={null}
        headerActions={<button type="button">History</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "History" })).toBeTruthy();
  });

  it("says a parked change is ready but not live instead of claiming it shipped", () => {
    state.session = liveSession({
      refines: [
        {
          id: "r2r2r2r2-0000-4000-8000-000000000000",
          message: "It looks like a template right now.",
          status: "done",
          summary: null,
          failure_message: null,
          awaiting_review: true,
        },
      ],
    });
    renderBuildChat();
    expect(screen.getByText("Saved, not live yet")).toBeTruthy();
    expect(screen.queryByText("Live on your app")).toBeNull();
    expect(screen.getByText("It looks like a template right now.")).toBeTruthy();
  });

  it("folds a finished build into one line with no internal ids, steps one click away", () => {
    state.session = liveSession({ refines: [] });
    renderBuildChat();
    const summary = screen.getByRole("button", { name: /Your app is ready/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Build d130919a/)).toBeNull();
    expect(screen.queryByText(/^r1r1r1r1/)).toBeNull();
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
  });

  it("offers Try again on a change that didn't finish", () => {
    state.session = liveSession({
      refines: [
        { id: "r3r3r3r3-0000-4000-8000-000000000000", message: "Add a pricing section", status: "failed", summary: null, failure_message: null },
      ],
    });
    renderBuildChat();
    expect(screen.getByText("This change didn't finish")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows a retry in place of the failed change instead of as a new message", () => {
    state.session = liveSession({
      refines: [
        { id: "f1f1f1f1-0000-4000-8000-000000000000", message: "Make it less like a template", status: "failed", summary: null, failure_message: null },
        {
          id: "f2f2f2f2-0000-4000-8000-000000000000",
          message: "Make it less like a template",
          status: "running",
          summary: null,
          failure_message: null,
          retry_of: "f1f1f1f1-0000-4000-8000-000000000000",
        },
      ],
    });
    renderBuildChat();
    expect(screen.getAllByText("Make it less like a template")).toHaveLength(1);
    expect(screen.queryByText("This change didn't finish")).toBeNull();
    expect(screen.getByText("Update in progress")).toBeTruthy();
  });
});
