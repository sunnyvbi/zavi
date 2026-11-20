// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

type ChatProps = {
  onRunCompleted?: (runId: string) => void;
  externalStop?: { ariaLabel: string };
};

const h = vi.hoisted(() => ({
  chat: null as ChatProps | null,
  refines: [] as unknown[],
  doneAt: "",
  calls: [] as string[],
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
  HomeChatPanel: (props: ChatProps) => {
    h.chat = props;
    return <aside aria-label="Chat" />;
  },
}));
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
    previewUrl: "https://lucky-paws.zavi.site",
    appReady: true,
    runStatus: "done",
    stages: [],
    failure: null,
    settledNonce: 0,
    classified: true,
    site: { hostname: "lucky-paws.zavi.site", liveUrl: "https://lucky-paws.zavi.site", status: "live" },
  }),
}));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({ useOptimisticBuildStart: () => false }));
vi.mock("@/lib/workspace/useBuildSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSessions")>()),
  useBuildSessions: () => ({ sessions: [], flags: undefined, uiFlags: undefined }),
  notifyBuildSessionsChanged: vi.fn(),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {} } }));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    h.calls.push(path);
    const body = path.includes("/autopilot/refines")
      ? { refines: h.refines }
      : path.includes("build-status")
        ? { run: { id: "s1", status: "done", updated_at: h.doneAt, created_at: h.doneAt } }
        : path === "/api/connectors/product-url"
          ? { product_url: {} }
          : { resources: [] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  },
}));

import { AppWorkspace } from "./WebsiteTab";
import { resetSharedBuildReads } from "@/lib/workspace/useBuildPreview";

const T0 = Date.parse("2026-10-13T10:00:00.000Z");
const MIN = 60_000;
const pinterestHeader = (status: string) => ({
  id: "refine-pinterest",
  message: "Add the header of Pinterest to our website",
  status,
  created_at: new Date(T0 + 5 * MIN).toISOString(),
});
const refineReads = () => h.calls.filter((p) => p.includes("/autopilot/refines")).length;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
  resetSharedBuildReads();
  h.chat = null;
  h.refines = [];
  h.calls = [];
  h.doneAt = new Date(T0 - 2 * 60 * MIN).toISOString();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a change Zavi starts from the Build chat on a site built long ago", () => {
  it("shows the change in progress once Zavi's reply lands, and keeps following it to the end", async () => {
    render(<AppWorkspace variant="build" appUrl="https://lucky-paws.zavi.site" />);
    await advance(0);
    expect(h.chat?.externalStop?.ariaLabel).not.toBe("Stop change");

    h.refines = [pinterestHeader("active")];
    await advance(5 * MIN);
    expect(h.chat?.externalStop?.ariaLabel).not.toBe("Stop change");
    const readsBeforeReply = refineReads();

    await act(async () => {
      h.chat?.onRunCompleted?.("operator-run-1");
    });
    await advance(0);
    expect(refineReads()).toBeGreaterThan(readsBeforeReply);
    expect(h.chat?.externalStop?.ariaLabel).toBe("Stop change");

    await advance(8_000);
    expect(h.chat?.externalStop?.ariaLabel).toBe("Stop change");

    h.refines = [pinterestHeader("done")];
    await advance(8_000);
    expect(h.chat?.externalStop?.ariaLabel).not.toBe("Stop change");

    const readsAfterDone = refineReads();
    await advance(20 * MIN);
    expect(refineReads()).toBe(readsAfterDone);
  });
});
