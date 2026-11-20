// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";

type Tab = { id: string; kind: string; payload: Record<string, unknown> };

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    tabs: [] as Tab[],
    bindings: [] as Array<[string, string | null]>,
  };
  return {
    state,
    listeners,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setTabs: (tabs: Tab[]) => {
      state.tabs = tabs;
      for (const fn of Array.from(listeners)) fn();
    },
  };
});

const run = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body: string | null }>,
  linked: [] as string[],
  followOn: true,
  send: vi.fn(),
  feedback: vi.fn(async () => ({ ok: true })),
  tabSeeds: {} as Record<string, { text: string; nonce: number }>,
  sessionsGate: null as Promise<void> | null,
}));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => "/workspace" }));
vi.mock("../WorkspaceShell", () => {
  const noop = () => {};
  return {
    useWorkspace: () => {
      const tabs = useSyncExternalStore(store.subscribe, () => store.state.tabs, () => store.state.tabs);
      return {
        userEmail: "founder@example.com",
        tenantName: "Acme",
        openTab: () => "t",
        tabs,
        setTabThreadId: (tabId: string, threadId: string | null) => {
          store.state.bindings.push([tabId, threadId]);
          const tab = store.state.tabs.find((t) => t.id === tabId);
          if (!tab) return;
          store.setTabs(
            store.state.tabs.map((t) => (t.id === tabId ? { ...t, payload: { ...t.payload, threadId } } : t)),
          );
        },
        setTabDirty: noop,
        role: "owner",
        composerSeeds: run.tabSeeds,
        consumeComposerSeed: (tabId: string) => {
          delete run.tabSeeds[tabId];
        },
        closeTab: noop,
      };
    },
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
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    run.calls.push({ path, method: init?.method ?? "GET", body: init?.body ?? null });
    if (path === "/api/workspace/website/chat") return { ok: true, json: async () => ({ route: "operator" }) };
    if (path === "/api/workspace/autopilot/build-sessions") {
      if (run.sessionsGate) await run.sessionsGate;
      return {
        ok: true,
        json: async () => ({
          sessions: [
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              title: "Bikes",
              request: "",
              state: "ready",
              run_status: "done",
              created_at: "2026-10-01T09:00:00Z",
              last_activity_at: "2026-10-01T09:00:00Z",
              refine_count: 0,
              is_current: true,
              ...(run.linked.length ? { chat_thread_ids: run.linked } : {}),
            },
          ],
          current_session_id: null,
          flags: {},
          ui_flags: { chat_thread_follows_build: run.followOn },
        }),
      };
    }
    return { ok: true, json: async () => (path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [] }) };
  }),
}));
vi.mock("../ThreadBar", () => ({ ThreadBar: () => null }));
vi.mock("../ChatExpandButton", () => ({
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
  }),
}));
vi.mock("../ChatThread", () => ({ ChatThread: () => <div /> }));
vi.mock("./WebsitePreview", () => ({
  WebsitePreview: () => <div data-testid="preview" />,
  chatEditErrorMessage: () => "",
}));
vi.mock("./WebsiteConsole", () => ({ WebsiteConsole: () => <div>console</div> }));
vi.mock("../build/BuildHistoryPanel", () => ({ BuildHistoryPanel: () => null }));
vi.mock("../build/AppCodePane", () => ({
  AppCodePane: () => <div />,
  ReadOnlyBadge: () => <button type="button">Read only</button>,
}));
vi.mock("../build/BuildFilesPane", () => ({ BuildFilesPane: () => <div /> }));
vi.mock("./PublishPopover", () => ({ PublishPopover: () => <div>publish</div> }));
vi.mock("../home/summaryState", () => ({ loadSummary: () => Promise.resolve(null) }));
vi.mock("@/lib/workspace/useBuildPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildPreview")>()),
  useBuildPreview: () => ({
    building: false,
    loaded: true,
    previewUrl: null,
    runStatus: "done",
    stages: [],
    failure: null,
    settledNonce: 0,
  }),
  isTerminalBuildRun: () => true,
}));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({ useOptimisticBuildStart: () => false }));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  useBuildSession: () => ({
    loaded: true,
    run: null,
    refines: [],
    liveUrl: null,
    previewUrl: null,
    previewKind: "none",
    repoUrl: null,
    notFound: false,
    authExpired: false,
    refineSubmitting: false,
    sendRefine: async () => null,
  }),
}));

import { AppWorkspace } from "../WebsiteTab";
import { __resetBuildSessionsForTest } from "@/lib/workspace/useBuildSessions";

Element.prototype.scrollIntoView = () => {};

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LINKED = "22222222-2222-4222-8222-222222222222";
const FRESH = "33333333-3333-4333-8333-333333333333";

const box = () => document.querySelector("textarea") as HTMLTextAreaElement;
const sendButton = () => document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
const linkPosts = () => run.calls.filter((c) => c.method === "POST" && c.path.endsWith("/thread"));
const sessionReads = () => run.calls.filter((c) => c.path === "/api/workspace/autopilot/build-sessions").length;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
}

async function say(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.click(sendButton());
  await flush();
}

beforeEach(() => {
  __resetBuildSessionsForTest();
  store.state.tabs = [{ id: "tab-build", kind: "build", payload: { kind: "build", sessionId: SESSION, threadId: null } }];
  store.state.bindings = [];
  run.calls = [];
  run.linked = [];
  run.followOn = true;
  run.sessionsGate = null;
});

afterEach(() => {
  cleanup();
  run.send.mockReset();
});

describe("DEL-1323 B26: one conversation per build", () => {
  it("reopening a build (its URL says buildThread=new) sends the next question into the build's saved conversation", async () => {
    run.linked = [LINKED];
    run.send.mockResolvedValue({ kind: "queued", thread_id: LINKED, user_message_id: "m1", run_id: "r1" });
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await flush();
    await flush();
    await say("is the booking form working?");
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(run.send.mock.calls[0]![2]).toBe(LINKED);
    expect(store.state.tabs[0]!.payload.threadId).toBe(LINKED);
    expect(linkPosts()).toHaveLength(0);
  });

  it("the first question on a build never posts a link; it refreshes the list once so the server's stamp shows up", async () => {
    run.send.mockResolvedValue({ kind: "queued", thread_id: FRESH, user_message_id: "m1", run_id: "r1" });
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await flush();
    const readsBefore = sessionReads();
    await say("what colours did you use?");
    expect(run.send.mock.calls[0]![2]).toBe(null);
    await flush();
    expect(sessionReads()).toBe(readsBefore + 1);
    await say("and the fonts?");
    await flush();
    expect(run.send.mock.calls[1]![2]).toBe(FRESH);
    expect(sessionReads()).toBe(readsBefore + 1);
    expect(linkPosts()).toHaveLength(0);
  });

  it("when chat-send forks away from the saved thread, the chat follows the fork and the next list keeps it there", async () => {
    const FORKED = "44444444-4444-4444-8444-444444444444";
    run.linked = [LINKED];
    run.send.mockResolvedValue({ kind: "queued", thread_id: FORKED, user_message_id: "m1", run_id: "r1" });
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await flush();
    await flush();
    await say("change the headline");
    expect(run.send.mock.calls[0]![2]).toBe(LINKED);
    expect(store.state.tabs[0]!.payload.threadId).toBe(FORKED);
    run.linked = [FORKED];
    await flush();
    await flush();
    await say("and the button colour");
    expect(run.send.mock.calls[1]![2]).toBe(FORKED);
    expect(store.state.tabs[0]!.payload.threadId).toBe(FORKED);
    expect(linkPosts()).toHaveLength(0);
  });

  it("with the setting off the saved conversation is ignored and nothing is posted", async () => {
    run.followOn = false;
    run.linked = [LINKED];
    run.send.mockResolvedValue({ kind: "queued", thread_id: FRESH, user_message_id: "m1", run_id: "r1" });
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await flush();
    await flush();
    await say("is the booking form working?");
    expect(run.send.mock.calls[0]![2]).toBe(null);
    await flush();
    expect(linkPosts()).toHaveLength(0);
  });

  it("a thread created before the build list loaded triggers one refresh once the setting arrives, and no post", async () => {
    let release: () => void = () => {};
    run.sessionsGate = new Promise<void>((r) => {
      release = r;
    });
    run.send.mockResolvedValue({ kind: "queued", thread_id: FRESH, user_message_id: "m1", run_id: "r1" });
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await flush();
    await say("what colours did you use?");
    await flush();
    expect(store.state.tabs[0]!.payload.threadId).toBe(FRESH);
    const readsBefore = sessionReads();
    run.sessionsGate = null;
    await act(async () => {
      release();
    });
    await flush();
    await flush();
    expect(sessionReads()).toBeGreaterThan(readsBefore);
    const settled = sessionReads();
    await flush();
    await flush();
    expect(sessionReads()).toBe(settled);
    expect(linkPosts()).toHaveLength(0);
  });
});
