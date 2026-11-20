// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  suggestions: [] as string[],
  composerHints: undefined as string[] | undefined,
  calls: [] as Array<{ path: string; body: unknown }>,
  loadingLatest: false,
  previewStatus: "none" as "none" | "starting" | "live",
}));

vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({
    userEmail: "founder@example.com",
    openTab: vi.fn(),
    tabs: [{ id: "tab-build", payload: { kind: "build", sessionId: "s1" } }],
    setTabThreadId: vi.fn(),
  }),
}));
vi.mock("./home/calm/HomeChatPanel", () => ({
  HomeChatPanel: (p: { suggestions: string[]; composerHints?: string[] }) => {
    h.suggestions = p.suggestions;
    h.composerHints = p.composerHints;
    return <aside aria-label="Chat" />;
  },
}));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: (p: { liveUrl: string | null; body?: React.ReactNode }) => (
    <div data-testid="website-preview" data-live-url={p.liveUrl ?? ""}>
      {p.body}
    </div>
  ),
  AppStartingScreen: (p: { state: string }) => <div data-testid="app-starting" data-state={p.state}>Loading your app…</div>,
  chatEditErrorMessage: () => "",
}));
vi.mock("./website/WebsiteConsole", () => ({ WebsiteConsole: () => null }));
vi.mock("./build/BuildHistoryPanel", () => ({ BuildHistoryPanel: () => null }));
vi.mock("./build/AppCodePane", () => ({ AppCodePane: () => null, ReadOnlyBadge: () => null }));
vi.mock("./build/BuildFilesPane", () => ({ BuildFilesPane: () => null }));
vi.mock("./website/PublishPopover", () => ({ PublishPopover: () => null }));
vi.mock("./home/summaryState", () => ({ loadSummary: () => Promise.resolve(null) }));
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
  isTerminalBuildRun: (status: string) => status !== "running",
}));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({ useOptimisticBuildStart: () => false }));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  useBuildSession: () => ({
    loaded: true,
    run: { id: "s1", status: "done" },
    isCurrent: true,
    retired: false,
    refines: [],
    refinesLoaded: true,
    cancelRun: vi.fn(async () => null),
    stopping: false,
  }),
}));
vi.mock("@/lib/workspace/useLiveEdit", () => ({
  useLiveEdit: () => ({
    state: {
      enabled: true,
      refine_active: false,
      preview: { status: h.previewStatus, url: null },
      draft: { exists: true, ahead_by: 3, behind_by: 0, head_sha: "b".repeat(40), changes: [] },
    },
    known: "on",
    frameUrl: null,
    loadingLatest: h.loadingLatest,
    resolveEnabled: async () => true,
    refresh: vi.fn(),
    publish: vi.fn(),
    discard: vi.fn(),
    wake: vi.fn(),
  }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {} } }));
vi.mock("@/lib/api", () => ({
  apiUrl: (path: string) => `http://api.test${path}`,
  apiFetch: (path: string, init?: RequestInit) => {
    h.calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body =
      path === "/api/workspace/website/chat"
        ? { route: "app_edit_inline" }
        : path === "/api/connectors/product-url"
          ? { product_url: {} }
          : { resources: [] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  },
}));

import { AppWorkspace } from "./WebsiteTab";
import {
  WEBSITE_BUILD_SUGGESTIONS,
  WEBSITE_COMPOSER_HINTS,
  resetWebsiteFramingForTests,
} from "@/lib/workspace/buildFraming";

const GROWTH_SUGGESTIONS = [
  "What did the team do this week?",
  "What needs my attention right now?",
  "Draft a short update for investors",
];

let framingAnswer: () => Promise<Response>;
const fetchMock = vi.fn((_url: string) => framingAnswer());

function framing(on: boolean) {
  framingAnswer = async () =>
    ({ ok: true, status: 200, json: async () => ({ website_framing: on }) }) as Response;
}

beforeEach(() => {
  h.calls.length = 0;
  h.suggestions = [];
  h.composerHints = undefined;
  h.loadingLatest = false;
  h.previewStatus = "none";
  resetWebsiteFramingForTests();
  fetchMock.mockClear();
  framing(true);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount(variant: "build" | "website" = "build") {
  render(<AppWorkspace variant={variant} appUrl="https://cakes.onrender.com" />);
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe("the Build chat speaks about the website, not growth", () => {
  it("offers website starter chips and website example prompts", async () => {
    await mount();
    expect(h.suggestions).toEqual(WEBSITE_BUILD_SUGGESTIONS);
    expect(h.composerHints).toEqual(WEBSITE_COMPOSER_HINTS);
    expect(h.suggestions.join(" ")).not.toMatch(/investor|team do this week|growth/i);
    expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/public/build-framing", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("keeps the old chips and prompts when the setting is off", async () => {
    framing(false);
    await mount();
    expect(h.suggestions).toEqual(GROWTH_SUGGESTIONS);
    expect(h.composerHints).toBeUndefined();
  });

  it("uses the website chips and prompts, the key's default, when the setting cannot be read", async () => {
    framingAnswer = async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response;
    await mount();
    expect(h.suggestions).toEqual(WEBSITE_BUILD_SUGGESTIONS);
    expect(h.composerHints).toEqual(WEBSITE_COMPOSER_HINTS);
  });

  it("leaves the Your Website tab alone and never reads the setting", async () => {
    await mount("website");
    expect(h.suggestions).toEqual(GROWTH_SUGGESTIONS);
    expect(h.composerHints).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
