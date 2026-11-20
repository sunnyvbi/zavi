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
  send: vi.fn(),
  feedback: vi.fn(async () => ({ ok: true })),
  tabSeeds: {} as Record<string, { text: string; nonce: number }>,
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
  apiFetch: vi.fn(async (path: string) =>
    path === "/api/workspace/website/chat"
      ? { ok: true, json: async () => ({ route: "operator" }) }
      : { ok: true, json: async () => (path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [] }) },
  ),
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

Element.prototype.scrollIntoView = () => {};

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD = "11111111-1111-4111-8111-111111111111";

const box = () => document.querySelector("textarea") as HTMLTextAreaElement;
const sendButton = () => document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}

async function say(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.click(sendButton());
  await flush();
}

beforeEach(() => {
  store.state.tabs = [{ id: "tab-build", kind: "build", payload: { kind: "build", sessionId: SESSION } }];
  store.state.bindings = [];
});

afterEach(() => {
  cleanup();
  run.send.mockReset();
});

describe("the Build tab keeps one chat thread across sends", () => {
  it("binds the thread the first send creates and reuses it for every later send", async () => {
    run.send.mockResolvedValue({ kind: "queued", thread_id: THREAD, user_message_id: "m1", run_id: "r1" });
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await flush();

    await say("make the hero headline shorter");
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(run.send.mock.calls[0]![2]).toBe(null);
    expect(store.state.tabs[0]!.payload.threadId).toBe(THREAD);

    await say("and make the button blue");
    expect(run.send).toHaveBeenCalledTimes(2);
    expect(run.send.mock.calls[1]![2]).toBe(THREAD);

    await say("now add a footer");
    expect(run.send).toHaveBeenCalledTimes(3);
    expect(run.send.mock.calls[2]![2]).toBe(THREAD);
    expect(store.state.tabs[0]!.payload.threadId).toBe(THREAD);
  });
});
