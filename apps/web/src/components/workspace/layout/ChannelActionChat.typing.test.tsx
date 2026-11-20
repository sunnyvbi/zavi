// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: h.apiFetch }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
    rpc: () => Promise.resolve({ data: [], error: null }),
  }),
}));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: () => Promise.resolve("tenant-1") }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("@/lib/workspace/useChatThread", () => ({
  useChatThread: () => ({
    rows: [],
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
vi.mock("../InlineStatusRow", () => ({ InlineStatusRow: () => null }));
vi.mock("../LowCreditsWarning", () => ({ LowCreditsWarning: () => null }));
vi.mock("../useAgentThreads", () => ({ notifyThreadsChanged: () => {} }));
vi.mock("../chat/TeamNoteStrip", () => ({ TeamNoteStrip: () => null }));
vi.mock("@/components/ZaviMascot", () => ({ ZaviMascot: () => null }));
vi.mock("../WorkspaceShell", () => {
  const noop = () => {};
  return {
    useWorkspace: () => ({
      setTabDirty: noop,
      setTabThreadId: noop,
      role: "owner",
      composerSeeds: {},
      consumeComposerSeed: noop,
      closeTab: noop,
      openTab: noop,
    }),
  };
});
vi.mock("@/lib/workspace/tenantCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/tenantCommands")>()),
  useTenantCommands: () => ({ commands: [], loaded: true, error: null }),
}));

import { ChannelActionChat } from "./ChannelActionChat";
import type { ChannelChatPin } from "../actions/channelChat";
import type { ActionItem } from "../actions/types";

Element.prototype.scrollIntoView = () => {};

const PIN: ChannelChatPin = {
  target: "action",
  mode: "ask",
  action: {
    id: "card-1",
    title: "Chocolate launch",
    channel_slug: "email_marketing",
    kind: "send_message",
    body: {},
  } as unknown as ActionItem,
  onRedo: () => {},
};

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;

function typeKey(box: HTMLTextAreaElement, ch: string) {
  valueSetter.call(box, box.value + ch);
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

let errors: string[] = [];
let thrown: unknown[] = [];
const onWindowError = (e: ErrorEvent) => {
  thrown.push(e.error ?? e.message);
  e.preventDefault();
};
beforeEach(() => {
  errors = [];
  thrown = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  window.addEventListener("error", onWindowError);
  h.apiFetch.mockReset();
  h.apiFetch.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ threads: [] }),
    text: async () => "{}",
  }));
});
afterEach(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  window.removeEventListener("error", onWindowError);
  cleanup();
  vi.restoreAllMocks();
});

it("keeps every letter when keys land faster than React's background render, with no update-depth throw", async () => {
  await act(async () => {
    render(
      <StrictMode>
        <ChannelActionChat
          pin={PIN}
          channelSlug="email_marketing"
          channelName="Email campaigns"
          open
          onClose={() => {}}
        />
      </StrictMode>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(screen.getAllByText("On this action").length).toBeGreaterThan(0);
  const box = screen.getAllByRole("textbox", { hidden: true })[0] as HTMLTextAreaElement;
  const seeded = box.value;
  expect(seeded).toContain("Chocolate launch");

  const text = "I should like the copy shorter, and again shorter. ".repeat(4);
  expect(text.length).toBeGreaterThan(120);
  actEnv.IS_REACT_ACT_ENVIRONMENT = false;
  for (const ch of text) {
    try {
      typeKey(box, ch);
    } catch (e) {
      thrown.push(e);
    }
  }
  await new Promise((r) => setTimeout(r, 20));
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;

  expect(box.value).toBe(seeded + text);
  expect(thrown.map(String)).toEqual([]);
  expect(errors.filter((e) => /Maximum update depth/.test(e))).toEqual([]);
});
