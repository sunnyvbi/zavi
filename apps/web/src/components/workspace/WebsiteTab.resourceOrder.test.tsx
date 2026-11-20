// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";

function FrameProbe({ url }: { url: string | null }) {
  useLayoutEffect(() => {
    h.frames.push(url);
  });
  return null;
}

const h = vi.hoisted(() => ({
  session: { value: {} as Record<string, unknown> },
  build: { value: {} as Record<string, unknown> },
  continueRun: { fn: null as null | ((...a: unknown[]) => Promise<{ code: string; message: string } | null>) },
  reads: { productUrl: 0 },
  chatProps: { last: null as null | { sendBlockedNotice?: string | null } },
  frames: [] as Array<string | null>,
  api: { fn: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as (path: string, init?: RequestInit) => Promise<unknown> },
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
  HomeChatPanel: (p: { sendBlockedNotice?: string | null }) => {
    h.chatProps.last = p;
    return <aside aria-label="Chat" />;
  },
}));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: (p: { headerActions?: React.ReactNode; body?: React.ReactNode; liveUrl?: string | null }) => (
    <div data-live-url={p.liveUrl ?? ""}>
      <FrameProbe url={p.liveUrl ?? null} />
      {p.headerActions}
      {p.body ? <div data-testid="progress-body">{p.body}</div> : null}
    </div>
  ),
  chatEditErrorMessage: () => "",
}));
vi.mock("./website/WebsiteConsole", () => ({ WebsiteConsole: () => null }));
vi.mock("./build/BuildHistoryPanel", () => ({ BuildHistoryPanel: () => null }));
vi.mock("./build/AppCodePane", () => ({ AppCodePane: () => null, ReadOnlyBadge: () => null }));
vi.mock("./build/BuildFilesPane", () => ({ BuildFilesPane: () => null }));
vi.mock("./home/summaryState", () => ({ loadSummary: () => Promise.resolve(null) }));
vi.mock("@/lib/workspace/useBuildPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildPreview")>()),
  useBuildPreview: () => h.build.value,
  isTerminalBuildRun: (status: string | null) =>
    status === "done" || status === "failed" || status === "paused",
}));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({ useOptimisticBuildStart: () => false }));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  useBuildSession: () => h.session.value,
}));
vi.mock("@/lib/workspace/useLiveEdit", () => ({
  useLiveEdit: () => ({
    state: {
      enabled: false,
      refine_active: false,
      preview: { status: "idle", url: null },
      draft: { ahead_by: 0, behind_by: 0, changes: [] },
    },
    frameUrl: null,
    refresh: vi.fn(),
    publish: vi.fn(),
    discard: vi.fn(),
    wake: vi.fn(),
  }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {} } }));
vi.mock("@/lib/api", () => ({ apiFetch: (path: string, init?: RequestInit) => h.api.fn(path, init) }));

import { AppWorkspace } from "./WebsiteTab";

type Deferred = { resolve: (r: unknown) => void };
let autopilotCalls: Deferred[] = [];
let productCalls: Deferred[] = [];

const OLD = "https://old-bikes.onrender.com";
const NEW = "https://bikes.zaviagent.com";

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

function hostingAt(url: string) {
  return { resources: [{ resource_kind: "hosting", status: "ready", external_ref: { url } }] };
}

function builtinAt(hostname: string) {
  return {
    resources: [
      { resource_kind: "hosting", status: "ready", external_ref: { url: OLD } },
      { resource_kind: "domain", status: "ready", external_ref: { status: "live", hostname } },
    ],
  };
}

function wireApi() {
  autopilotCalls = [];
  productCalls = [];
  h.api.fn = (path: string) => {
    if (path === "/api/workspace/autopilot") return new Promise((resolve) => autopilotCalls.push({ resolve }));
    if (path === "/api/connectors/product-url") return new Promise((resolve) => productCalls.push({ resolve }));
    if (path.startsWith("/api/website/publish-status")) {
      return Promise.resolve(reply(200, { pending: 0, published: 0, last_published_at: null }));
    }
    return Promise.resolve(reply(200, {}));
  };
}

async function settle(call: Deferred, status: number, body: unknown) {
  await act(async () => {
    call.resolve(reply(status, body));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function shownUrl() {
  return h.frames[h.frames.length - 1] ?? null;
}

beforeEach(() => {
  wireApi();
  h.frames = [];
  h.build.value = {
    loaded: true,
    building: false,
    runStatus: "done",
    runId: "s1",
    objective: "Build product: bikes",
    stages: [],
    createdAt: null,
    updatedAt: null,
    previewUrl: null,
    previewKind: "final",
    failure: null,
    appReady: true,
    publish: null,
    settledNonce: 0,
  };
  h.session.value = {
    loaded: true,
    run: { id: "s1", status: "done" },
    isCurrent: true,
    retired: false,
    refines: [],
    refinesLoaded: true,
    cancelRun: vi.fn(async () => null),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
  };
});
afterEach(() => cleanup());

async function mountWithPendingReads(variant: "build" | "website" = "build") {
  const view = render(<AppWorkspace variant={variant} />);
  await waitFor(() => expect(autopilotCalls.length).toBeGreaterThanOrEqual(1));
  const mountReads = autopilotCalls.length;
  h.build.value = { ...h.build.value, settledNonce: 1 };
  view.rerender(<AppWorkspace variant={variant} />);
  await waitFor(() => expect(autopilotCalls.length).toBe(mountReads + 1));
  return { mountReads, latest: autopilotCalls[mountReads] };
}

describe("resource refreshes apply in request order", () => {
  it("a slow mount read that lands after the post-build read never puts the old URL back", async () => {
    const { mountReads, latest } = await mountWithPendingReads();
    await settle(productCalls[1], 200, { product_url: {} });
    await settle(latest, 200, builtinAt("bikes.zaviagent.com"));
    await waitFor(() => expect(shownUrl()).toBe(NEW));
    const framesAfterNew = h.frames.length;
    for (let i = 0; i < mountReads; i += 1) await settle(autopilotCalls[i], 200, hostingAt(OLD));
    expect(shownUrl()).toBe(NEW);
    expect(h.frames.slice(framesAfterNew - 1)).not.toContain(OLD);
  });

  it("a slow product-url read from mount does not overwrite the post-build one", async () => {
    const { latest } = await mountWithPendingReads("website");
    expect(productCalls.length).toBe(2);
    await settle(productCalls[1], 200, { product_url: { marketing: "https://acme.com" } });
    await settle(latest, 200, { resources: [] });
    await settle(productCalls[0], 200, { product_url: { marketing: "https://old-acme.com" } });
    await waitFor(() => expect(h.frames.length).toBeGreaterThan(0));
    expect(shownUrl()).toBe("https://acme.com");
    expect(h.frames).not.toContain("https://old-acme.com");
  });

  it("an older read still lands when the newer one failed", async () => {
    const { mountReads, latest } = await mountWithPendingReads();
    await settle(productCalls[productCalls.length - 1], 200, { product_url: {} });
    await settle(latest, 500, {});
    await settle(autopilotCalls[mountReads - 1], 200, hostingAt(OLD));
    await waitFor(() => expect(shownUrl()).toBe(OLD));
  });
});
