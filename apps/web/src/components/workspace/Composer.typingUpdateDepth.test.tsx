// @vitest-environment jsdom
import { afterAll, afterEach, expect, it, vi } from "vitest";

const swap = vi.hoisted(() => {
  const Module = (process as NodeJS.Process & { getBuiltinModule(id: string): unknown }).getBuiltinModule("node:module") as {
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
  };
  const map: Record<string, string> = {
    react: "next/dist/compiled/react",
    "react/jsx-runtime": "next/dist/compiled/react/jsx-runtime",
    "react/jsx-dev-runtime": "next/dist/compiled/react/jsx-dev-runtime",
    "react-dom": "next/dist/compiled/react-dom",
    "react-dom/client": "next/dist/compiled/react-dom/client",
    scheduler: "next/dist/compiled/scheduler",
  };
  const original = Module._resolveFilename;
  Module._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    return original.call(this, map[request] ?? request, ...rest);
  };
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  return {
    restore: () => {
      Module._resolveFilename = original;
    },
    apiFetch: vi.fn(),
    renders: { composer: 0 },
  };
});

vi.mock("react", async () => vi.importActual("next/dist/compiled/react"));
vi.mock("react/jsx-runtime", async () => vi.importActual("next/dist/compiled/react/jsx-runtime"));
vi.mock("react/jsx-dev-runtime", async () =>
  vi.importActual("next/dist/compiled/react/jsx-dev-runtime"),
);
vi.mock("react-dom", async () => vi.importActual("next/dist/compiled/react-dom"));
vi.mock("react-dom/client", async () => vi.importActual("next/dist/compiled/react-dom/client"));

vi.mock("@/lib/api", () => ({ apiFetch: swap.apiFetch }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams(),
}));
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
    refetch: () => {},
    markRunStopped: () => {},
    unmarkRunStopped: () => {},
    appendOptimisticUser: () => undefined,
    appendOptimisticSystem: () => {},
  }),
}));
vi.mock("@/components/workspace/ChatThread", () => ({ ChatThread: () => null }));
vi.mock("@/components/workspace/InlineStatusRow", () => ({ InlineStatusRow: () => null }));
vi.mock("@/components/workspace/LowCreditsWarning", () => ({ LowCreditsWarning: () => null }));
vi.mock("@/components/workspace/useAgentThreads", () => ({ notifyThreadsChanged: () => {} }));
vi.mock("@/components/workspace/chat/TeamNoteStrip", () => ({ TeamNoteStrip: () => null }));
vi.mock("@/components/workspace/WorkspaceShell", () => {
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
      treeAgents: [],
      supplyDemandEligible: false,
      currentUserId: "user-1",
      tenantId: "tenant-1",
    }),
  };
});
vi.mock("@/lib/workspace/tenantCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/tenantCommands")>()),
  useTenantCommands: () => ({ commands: [], loaded: true, error: null }),
}));

import { Profiler, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { ChannelActionChat } from "./layout/ChannelActionChat";

Element.prototype.scrollIntoView = () => {};

const MESSAGE =
  "Pin three of the spring recipe boards this week and tell me which board got the most saves last month, then draft a caption for the best one.";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  swap.apiFetch.mockReset();
});

afterAll(() => swap.restore());

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

function typeLikeAnExtension(textarea: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  for (let i = 1; i <= text.length; i++) {
    setter.call(textarea, text.slice(0, i));
    textarea.setSelectionRange(i, i);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

it("typing a long message into the channel chat after New chat never trips React's update-depth limit", async () => {
  expect(MESSAGE.length).toBeGreaterThanOrEqual(140);
  swap.apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/workspace/channel-threads")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          threads: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              title: "Earlier",
              preview: null,
              last_message_at: "2026-10-22T10:00:00.000Z",
              channel_action_id: null,
              card_title: null,
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  });

  const errors: unknown[] = [];
  const onWindowError = (event: ErrorEvent) => {
    errors.push(event.error ?? event.message);
    event.preventDefault();
  };
  window.addEventListener("error", onWindowError);
  const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host, {
    onUncaughtError: (error: unknown) => errors.push(error),
    onRecoverableError: (error: unknown) => errors.push(error),
  } as never);
  let commits = 0;
  root.render(
    createElement(
      Profiler,
      { id: "channel-chat", onRender: () => void commits++ },
      createElement(ChannelActionChat, {
        pin: { target: "channel" } as never,
        channelSlug: "pinterest_organic",
        channelName: "Pinterest",
        open: true,
        onClose: () => {},
      }),
    ),
  );
  await settle();

  const newChat = host.querySelector<HTMLButtonElement>('button[aria-label="New chat"]');
  expect(newChat).not.toBeNull();
  expect(newChat!.disabled).toBe(false);
  newChat!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle();
  expect(newChat!.disabled).toBe(true);

  const textarea = host.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
  expect(textarea).not.toBeNull();
  textarea!.focus();

  const before = commits;
  let thrown: unknown = null;
  try {
    typeLikeAnExtension(textarea!, MESSAGE);
  } catch (error) {
    thrown = error;
  }
  await settle();
  window.removeEventListener("error", onWindowError);
  consoleError.mockRestore();

  const depthErrors = [thrown, ...errors].filter((e) =>
    String(e instanceof Error ? e.message : e).includes("Maximum update depth exceeded"),
  );
  expect(depthErrors).toEqual([]);
  expect(textarea!.value).toBe(MESSAGE);
  expect(commits - before).toBeLessThanOrEqual(MESSAGE.length + 5);
});
