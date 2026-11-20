// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";

type BeforeSend = (message: string) => Promise<{ handled: boolean; system?: string }>;

const h = vi.hoisted(() => ({
  onBeforeSend: null as null | ((message: string) => Promise<{ handled: boolean; system?: string }>),
  resolveEnabled: null as null | (() => Promise<boolean>),
  calls: [] as Array<{ path: string; body: unknown }>,
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
  HomeChatPanel: (p: { onBeforeSend?: BeforeSend }) => {
    h.onBeforeSend = p.onBeforeSend ?? null;
    return <aside aria-label="Chat" />;
  },
}));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: () => <div />,
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
      enabled: false,
      refine_active: false,
      preview: { status: "none", url: null },
      draft: { ahead_by: 0, behind_by: 0, changes: [] },
    },
    known: "unknown",
    frameUrl: null,
    resolveEnabled: () => h.resolveEnabled!(),
    refresh: vi.fn(),
    publish: vi.fn(),
    discard: vi.fn(),
    wake: vi.fn(),
  }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {} } }));
vi.mock("@/lib/api", () => ({
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
import { usePreviewErrorGate } from "./website/previewErrorGate";
import { BUILD_REFINE_PENDING_EVENT } from "@/lib/workspace/useBuildSession";

const refineCalls = () => h.calls.filter((c) => c.path === "/api/workspace/autopilot/refine-product");

async function send(message: string) {
  let out: { handled: boolean; system?: string } | undefined;
  await act(async () => {
    out = await h.onBeforeSend!(message);
  });
  return out!;
}

beforeEach(() => {
  h.onBeforeSend = null;
  h.resolveEnabled = null;
  h.calls.length = 0;
});
afterEach(() => cleanup());

describe("the old in-preview edit route is gone (the classifier never sends it)", () => {
  it("Fix error announces its message immediately through the actual preview gate", async () => {
    h.resolveEnabled = async () => true;
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    const gate = renderHook(() => usePreviewErrorGate());
    const seen: Array<{ refine: { message: string } | null }> = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener(BUILD_REFINE_PENDING_EVENT, listener);
    try {
      let request!: ReturnType<NonNullable<typeof gate.result.current>["fix"]>;
      act(() => { request = gate.result.current!.fix("Fix this error in the preview: missing lucide-react"); });
      expect(seen[0].refine?.message).toBe("Fix this error in the preview: missing lucide-react");
      await act(async () => { await request; });
      expect(refineCalls()).toHaveLength(1);
      expect(h.calls.some((c) => c.path === "/api/workspace/website/chat")).toBe(false);
    } finally { window.removeEventListener(BUILD_REFINE_PENDING_EVENT, listener); }
  });
  it("an app_edit_inline answer starts no change and is passed to the normal chat", async () => {
    h.resolveEnabled = async () => true;
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await act(async () => {});
    const out = await send("make the header blue");
    expect(refineCalls()).toHaveLength(0);
    expect(out.handled).toBe(false);
  });
});
