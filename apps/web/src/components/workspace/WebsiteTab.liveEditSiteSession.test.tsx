// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  preview: {} as Record<string, unknown>,
  liveEditActive: [] as boolean[],
}));

vi.mock("./WorkspaceShell", () => ({
  useWorkspace: () => ({
    userEmail: "founder@example.com",
    openTab: vi.fn(),
    tabs: [{ id: "tab-build", payload: { kind: "build", sessionId: "s1" } }],
    setTabThreadId: vi.fn(),
  }),
}));
vi.mock("./home/calm/HomeChatPanel", () => ({ HomeChatPanel: () => <aside aria-label="Chat" /> }));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: () => <div />,
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
    ...h.preview,
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
  useLiveEdit: (active: boolean) => {
    h.liveEditActive.push(active);
    return {
      state: {
        enabled: false,
        refine_active: false,
        preview: { status: "none", url: null },
        draft: { ahead_by: 0, behind_by: 0, changes: [] },
      },
      known: "unknown",
      frameUrl: null,
      resolveEnabled: async () => false,
      refresh: vi.fn(),
      publish: vi.fn(),
      discard: vi.fn(),
      wake: vi.fn(),
    };
  },
}));
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {} } }));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    const body = path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [] };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  },
}));

import { AppWorkspace } from "./WebsiteTab";

beforeEach(() => {
  h.liveEditActive.length = 0;
});
afterEach(() => cleanup());

describe("live edit only runs for the singleton (old-flow) app", () => {
  it("a site session never turns live edit on", async () => {
    h.preview = { classified: true, site: { hostname: "lucky-paws.zavi.site", liveUrl: null, status: "failed" } };
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await act(async () => {});
    expect(h.liveEditActive.length).toBeGreaterThan(0);
    expect(h.liveEditActive.every((a) => a === false)).toBe(true);
  });

  it("an old-flow session turns it on once the session is classified", async () => {
    h.preview = { classified: true, site: null };
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await act(async () => {});
    expect(h.liveEditActive.at(-1)).toBe(true);
  });

  it("an unclassified session waits instead of guessing which app it is", async () => {
    h.preview = { classified: false, site: null };
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await act(async () => {});
    expect(h.liveEditActive.every((a) => a === false)).toBe(true);
  });
});
