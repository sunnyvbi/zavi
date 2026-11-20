// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: { value: {} as Record<string, unknown> },
  build: { value: {} as Record<string, unknown> },
  continueRun: { fn: null as null | ((...a: unknown[]) => Promise<{ code: string; message: string } | null>) },
  reads: { productUrl: 0 },
  chatProps: { last: null as null | { sendBlockedNotice?: string | null } },
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
  WebsitePreview: (p: { headerActions?: React.ReactNode; body?: React.ReactNode }) => (
    <div>
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
let publishCalls: Deferred[] = [];

function reply(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

function wireApi() {
  publishCalls = [];
  h.api.fn = (path: string, init?: RequestInit) => {
    if (path === "/api/website/publish" && init?.method === "POST") {
      return new Promise((resolve) => publishCalls.push({ resolve }));
    }
    if (path.startsWith("/api/website/publish-status")) {
      return Promise.resolve(reply(200, { pending: 2, published: 1, last_published_at: null }));
    }
    if (path === "/api/website/builtin-url") {
      return Promise.resolve(
        reply(200, {
          builtin: { label: "bikes", hostname: "bikes.zaviagent.com", url: "https://bikes.zaviagent.com", status: "live" },
          base_domain: "zaviagent.com",
          custom_domain_attached: false,
        }),
      );
    }
    if (path === "/api/website/overview?app=workspace") return Promise.resolve(reply(200, { visibility: "public" }));
    if (path === "/api/connectors/product-url") return Promise.resolve(reply(200, { product_url: {} }));
    return Promise.resolve(reply(200, { resources: [] }));
  };
}

function publishPosts() {
  return publishCalls.length;
}

beforeEach(() => {
  wireApi();
  h.build.value = {
    loaded: true,
    classified: true,
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
    appReady: false,
    publish: { status: "live", startedAt: "2026-09-29T10:00:00Z", url: "https://bikes.onrender.com", retryable: false },
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

const dialog = () => screen.queryByRole("dialog", { name: "Publish your app" });

async function startPublish() {
  render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
  fireEvent.click(await screen.findByRole("button", { name: /^Publish$/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Publish changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
  await waitFor(() => expect(publishPosts()).toBe(1));
}

async function failPublish() {
  await act(async () => {
    publishCalls[0].resolve(reply(500, { error: { message: "Render said no." } }));
    await Promise.resolve();
  });
}

describe("Publish popover while a publish is in flight", () => {
  it("stays open through a window blur, then shows the failure", async () => {
    await startPublish();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(dialog()).not.toBeNull();
    await failPublish();
    expect((await screen.findByRole("alert")).textContent).toContain("Render said no.");
  });

  it("ignores Escape, an outside click and the trigger while publishing, so no second publish can start", async () => {
    await startPublish();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.body);
    fireEvent.click(screen.getByRole("button", { name: /^Publish$/ }));
    expect(dialog()).not.toBeNull();
    expect((screen.getByRole("button", { name: "Publishing…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Publish$/ }));
    expect(publishPosts()).toBe(1);
    await failPublish();
    expect((await screen.findByRole("alert")).textContent).toContain("Render said no.");
    expect(publishPosts()).toBe(1);
  });

  it("closes on blur again once the publish has finished", async () => {
    await startPublish();
    await failPublish();
    await screen.findByRole("alert");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(dialog()).toBeNull();
  });
});
