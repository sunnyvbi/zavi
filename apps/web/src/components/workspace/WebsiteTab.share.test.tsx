// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const h = vi.hoisted(() => ({
  session: { value: {} as Record<string, unknown> },
  build: { value: {} as Record<string, unknown> },
  continueRun: { fn: null as null | ((...a: unknown[]) => Promise<{ code: string; message: string } | null>) },
  reads: { productUrl: 0 },
  chatProps: { last: null as null | { sendBlockedNotice?: string | null } },
  ui: { mobileActions: true } as Record<string, boolean>,
}));

vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => ({
    loaded: true,
    currentSessionId: "s1",
    sessions: [],
    flags: { siteNames: false, siteRepoChip: false, siteListDetails: false },
    uiFlags: h.ui,
  }),
  notifyBuildSessionsChanged: () => {},
}));
vi.mock("./home/ExportToGithubButton", () => ({
  prefetchExportStatus: async () => undefined,
  ExportToGithubButton: () => <div data-testid="export-github" />,
}));

vi.mock("./WorkspaceShell", () => ({
  useWorkspaceOptional: () => ({ role: "owner", currentUserId: "u1", openTab: vi.fn() }),
  useWorkspace: () => ({
    userEmail: "founder@example.com",
    openTab: vi.fn(),
    tabs: [{ id: "tab-build", payload: { kind: "build", sessionId: "s1" } }],
    setTabThreadId: vi.fn(),
  }),
}));
vi.mock("./home/calm/HomeChatPanel", () => ({
  HomeChatPanel: (p: { sendBlockedNotice?: string | null; narrowTrailing?: React.ReactNode }) => {
    h.chatProps.last = p;
    return <aside aria-label="Chat">{p.narrowTrailing}</aside>;
  },
}));
vi.mock("./website/WebsitePreview", () => ({
  WebsitePreview: (p: { headerActions?: React.ReactNode; body?: React.ReactNode; narrowTrailing?: React.ReactNode }) => (
    <div data-testid="preview-pane">
      <div data-testid="preview-narrow">{p.narrowTrailing}</div>
      {p.headerActions}
      {p.body ? <div data-testid="progress-body">{p.body}</div> : null}
    </div>
  ),
  chatEditErrorMessage: () => "",
}));
vi.mock("./website/WebsiteConsole", () => ({ WebsiteConsole: () => <div data-testid="console" /> }));
vi.mock("./build/BuildHistoryPanel", () => ({ BuildHistoryPanel: () => null }));
vi.mock("./build/AppCodePane", () => ({ AppCodePane: () => null, ReadOnlyBadge: () => null }));
vi.mock("./build/BuildFilesPane", () => ({ BuildFilesPane: () => null }));
vi.mock("./website/PublishPopover", () => ({
  PublishPopover: () => <div data-testid="publish-popover" />,
}));
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
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    if (path === "/api/connectors/product-url") h.reads.productUrl += 1;
    if (path === "/api/v1/members") {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ members: [{ user_id: "u1", email: "founder@example.com", role: "owner", joined_at: null }] }) });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () =>
        path === "/api/connectors/product-url"
          ? { product_url: {} }
          : {
              resources: [
                { resource_kind: "domain", status: "ready", external_ref: { status: "live", hostname: "bikes.zaviagent.com" } },
                { resource_kind: "hosting", status: "ready", external_ref: { url: "https://bikes.onrender.com" } },
                { resource_kind: "repo", status: "ready", mode: "provisioned", external_ref: { html_url: "https://github.com/Praxis-build/bikes" } },
              ],
            },
    });
  },
}));

import { AppWorkspace } from "./WebsiteTab";

const SHARE_DIALOG = "Invite to your workspace";

function setBuild(runStatus: string, previewUrl: string | null) {
  h.build.value = {
    loaded: true,
    classified: true,
    building: runStatus === "active",
    runStatus,
    runId: "s1",
    objective: "Build product: bikes",
    stages: [],
    createdAt: null,
    updatedAt: null,
    previewUrl,
    previewKind: previewUrl ? "final" : "none",
    failure: null,
    appReady: runStatus === "done",
    publish: { status: runStatus === "done" ? "live" : "none", startedAt: null, url: null, retryable: false },
    settledNonce: 0,
  };
  h.session.value = {
    loaded: true,
    run: { id: "s1", status: runStatus },
    isCurrent: true,
    retired: false,
    refines: [],
    refinesLoaded: true,
    cancelRun: vi.fn(async () => null),
    stopping: false,
    continueRun: vi.fn(async () => null),
    continuing: false,
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  h.ui = {};
  setBuild("done", "https://bikes.onrender.com");
  window.history.replaceState(null, "", "/workspace?tab=build");
});
afterEach(() => cleanup());

describe("Build Share", () => {
  it("Build's header has Share beside Publish, and it opens the workspace invite with the people, not a site link", async () => {
    render(<AppWorkspace variant="build" />);
    await flush();
    const pane = screen.getByTestId("preview-pane");
    const share = within(pane).getByRole("button", { name: "Share" });
    expect(share.parentElement!.nextElementSibling?.textContent).toContain("Publish");
    fireEvent.click(share);
    await flush();
    const dialog = within(pane).getByRole("dialog", { name: SHARE_DIALOG });
    expect(within(dialog).getByText("founder@example.com")).toBeTruthy();
    expect(within(dialog).getByText("(You)")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Copy|Publish/ })).toBeNull();
    expect(within(dialog).queryByText(/bikes\.zaviagent\.com|shareable link/)).toBeNull();
  });

  it("on a phone Share sits next to the actions menu so it is never hidden with the desktop bar", async () => {
    h.ui = { mobileActions: true };
    render(<AppWorkspace variant="build" />);
    await flush();
    const chat = screen.getByRole("complementary", { name: "Chat" });
    expect(within(chat).getByRole("button", { name: "Share" })).toBeTruthy();
  });

  it("opening Share from the keyboard closes an open Publish, and opening Publish closes Share", async () => {
    render(<AppWorkspace variant="build" />);
    await flush();
    const pane = screen.getByTestId("preview-pane");
    const publish = within(pane).getByRole("button", { name: "Publish" });
    fireEvent.click(publish);
    await flush();
    expect(within(pane).getByTestId("publish-popover")).toBeTruthy();

    fireEvent.click(within(pane).getByRole("button", { name: "Share" }));
    await flush();
    expect(within(pane).getByRole("dialog", { name: SHARE_DIALOG })).toBeTruthy();
    expect(within(pane).queryByTestId("publish-popover")).toBeNull();

    fireEvent.click(publish);
    await flush();
    expect(within(pane).getByTestId("publish-popover")).toBeTruthy();
    expect(within(pane).queryByRole("dialog", { name: SHARE_DIALOG })).toBeNull();
    expect(within(pane).getByRole("button", { name: "Share" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("Share takes focus when it opens and hands it back to the trigger on Escape", async () => {
    render(<AppWorkspace variant="build" />);
    await flush();
    const pane = screen.getByTestId("preview-pane");
    const share = within(pane).getByRole("button", { name: "Share" });
    share.focus();
    fireEvent.keyDown(share, { key: "Enter" });
    fireEvent.click(share);
    await flush();
    const dialog = within(pane).getByRole("dialog", { name: SHARE_DIALOG });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(within(pane).queryByRole("dialog", { name: SHARE_DIALOG })).toBeNull();
    expect(document.activeElement).toBe(share);
  });

  it("on a phone, tapping Share closes the Publish sheet instead of stacking on top of it", async () => {
    h.ui = { mobileActions: true };
    render(<AppWorkspace variant="build" />);
    await flush();
    const chat = screen.getByRole("complementary", { name: "Chat" });
    fireEvent.click(within(chat).getByRole("button", { name: "More actions" }));
    fireEvent.click(within(within(chat).getByRole("menu", { name: "More actions" })).getByRole("menuitem", { name: "Publish" }));
    await flush();
    expect(within(screen.getByTestId("build-mobile-sheet")).getByTestId("publish-popover")).toBeTruthy();

    fireEvent.click(within(chat).getByRole("button", { name: "Share" }));
    await flush();
    const dialogs = screen.getAllByRole("dialog", { name: SHARE_DIALOG });
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.parentElement!.className.split(/\s+/)).toContain("relative");
    expect(screen.queryByTestId("build-mobile-sheet")).toBeNull();
    expect(screen.queryByTestId("publish-popover")).toBeNull();
  });

  it("on a phone, Share and More actions never stack, whichever opens second and however it is opened", async () => {
    h.ui = { mobileActions: true };
    render(<AppWorkspace variant="build" />);
    await flush();
    const chat = screen.getByRole("complementary", { name: "Chat" });
    const more = within(chat).getByRole("button", { name: "More actions" });
    const share = within(chat).getByRole("button", { name: "Share" });

    fireEvent.click(more);
    await flush();
    expect(within(chat).getByRole("menu", { name: "More actions" })).toBeTruthy();
    fireEvent.click(share);
    await flush();
    expect(within(chat).getByRole("dialog", { name: SHARE_DIALOG })).toBeTruthy();
    expect(within(chat).queryByRole("menu", { name: "More actions" })).toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(more);
    await flush();
    expect(within(chat).getByRole("menu", { name: "More actions" })).toBeTruthy();
    expect(within(chat).queryByRole("dialog", { name: SHARE_DIALOG })).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    await flush();
    expect(within(chat).queryByRole("menu", { name: "More actions" })).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("the Website tab, which is not a build, has no Share", async () => {
    render(<AppWorkspace variant="website" />);
    await flush();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });
});
