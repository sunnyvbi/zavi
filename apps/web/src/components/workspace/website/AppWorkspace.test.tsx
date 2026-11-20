// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    userEmail: "founder@example.com",
    openTab: openTab,
    tabs: workspaceTabs,
    setTabThreadId: setTabThreadId,
  }),
}));
vi.mock("../home/calm/HomeChatPanel", () => ({
  HomeChatPanel: (p: {
    narrowLeading?: React.ReactNode;
    narrowTrailing?: React.ReactNode;
    title?: React.ReactNode;
    initialThreadId?: string | null;
    onThreadChange?: (id: string | null) => void;
    headerActions?: React.ReactNode;
    hidden?: boolean;
    overlay?: React.ReactNode;
    composerSeed?: { text: string; nonce: number; files?: Array<{ name: string; url: string }> };
    composerSuggestions?: Array<{ key: string; label: string; prompt: string }>;
    onBuildSuggestionSend?: (message: string) => Promise<{ handled: boolean; system?: string; consumed?: boolean }>;
    externalStop?: { ariaLabel: string; onStop: () => Promise<string | null> };
  }) => {
    panelProps = p;
    return (
      <aside aria-label="Chat with your team" data-hidden={String(!!p.hidden)}>
        <div data-testid="chat-header">{p.headerActions}</div>
        {p.overlay}
        {p.narrowLeading}
        {p.narrowTrailing}
        <div data-testid="chat-title">{p.title}</div>
        <div data-testid="chat-thread">
          {p.initialThreadId === undefined ? "resolve-latest" : String(p.initialThreadId)}
        </div>
        <textarea />
      </aside>
    );
  },
}));
vi.mock("./WebsitePreview", () => ({
  WebsitePreview: (p: {
    liveUrl: string | null;
    headerActions?: React.ReactNode;
    narrowLeading?: React.ReactNode;
    narrowTrailing?: React.ReactNode;
    leading?: React.ReactNode;
    editPlacement?: string;
    cacheKey?: string | null;
    chromeOverride?: React.ReactNode;
    appId?: string | null;
    builtApp?: boolean;
    body?: React.ReactNode;
    keepPreviewCookie?: boolean;
  }) => {
    return (
    <div data-testid="preview-bar" data-keep-cookie={String(!!p.keepPreviewCookie)} data-edit={p.editPlacement} data-cache={p.cacheKey ?? ""} data-app={p.appId ?? ""} data-built={String(!!p.builtApp)}>
      {p.chromeOverride ?? (
        <>
          {p.narrowLeading}
          {p.leading}
          {p.narrowTrailing}
          {p.headerActions}
        </>
      )}
      {p.body ?? <div data-testid="preview">{p.liveUrl}</div>}
    </div>
    );
  },
  chatEditErrorMessage: () => "",
}));
vi.mock("./WebsiteConsole", () => ({ WebsiteConsole: () => <div>console</div> }));
let pickedUrl: string | null = "https://pr-12.preview.example";
let pickedRestorable = true;
vi.mock("../build/BuildHistoryPanel", () => ({
  BuildHistoryPanel: (p: {
    sessionId: string | null;
    liveUrl?: string | null;
    selectedId?: string | null;
    onSelect?: (v: { id: string; title: string; url: string | null; restorable: boolean }) => void;
    onClose: () => void;
  }) => (
    <section aria-label="Build history">
      <span data-testid="history-session">{p.sessionId}</span>
      <span data-testid="history-live">{p.liveUrl ?? ""}</span>
      <span data-testid="history-selected">{p.selectedId ?? ""}</span>
      <button type="button" onClick={() => p.onSelect?.({ id: "r1", title: "Darker hero", url: pickedUrl, restorable: pickedRestorable })}>
        Pick version
      </button>
      <button type="button" onClick={p.onClose}>
        Close history
      </button>
    </section>
  ),
}));
vi.mock("../build/AppCodePane", () => ({
  AppCodePane: (p: { active?: boolean }) => <div data-testid="code-pane" data-active={String(p.active)} />,
  ReadOnlyBadge: () => <button type="button">Read only</button>,
}));
vi.mock("../build/BuildFilesPane", () => ({
  BuildFilesPane: (p: { onUseOnSite: (files: Array<{ name: string; url: string }>) => void; active?: boolean }) => (
    <div data-testid="files-pane" data-active={String(p.active)}>
      <button type="button" onClick={() => p.onUseOnSite([{ name: "hero.png", url: "https://cdn.test/hero.png" }])}>
        Use on site
      </button>
    </div>
  ),
}));
vi.mock("./PublishPopover", () => ({
  PublishPopover: (p: { publishable: boolean; appUrl: string | null }) => (
    <div data-testid="publish-popover" data-publishable={String(p.publishable)} data-app-url={p.appUrl ?? ""}>
      publish
    </div>
  ),
}));
vi.mock("../home/summaryState", () => ({ loadSummary: () => Promise.resolve(null) }));
const buildPreviewState = vi.hoisted(() => ({
  value: {
    building: false,
    loaded: true,
    previewUrl: null as string | null,
    runStatus: "done",
    stages: [] as Array<{ stage: string; status: string }>,
    failure: null,
    settledNonce: 0,
  },
}));
const buildSessionState = vi.hoisted(() => ({
  value: {
    run: null,
    refines: [] as Array<{ id: string; status: string }>,
    cancelRun: vi.fn(async () => null as string | null),
    stopping: false,
  } as Record<string, unknown>,
}));
const startBuildRefineMock = vi.hoisted(() => vi.fn(async () => null));
const liveEditFlag = vi.hoisted(() => ({ enabled: false, served: 0 }));
vi.mock("@/lib/workspace/useBuildPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildPreview")>()),
  useBuildPreview: () => buildPreviewState.value,
  isTerminalBuildRun: (status: string) => status !== "running",
}));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({ useOptimisticBuildStart: () => false }));
vi.mock("@/lib/workspace/useBuildSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/useBuildSession")>()),
  useBuildSession: () => buildSessionState.value,
  startBuildRefine: startBuildRefineMock,
}));

const openTab = vi.fn();

const setTabThreadId = vi.fn();
let workspaceTabs: { id: string; payload: Record<string, unknown> }[] = [];
let panelProps: {
  onThreadChange?: (id: string | null) => void;
  composerSeed?: { text: string; nonce: number; files?: Array<{ name: string; url: string }> };
  composerSuggestions?: Array<{ key: string; label: string; prompt: string }>;
  onBuildSuggestionSend?: (message: string) => Promise<{ handled: boolean; system?: string; consumed?: boolean }>;
  externalStop?: { ariaLabel: string; onStop: () => Promise<string | null> };
} = {};
const buildTab = (threadId?: string | null) => [
  { id: "tab-build", payload: { kind: "build", sessionId: "s1", ...(threadId === undefined ? {} : { threadId }) } },
];
let resources: unknown[] = [];
let marketing: string | undefined;
let buildChips: Array<{ key: string; label: string; prompt: string }> = [];
let chipsGate: Promise<void> | null = null;
const posted: Array<{ path: string; body: unknown }> = [];
const fetchedPaths: string[] = [];
let chatReply: () => Promise<unknown> = async () => ({ ok: true, status: 200, json: async () => ({ route: "operator" }) });
let restoreReply: { ok: boolean; body: unknown } = { ok: true, body: { ok: true, noop: false } };
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, init?: RequestInit) => {
    fetchedPaths.push(path);
    if (init?.method === "POST") {
      posted.push({ path, body: init.body ? JSON.parse(String(init.body)) : null });
      if (path === "/api/workspace/autopilot/restore-checkpoint") {
        return Promise.resolve({ ok: restoreReply.ok, status: restoreReply.ok ? 200 : 409, json: async () => restoreReply.body });
      }
      if (path === "/api/workspace/website/chat") {
        return chatReply();
      }
      if (path === "/api/workspace/autopilot/version-preview") {
        return Promise.resolve({ ok: true, status: 202, json: async () => versionJob });
      }
    }
    if (path.startsWith("/api/workspace/autopilot/version-preview?")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => versionJob });
    }
    if (path.startsWith("/api/workspace/autopilot/restore-status?")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: restoreState }) });
    }
    if (path === "/api/workspace/autopilot/live-edit") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          enabled: (liveEditFlag.served++, liveEditFlag.enabled),
          draft: { exists: false, ahead_by: 0, behind_by: 0, head_sha: null, changes: [] },
          preview: { status: "none", url: null },
          refine_active: false,
        }),
      });
    }
    if (path.startsWith("/api/workspace/autopilot/chips?session_id=")) {
      return (chipsGate ?? Promise.resolve()).then(() => ({ ok: true, status: 200, json: async () => ({ chips: buildChips }) }));
    }
    return Promise.resolve({
      ok: true,
      json: async () =>
        path === "/api/connectors/product-url"
          ? { product_url: marketing ? { marketing } : {} }
          : { resources },
    });
  },
}));
const toastAdd = vi.fn(() => "toast-1");
const toastUpdate = vi.fn();
const toastClose = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  toast: {
    add: (...a: unknown[]) => toastAdd(...(a as [])),
    update: (...a: unknown[]) => toastUpdate(...(a as [])),
    close: (...a: unknown[]) => toastClose(...(a as [])),
  },
}));
const watchSleep = vi.hoisted(() => ({ fn: null as null | ((ms: number) => Promise<void>) }));
const confirmActionMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/components/ui/ConfirmDialog", () => ({
  confirmAction: (...a: unknown[]) => confirmActionMock(...(a as [])),
}));
vi.mock("@/lib/workspace/restoreDeploy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspace/restoreDeploy")>();
  return {
    ...actual,
    watchRestoreDeploy: (args: Parameters<typeof actual.watchRestoreDeploy>[0]) =>
      actual.watchRestoreDeploy({ ...args, sleep: watchSleep.fn ?? (async () => {}) }),
  };
});
let versionJob: { status: string; url?: string | null; error?: string | null } = { status: "starting" };
let restoreState = "live";

import { AppWorkspace } from "../WebsiteTab";
import { __resetVersionPreviewCache } from "@/lib/workspace/useVersionPreview";

const repo = (url: string) => ({ resource_kind: "repo", status: "ready", external_ref: { html_url: url } });
const hosting = (url: string) => ({ resource_kind: "hosting", status: "ready", external_ref: { url } });

beforeEach(() => {
  __resetVersionPreviewCache();
  resources = [];
  marketing = undefined;
  buildChips = [];
  posted.length = 0;
  pickedUrl = "https://pr-12.preview.example";
  pickedRestorable = true;
  restoreReply = { ok: true, body: { ok: true, noop: false, new_commit_sha: "9999567890aaaa567890aaaa567890aaaa567890" } };
  versionJob = { status: "starting" };
  restoreState = "live";
  toastAdd.mockClear();
  toastUpdate.mockClear();
  toastClose.mockClear();
  fetchedPaths.length = 0;
  workspaceTabs = buildTab();
  panelProps = {};
  buildSessionState.value = {
    run: null,
    refines: [],
    cancelRun: vi.fn(async () => null),
    stopping: false,
  };
  setTabThreadId.mockReset();
  startBuildRefineMock.mockReset();
  startBuildRefineMock.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  openTab.mockReset();
});

describe("the Website tab (website variant)", () => {
  it("keeps Back to Home and has no Build log", () => {
    render(<AppWorkspace />);
    expect(screen.getByRole("button", { name: "Back to Home" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Build log/ })).toBeNull();
  });

  it("still opens the repo, even a Zavi-hosted one", async () => {
    resources = [repo("https://github.com/Praxis-build/acme")];
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<AppWorkspace />);
    const button = await screen.findByRole("button", { name: "GitHub repository" });
    await vi.waitFor(() => {
      fireEvent.click(button);
      expect(open).toHaveBeenCalledWith("https://github.com/Praxis-build/acme", "_blank", "noopener,noreferrer");
    });
  });

  it("frames the tenant's own registered site first", async () => {
    marketing = "https://own.example";
    resources = [hosting("https://acme.onrender.com")];
    render(<AppWorkspace />);
    await vi.waitFor(() => expect(screen.getByTestId("preview").textContent).toBe("https://own.example"));
  });

  it("leaves the naming out of the preview bar", async () => {
    marketing = "https://www.acme.dev/pricing";
    render(<AppWorkspace />);
    await screen.findByTestId("preview");
    expect(screen.queryByTestId("preview-name")).toBeNull();
  });

  it("opens with a card's Send to Zavi change in the chat box, unsent, and only once", async () => {
    const draft = "Make this change on my website: Add the sitemap to robots.txt\n\nLine to add:\n\nSitemap: https://acme.test/sitemap.xml";
    window.sessionStorage.setItem("zavi.websiteChatDraft", draft);
    render(<AppWorkspace />);
    await waitFor(() => expect(panelProps.composerSeed?.text).toBe(draft));
    expect(window.sessionStorage.getItem("zavi.websiteChatDraft")).toBeNull();
    expect(posted.filter((p) => p.path.includes("refine") || p.path.includes("/chat"))).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Chat with your team" }).querySelector("textarea")));
    cleanup();
    panelProps = {};
    render(<AppWorkspace />);
    expect(panelProps.composerSeed).toBeUndefined();
  });

  it("the Build tab leaves a Send to Zavi change for the Website tab", () => {
    window.sessionStorage.setItem("zavi.websiteChatDraft", "Make this change on my website: X");
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    expect(panelProps.composerSeed).toBeUndefined();
    expect(window.sessionStorage.getItem("zavi.websiteChatDraft")).toBe("Make this change on my website: X");
    window.sessionStorage.clear();
  });
});

describe("the Build tab (build variant)", () => {
  it("a finished build with a preview shows no suggestion row and never asks for suggestions", async () => {
    buildChips = [{ key: "bike-fleet", label: "Add fleet cards", prompt: "Add a fleet section." }];
    buildSessionState.value = {
      loaded: true,
      run: { id: "s1", status: "done" },
      isCurrent: true,
      retired: false,
      refines: [],
      cancelRun: vi.fn(async () => null),
      stopping: false,
    };
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(panelProps.composerSuggestions).toBeUndefined();
    expect((panelProps as { composerSuggestionsLoading?: boolean }).composerSuggestionsLoading).toBeFalsy();
    expect((panelProps as { onMoreSuggestions?: unknown }).onMoreSuggestions).toBeUndefined();
    expect(fetchedPaths.some((p) => p.startsWith("/api/workspace/autopilot/chips"))).toBe(false);
  });

  it("routes a generated suggestion straight into the active build instead of a new operator session", async () => {
    const prompt = "Create a pricing table or cards section showcasing different bike rental rates by duration (hourly, daily, weekly) with clear pricing and features included.";
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);

    const out = await panelProps.onBuildSuggestionSend?.(prompt);

    expect(startBuildRefineMock).toHaveBeenCalledWith("s1", prompt, { optimistic: false, selection: null });
    expect(out).toMatchObject({ handled: true, consumed: true });
    expect(posted.some((request) => request.path === "/api/workspace/website/chat")).toBe(false);
  });

  it("gives an active landing-page change to the Preview composer's Send-to-Stop slot", () => {
    buildSessionState.value = {
      run: null,
      refines: [{ id: "r-running", status: "running" }],
      cancelRun: vi.fn(async () => null),
      stopping: false,
    };
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    expect(panelProps.externalStop).toMatchObject({
      ariaLabel: "Stop change",
    });
  });

  it("asks before stopping a paid change from the Preview composer, and a decline cancels nothing", async () => {
    const cancelRun = vi.fn(async () => null);
    buildSessionState.value = {
      run: null,
      refines: [{ id: "r-running", status: "running" }],
      cancelRun,
      stopping: false,
    };
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);

    confirmActionMock.mockResolvedValueOnce(false);
    expect(await panelProps.externalStop?.onStop()).toBeNull();
    expect(confirmActionMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Stop this change?" }));
    expect(cancelRun).not.toHaveBeenCalled();

    confirmActionMock.mockResolvedValueOnce(true);
    await panelProps.externalStop?.onStop();
    expect(cancelRun).toHaveBeenCalledWith("r-running");
  });
  it("has no header row of its own — no back arrow, Build log or mode toggle", () => {
    const toggle = vi.fn();
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" onToggleBuildLog={toggle} />);
    expect(screen.queryByRole("button", { name: "Back to Home" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Build log/ })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Website view" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Dashboard" })).toBeNull();
    expect(toggle).not.toHaveBeenCalled();
  });

  it("carries Publish, Export and the app settings gear inside the preview bar", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    const bar = screen.getByTestId("preview-bar");
    expect(bar.contains(screen.getByRole("button", { name: "Publish" }))).toBe(true);
    expect(bar.contains(screen.getByRole("button", { name: "GitHub export" }))).toBe(true);
    const gear = screen.getByRole("button", { name: "App settings" });
    expect(bar.contains(gear)).toBe(true);
    expect(gear.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(gear.getAttribute("aria-pressed")).toBe("false");
  });

  it("orders the workspace tabs Preview, Files and Code, and opens on Preview", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual(["Preview", "Files", "Code"]);
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens the app's settings from the gear, in place, never a Settings tab away from the build", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    expect(screen.queryByText("console")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "App settings" }));

    expect(screen.getByText("console")).toBeTruthy();
    expect(screen.getByRole("region", { name: "App settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "More" })).toBeNull();
    expect(openTab).not.toHaveBeenCalled();
  });

  it("closes the settings back to the tab the founder was on, from the close button or any tab", () => {
    window.history.replaceState(null, "", "/workspace?tab=build&section=domains");
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    fireEvent.click(screen.getByRole("button", { name: "App settings" }));
    expect(screen.getByText("console")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByText("console")).toBeNull();
    expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("code-pane").closest("[hidden]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "App settings" }));
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.queryByText("console")).toBeNull();
    expect(screen.getByTestId("preview").textContent).toBe("https://acme.onrender.com");
    expect(new URLSearchParams(window.location.search).get("section")).toBeNull();
  });

  it("toggles the settings shut from the gear itself", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    const gear = screen.getByRole("button", { name: "App settings" });
    fireEvent.click(gear);
    expect(gear.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(gear);
    expect(screen.queryByText("console")).toBeNull();
    expect(gear.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the app frame mounted behind Files and Code so the app never reloads", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    const frame = screen.getByTestId("preview");

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.getByTestId("code-pane")).toBeTruthy();
    expect(screen.getByTestId("preview")).toBe(frame);
    expect(frame.closest(".hidden")).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByTestId("files-pane")).toBeTruthy();
    expect(screen.getByTestId("code-pane").closest("[hidden]")).not.toBeNull();
    expect(screen.getByTestId("preview")).toBe(frame);

    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByTestId("preview")).toBe(frame);
    expect(frame.closest(".hidden")).toBeNull();
  });

  it("seeds the chat from Files without sending, returns to Preview, brings chat back, and focuses it", async () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("button", { name: "Hide chat" }));
    const chat = () => screen.getByRole("complementary", { name: "Chat with your team" });
    expect(chat().getAttribute("data-hidden")).toBe("true");
    expect(panelProps.composerSeed).toBeUndefined();

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Use on site" }));

    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("preview").closest(".hidden")).toBeNull();
    expect(chat().getAttribute("data-hidden")).toBe("false");
    expect(panelProps.composerSeed?.text).toBe("");
    expect(panelProps.composerSeed?.files).toEqual([{ name: "hero.png", url: "https://cdn.test/hero.png" }]);
    const firstNonce = panelProps.composerSeed!.nonce;
    await waitFor(() => expect(document.activeElement).toBe(chat().querySelector("textarea")));

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(screen.getByRole("button", { name: "Use on site" }));
    expect(panelProps.composerSeed!.nonce).toBeGreaterThan(firstNonce);
  });

  it("moves between tabs with the arrow keys", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Preview" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Code" }));
    fireEvent.keyDown(screen.getByRole("tab", { name: "Code" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the very same tab bar mounted across every switch, so the pill can animate", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    const bar = screen.getByRole("tablist", { name: "App workspace" });
    const tab = screen.getByRole("tab", { name: "Files" });
    for (const name of ["Files", "Code", "settings", "Preview", "Code"]) {
      if (name === "settings") fireEvent.click(screen.getByRole("button", { name: "App settings" }));
      else fireEvent.click(screen.getByRole("tab", { name }));
      expect(screen.getByRole("tablist", { name: "App workspace" })).toBe(bar);
      expect(screen.getByRole("tab", { name: "Files" })).toBe(tab);
    }
  });

  it("keeps Code and Files mounted after the first visit so switching back keeps their state", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    expect(screen.queryByTestId("code-pane")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    const code = screen.getByTestId("code-pane");
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    const files = screen.getByTestId("files-pane");
    expect(code.isConnected).toBe(true);
    expect(code.closest("[hidden]")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.getByTestId("code-pane")).toBe(code);
    expect(code.closest("[hidden]")).toBeNull();
    expect(screen.getByTestId("files-pane")).toBe(files);
  });

  it("tells only the pane on screen that it is active, so a hidden one leaves Cmd+P alone", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    const code = screen.getByTestId("code-pane");
    expect(code.dataset.active).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(code.dataset.active).toBe("false");
    expect(screen.getByTestId("files-pane").dataset.active).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(code.dataset.active).toBe("false");
    expect(screen.getByTestId("files-pane").dataset.active).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "App settings" }));
    expect(code.dataset.active).toBe("false");
  });

  it("points each tab's aria-controls only at a panel that is actually in the page", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    const check = () => {
      for (const tab of screen.getAllByRole("tab")) {
        const target = tab.getAttribute("aria-controls");
        if (target) expect(document.getElementById(target)).not.toBeNull();
      }
    };
    check();
    expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-controls")).toBeNull();
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-controls")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    check();
    fireEvent.click(screen.getByRole("button", { name: "App settings" }));
    check();
    expect(screen.getByRole("tab", { name: "Code" }).getAttribute("aria-controls")).toBe("build-surface-code");
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    check();
  });

  it("puts the Read only badge at the far right of the Code header, not beside the title", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    const badge = screen.getByRole("button", { name: "Read only" });
    const title = screen.getByRole("heading", { name: "Code" });
    expect(title.parentElement!.contains(badge)).toBe(false);
    const end = badge.parentElement!;
    expect(end.className).toContain("justify-self-end");
    expect(end.lastElementChild).toBe(badge);
    expect(end.parentElement!.lastElementChild).toBe(end);
    expect(end.parentElement).toBe(title.parentElement!.parentElement);
  });

  it("renders exactly one tab bar whichever tab is open", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    for (const name of ["Files", "Code", "Preview"]) {
      fireEvent.click(screen.getAllByRole("tab", { name })[0]!);
      expect(screen.getAllByRole("tablist", { name: "App workspace" })).toHaveLength(1);
      expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true");
    }
    fireEvent.click(screen.getByRole("button", { name: "App settings" }));
    expect(screen.getAllByRole("tablist", { name: "App workspace" })).toHaveLength(1);
  });

  it("puts the tabs in the preview bar and docks Edit over the preview, on Build only", async () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    const bar = screen.getByTestId("preview-bar");
    expect(bar.contains(screen.getByRole("tablist", { name: "App workspace" }))).toBe(false);
    expect(bar.querySelector('[aria-hidden="true"].invisible')).not.toBeNull();
    expect(bar.getAttribute("data-edit")).toBe("dock");
    cleanup();
    render(<AppWorkspace />);
    expect((await screen.findByTestId("preview-bar")).getAttribute("data-edit")).toBe("header");
  });

  it("puts History and Hide chat in the chat header", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    const header = screen.getByTestId("chat-header");
    expect(header.contains(screen.getByRole("button", { name: "History" }))).toBe(true);
    expect(header.contains(screen.getByRole("button", { name: "Hide chat" }))).toBe(true);
  });

  it("hides the chat, gives the app the full width, and brings it back from the preview bar", () => {
    const { container } = render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    const main = () => container.querySelector('[aria-hidden="false"], [aria-hidden="true"]') as HTMLElement;
    expect(main().className).toContain("lg:ml-[var(--website-chat-w)]");

    fireEvent.click(screen.getByRole("button", { name: "Hide chat" }));
    expect(screen.getByRole("complementary", { name: "Chat with your team" }).getAttribute("data-hidden")).toBe("true");
    expect(main().className).not.toContain("--website-chat-w");
    const show = screen.getByRole("button", { name: "Show chat" });
    expect(screen.getAllByRole("button", { name: "Show chat" })).toHaveLength(1);
    expect(screen.getByTestId("preview-bar").contains(show)).toBe(false);

    fireEvent.click(show);
    expect(screen.getByRole("complementary", { name: "Chat with your team" }).getAttribute("data-hidden")).toBe("false");
    expect(main().className).toContain("lg:ml-[var(--website-chat-w)]");
    expect(screen.queryByRole("button", { name: "Show chat" })).toBeNull();
  });

  it("opens this build's checkpoint history over the chat, and closes it again", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    expect(screen.queryByRole("region", { name: "Build history" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("button", { name: "History" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "History" }).className).toContain("rounded-full");
    expect(screen.getByRole("button", { name: "Hide chat" }).className).toContain("rounded-full");
    const panel = screen.getByRole("region", { name: "Build history" });
    expect(screen.getByRole("complementary", { name: "Chat with your team" }).contains(panel)).toBe(true);
    expect(screen.getByTestId("history-session").textContent).toBe("s1");

    fireEvent.click(screen.getByRole("button", { name: "Close history" }));
    expect(screen.queryByRole("region", { name: "Build history" })).toBeNull();
  });

  it("toggles history from the same button", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.queryByRole("region", { name: "Build history" })).toBeNull();
  });

  it("gives the Website tab no workspace tabs", () => {
    render(<AppWorkspace />);
    expect(screen.queryByRole("tablist", { name: "App workspace" })).toBeNull();
  });

  it("keeps Settings on the Website tab's own header, and it is a trip away", () => {
    render(<AppWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "settings" }),
      { push: true },
    );
  });

  it("frames the built app, not the tenant's own site", async () => {
    marketing = "https://own.example";
    resources = [hosting("https://acme.onrender.com")];
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await vi.waitFor(() => expect(screen.getByTestId("preview").textContent).toBe("https://acme.onrender.com"));
  });

  it("reloads the preview onto the shipped app when a change from this build finishes", async () => {
    resources = [hosting("https://acme.onrender.com")];
    buildSessionState.value = { ...buildSessionState.value, refines: [{ id: "r0", status: "done", created_at: "2026-09-29T10:00:00Z" }], refinesLoaded: true };
    const view = render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await vi.waitFor(() => expect(screen.getByTestId("preview").textContent).toBe("https://acme.onrender.com"));
    expect(screen.getByTestId("preview-bar").dataset.cache).toBe("");

    window.dispatchEvent(
      new CustomEvent("zavi:build-refine-finished", { detail: { sessionId: "s1", refineId: "r1", status: "failed" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId("preview-bar").dataset.cache).toBe("");

    resources = [hosting("https://acme-v2.onrender.com")];
    buildSessionState.value = {
      ...buildSessionState.value,
      refines: [
        { id: "r0", status: "done", created_at: "2026-09-29T10:00:00Z" },
        { id: "r1", status: "done", created_at: "2026-09-29T11:00:00Z" },
      ],
      refinesLoaded: true,
    };
    view.rerender(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await vi.waitFor(() => expect(screen.getByTestId("preview-bar").dataset.cache).toBe("1"));
    expect(screen.getByTestId("preview").textContent).toBe("https://acme-v2.onrender.com");
  });

  it("falls back to the build's own URL while hosting loads", async () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    expect((await screen.findByTestId("preview")).textContent).toBe("https://acme.onrender.com");
  });

  it("names the built app in the chat panel, not in the preview bar", async () => {
    render(<AppWorkspace variant="build" appUrl="https://my-shop.zaviagent.com" />);
    await screen.findByTestId("preview");
    expect(screen.getByTestId("chat-title").textContent).toContain("My Shop");
    expect(screen.queryByTestId("preview-name")).toBeNull();
  });

  it("marks that name with the app's own initial", async () => {
    render(<AppWorkspace variant="build" appUrl="https://my-shop.zaviagent.com" />);
    await screen.findByTestId("preview");
    const title = screen.getByTestId("chat-title");
    const mark = title.querySelector("span[aria-hidden]") as HTMLElement;
    expect(mark.textContent).toBe("M");
    expect(mark.className).toContain("rounded-md");
    expect(
      mark.compareDocumentPosition(screen.getByText("My Shop")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("is three wall sections, not one card holding chat and preview", async () => {
    const { container } = render(
      <AppWorkspace variant="build" appUrl="https://my-shop.zaviagent.com" />,
    );
    await screen.findByTestId("preview");
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("bg-transparent");
    expect(root.className).not.toContain("bg-white");
    const previewHost = screen.getByTestId("preview-bar").parentElement!
      .parentElement as HTMLElement;
    expect(previewHost.className).not.toMatch(/(?:^|\s)p-\d/);
  });

  it("opens a build that never bound a thread on a blank chat, not the latest Grow thread", async () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await screen.findByTestId("preview");
    expect(screen.getByTestId("chat-thread").textContent).toBe("null");
  });

  it("reopens on the thread that build bound, not on whatever came later", async () => {
    workspaceTabs = buildTab("thread-abc");
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await screen.findByTestId("preview");
    expect(screen.getByTestId("chat-thread").textContent).toBe("thread-abc");
  });

  it("writes a newly bound thread back to the build tab", async () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await screen.findByTestId("preview");
    panelProps.onThreadChange!("thread-new");
    expect(setTabThreadId).toHaveBeenCalledWith("tab-build", "thread-new");
  });

  it("keeps a build chat the founder blanked on purpose blank", async () => {
    workspaceTabs = buildTab(null);
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await screen.findByTestId("preview");
    expect(screen.getByTestId("chat-thread").textContent).toBe("null");
  });

  it("leaves the Website tab resolving its own latest conversation", async () => {
    render(<AppWorkspace />);
    await screen.findByTestId("preview");
    expect(screen.getByTestId("chat-thread").textContent).toBe("resolve-latest");
    expect(panelProps.onThreadChange).toBeUndefined();
  });

  it("shows no Website URL strip above the app", async () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await screen.findByTestId("preview");
    expect(screen.queryByText(/^Website:/)).toBeNull();
  });

  it("keeps the strip on the Website tab", async () => {
    marketing = "https://own.example";
    render(<AppWorkspace />);
    expect(await screen.findByText(/^Website:/)).toBeTruthy();
  });

  it("opens the export for a Zavi-hosted repo instead of a GitHub 404", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(
      <AppWorkspace
        variant="build"
        appUrl="https://acme.onrender.com"
        appRepoUrl="https://github.com/Praxis-build/acme-6ec4d609"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "GitHub export" }));
    expect(open).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Export your code" });
    expect(dialog.textContent).toMatch(/Export to GitHub/);
    expect(dialog.textContent).not.toMatch(/Download ZIP/);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps focus on the GitHub button when the export opens", () => {
    render(
      <AppWorkspace
        variant="build"
        appUrl="https://acme.onrender.com"
        appRepoUrl="https://github.com/Praxis-build/acme-6ec4d609"
      />,
    );
    const trigger = screen.getByRole("button", { name: "GitHub export" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Export your code" })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
  });

  it("a repo the founder owns: Export links to it, without a ZIP, and never copies it", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" appRepoUrl="https://github.com/acme/app" />);
    fireEvent.click(screen.getByRole("button", { name: "GitHub export" }));
    const dialog = screen.getByRole("dialog", { name: "Export your code" });
    expect(screen.getByTestId("export-open-repo").getAttribute("href")).toBe("https://github.com/acme/app");
    expect(dialog.textContent).not.toMatch(/Export to GitHub/);
    expect(dialog.textContent).not.toMatch(/Download ZIP/);
  });

  it("offers the export for a repo Zavi manages even when its org is not one the web knows by name", async () => {
    resources = [{ resource_kind: "repo", mode: "provisioned", status: "ready", external_ref: { html_url: "https://github.com/zavi-apps-2027/acme-1" } }];
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await vi.waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "GitHub export" }));
      expect(screen.getByRole("dialog", { name: "Export your code" }).textContent).toMatch(/Export to GitHub/);
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the founder's own connected repo even if its owner looks like Zavi's org", async () => {
    resources = [{ resource_kind: "repo", mode: "connected", status: "ready", external_ref: { html_url: "https://github.com/praxis-built/founder-fork" } }];
    const open = vi.fn();
    vi.stubGlobal("open", open);
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await vi.waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "GitHub export" }));
      expect(screen.getByTestId("export-open-repo").getAttribute("href")).toBe("https://github.com/praxis-built/founder-fork");
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the export for a site build whose repo sits in an org the web does not know, even beside an older connected repo", async () => {
    resources = [{ resource_kind: "repo", mode: "connected", status: "ready", external_ref: { html_url: "https://github.com/acme/old-app" } }];
    const before = buildPreviewState.value;
    buildPreviewState.value = {
      ...before,
      classified: true,
      site: { hostname: "apple-hub.zaviagent.com", liveUrl: null, status: "ready", repoUrl: "https://github.com/zavi-latest-build/apple-hub-b896bdf2" },
      runStatus: "done",
    } as typeof before;
    const open = vi.fn();
    vi.stubGlobal("open", open);
    try {
      render(<AppWorkspace variant="build" appUrl="https://apple-hub.zaviagent.com" />);
      await vi.waitFor(() => {
        fireEvent.click(screen.getByRole("button", { name: "GitHub export" }));
        expect(screen.getByRole("dialog", { name: "Export your code" }).textContent).toMatch(/Export to GitHub/);
      });
      expect(screen.queryByTestId("export-open-repo")).toBeNull();
      expect(open).not.toHaveBeenCalled();
    } finally {
      buildPreviewState.value = before;
    }
  });

  it("keeps the GitHub export reachable on narrow screens", () => {
    render(
      <AppWorkspace variant="build" appUrl="https://acme.onrender.com" appRepoUrl="https://github.com/Praxis-build/acme-6ec4d609" />,
    );
    const trigger = screen.getByRole("button", { name: "GitHub export" });
    expect(trigger.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("flips between the app and the chat with ONE icon-only toggle on narrow screens", () => {
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    expect(screen.queryByText("View app")).toBeNull();
    const toApp = screen.getByRole("button", { name: "Show the app" });
    const toChat = screen.getByRole("button", { name: "Show the chat" });
    expect(toApp.className).not.toContain("border");
    expect(toChat.className).not.toContain("border");
    expect(toApp.querySelector("svg")?.getAttribute("class")).toContain("h-4");
  });
});

describe("history checkpoints frame their version and can be reverted to", () => {
  it("picking a version frames it with Back to latest and Revert, hands the panel the live URL, and turns editing off", async () => {
    resources = [hosting("https://acme.onrender.com")];
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    await vi.waitFor(() => expect(screen.getByTestId("preview").textContent).toBe("https://acme.onrender.com"));
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByTestId("history-live").textContent).toBe("https://acme.onrender.com");
    fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
    expect(screen.getByTestId("preview").textContent).toBe("https://pr-12.preview.example");
    expect(screen.getByTestId("history-selected").textContent).toBe("r1");
    expect(screen.getByRole("button", { name: "Back to latest" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revert to this version" })).toBeTruthy();
    expect(screen.getByText("Darker hero")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.getByTestId("preview-bar").getAttribute("data-app")).toBe("");
    expect(screen.getByTestId("preview-bar").getAttribute("data-built")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Back to latest" }));
    expect(screen.getByTestId("preview").textContent).toBe("https://acme.onrender.com");
    expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
    expect(posted).toHaveLength(0);
  });

  it("Revert posts that version's run id, then returns to the latest and reloads the preview", async () => {
    resources = [hosting("https://acme.onrender.com")];
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
    const before = screen.getByTestId("preview-bar").getAttribute("data-cache");
    fireEvent.click(screen.getByRole("button", { name: "Revert to this version" }));
    await waitFor(() => expect(posted).toEqual([{ path: "/api/workspace/autopilot/restore-checkpoint", body: { conductor_run_id: "r1" } }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Revert to this version" })).toBeNull());
    expect(screen.queryByRole("region", { name: "Build history" })).toBeNull();
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ type: "loading", title: "Reverting to an earlier version" }));
    await waitFor(() => expect(toastUpdate).toHaveBeenCalledWith("toast-1", expect.objectContaining({ type: "success" })), { timeout: 8000 });
    expect(posted.map((p) => p.path)).toEqual(["/api/workspace/autopilot/restore-checkpoint"]);
    await waitFor(() => expect(screen.getByTestId("preview-bar").getAttribute("data-cache")).not.toBe(before));
  });

  it("closing the workspace mid-revert stops polling the deploy, never reloads, and clears the loading toast", async () => {
    restoreState = "deploying";
    watchSleep.fn = () => new Promise<void>((r) => setTimeout(r, 5));
    const statusPolls = () => fetchedPaths.filter((p) => p.startsWith("/api/workspace/autopilot/restore-status?")).length;
    try {
      resources = [hosting("https://acme.onrender.com")];
      const view = render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
      fireEvent.click(screen.getByRole("button", { name: "History" }));
      fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
      fireEvent.click(screen.getByRole("button", { name: "Revert to this version" }));
      await waitFor(() => expect(statusPolls()).toBeGreaterThanOrEqual(2));
      restoreState = "live";
      view.unmount();
      const atUnmount = statusPolls();
      await new Promise((r) => setTimeout(r, 120));
      expect(statusPolls()).toBeLessThanOrEqual(atUnmount + 1);
      expect(toastUpdate).not.toHaveBeenCalled();
      expect(toastClose).toHaveBeenCalledWith("toast-1");
      const fetchesAfter = fetchedPaths.length;
      await new Promise((r) => setTimeout(r, 60));
      expect(fetchedPaths.length).toBe(fetchesAfter);
    } finally {
      watchSleep.fn = null;
      restoreState = "live";
    }
  });

  it("a refused revert keeps the version framed and says why", async () => {
    restoreReply = { ok: false, body: { error: { code: "nothing_to_restore", message: "the app has not changed since it was built" } } };
    resources = [hosting("https://acme.onrender.com")];
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
    fireEvent.click(screen.getByRole("button", { name: "Revert to this version" }));
    await waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", description: "the app has not changed since it was built" }),
      ),
    );
    expect(screen.getByRole("button", { name: "Revert to this version" })).toBeTruthy();
    expect(screen.getByTestId("preview").textContent).toBe("https://pr-12.preview.example");
    expect(screen.getByTestId("history-chrome").textContent).not.toContain("has not changed");
  });
});

describe("a built site whose preview stopped keeps the preview layout", () => {
  const stopped = () => {
    const before = buildPreviewState.value;
    buildPreviewState.value = {
      ...before,
      classified: true,
      site: { hostname: "bakery.zaviagent.com", liveUrl: null, status: "building" },
      previewUrl: null,
      runStatus: "done",
      previewState: "stopped",
    } as typeof before;
    return () => {
      buildPreviewState.value = before;
    };
  };

  it("sending a change never widens the chat over the Restart panel", () => {
    const restore = stopped();
    try {
      render(<AppWorkspace variant="build" appUrl={null as unknown as string} />);
      expect((panelProps as { autoExpandOnEngagement?: boolean }).autoExpandOnEngagement).toBe(false);
    } finally {
      restore();
    }
  });

  it("a chat that was already wide goes back to split view once the stopped preview is known", async () => {
    const before = buildPreviewState.value;
    try {
      buildPreviewState.value = { ...before, classified: true, site: { hostname: "bakery.zaviagent.com", liveUrl: null, status: "building" }, previewUrl: null, runStatus: "done" } as typeof before;
      const view = render(<AppWorkspace variant="build" appUrl={null as unknown as string} />);
      act(() => (panelProps as { onExpandedChange: (v: boolean) => void }).onExpandedChange(true));
      expect((panelProps as { expanded?: boolean }).expanded).toBe(true);
      buildPreviewState.value = { ...buildPreviewState.value, previewState: "stopped" } as typeof before;
      view.rerender(<AppWorkspace variant="build" appUrl={null as unknown as string} />);
      await waitFor(() => expect((panelProps as { expanded?: boolean }).expanded).toBe(false));
    } finally {
      buildPreviewState.value = before;
    }
  });
});

describe("a new-builder site's History opens its stored builds, view only", () => {
  const SIGNED = "https://bike.zaviagent.com/__zavi_preview/d0muqzh2uy-1d58fa82/?t=x&zavi_embed=1";
  const asSite = () => {
    const before = buildPreviewState.value;
    buildPreviewState.value = { ...before, classified: true, site: { hostname: "bike.zaviagent.com", liveUrl: "https://bike.zaviagent.com", status: "live" } } as typeof before;
    return () => {
      buildPreviewState.value = before;
    };
  };

  it("an earlier version frames its signed build link at once, says View only, and offers no Revert", async () => {
    const restore = asSite();
    try {
      pickedUrl = null;
      versionJob = { status: "live", url: SIGNED, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() } as typeof versionJob;
      resources = [hosting("https://acme.onrender.com")];
      render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
      fireEvent.click(screen.getByRole("button", { name: "History" }));
      fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
      await waitFor(() => expect(screen.getByTestId("preview").textContent).toBe(SIGNED));
      expect(posted.filter((p) => p.path === "/api/workspace/autopilot/version-preview")).toEqual([
        { path: "/api/workspace/autopilot/version-preview", body: { conductor_run_id: "r1" } },
      ]);
      expect(fetchedPaths.some((p) => p.startsWith("/api/workspace/autopilot/version-preview?"))).toBe(false);
      expect(screen.getByTestId("history-view-only").textContent).toBe("View only");
      expect(screen.queryByRole("button", { name: "Revert to this version" })).toBeNull();
      expect(screen.queryByText("Waiting for approval")).toBeNull();
      expect(posted.some((p) => p.path === "/api/workspace/autopilot/restore-checkpoint")).toBe(false);
      expect(screen.getByTestId("preview-bar").getAttribute("data-keep-cookie")).toBe("true");
      expect(JSON.parse(window.localStorage.getItem("zavi.sitePreviewCookie") ?? "{}")).toHaveProperty("bike.zaviagent.com");
      fireEvent.click(screen.getByRole("button", { name: "Back to latest" }));
      expect(screen.getByTestId("preview-bar").getAttribute("data-keep-cookie")).toBe("false");
    } finally {
      window.localStorage.clear();
      restore();
    }
  });

  it("hopping back to a version already opened frames it at once, with no boot screen and no second request", async () => {
    const restore = asSite();
    try {
      pickedUrl = null;
      versionJob = { status: "live", url: SIGNED, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() } as typeof versionJob;
      resources = [hosting("https://acme.onrender.com")];
      render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
      fireEvent.click(screen.getByRole("button", { name: "History" }));
      fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
      await waitFor(() => expect(screen.getByTestId("preview").textContent).toBe(SIGNED));
      fireEvent.click(screen.getByRole("button", { name: "Back to latest" }));
      expect(screen.getByTestId("preview").textContent).toBe("https://bike.zaviagent.com");
      versionJob = { status: "starting" };
      fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
      expect(screen.queryByTestId("history-version-boot")).toBeNull();
      expect(screen.getByTestId("preview").textContent).toBe(SIGNED);
      await act(async () => {});
      expect(screen.getByTestId("preview").textContent).toBe(SIGNED);
      expect(posted.filter((p) => p.path === "/api/workspace/autopilot/version-preview")).toHaveLength(1);
      expect(fetchedPaths.some((p) => p.startsWith("/api/workspace/autopilot/version-preview?"))).toBe(false);
    } finally {
      window.localStorage.clear();
      restore();
    }
  });

  it("a version that is no longer kept says why instead of framing anything", async () => {
    const restore = asSite();
    try {
      pickedUrl = null;
      versionJob = { status: "dead", url: null, error: "This version is too old to open. Zavi keeps copies of your most recent versions only." };
      resources = [hosting("https://acme.onrender.com")];
      render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
      fireEvent.click(screen.getByRole("button", { name: "History" }));
      fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("too old to open"));
      expect(screen.queryByTestId("preview")).toBeNull();
      expect(screen.queryByRole("button", { name: "Revert to this version" })).toBeNull();
    } finally {
      restore();
    }
  });

  it("even the live version of a site never offers a Revert the server would refuse", () => {
    const restore = asSite();
    try {
      pickedUrl = "https://bike.zaviagent.com";
      resources = [hosting("https://acme.onrender.com")];
      render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
      fireEvent.click(screen.getByRole("button", { name: "History" }));
      fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
      expect(screen.queryByRole("button", { name: "Revert to this version" })).toBeNull();
      expect(screen.getByTestId("history-view-only")).toBeTruthy();
      expect(screen.getByTestId("preview-bar").getAttribute("data-keep-cookie")).toBe("false");
    } finally {
      restore();
    }
  });
});

describe("a version with no saved preview boots its own live preview", () => {
  it("shows the starting state under the history bar, then frames the booted preview, without the surface tabs overlay", async () => {
    pickedUrl = null;
    resources = [hosting("https://acme.onrender.com")];
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
    expect(screen.getByTestId("history-version-boot")).toBeTruthy();
    expect(screen.getByText("Starting a preview of this version")).toBeTruthy();
    expect(screen.queryByTestId("preview")).toBeNull();
    expect(screen.queryByRole("tablist", { name: "App workspace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back to latest" })).toBeTruthy();
    await waitFor(() => expect(posted.some((p) => p.path === "/api/workspace/autopilot/version-preview" && (p.body as { conductor_run_id: string }).conductor_run_id === "r1")).toBe(true));
    versionJob = { status: "live", url: "https://3300-sbx.e2b.app" };
    await waitFor(() => expect(screen.getByTestId("preview").textContent).toBe("https://3300-sbx.e2b.app"), { timeout: 8000 });
    expect(screen.getByRole("button", { name: "Revert to this version" })).toBeTruthy();
    expect(screen.getByTestId("preview-bar").getAttribute("data-built")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Back to latest" }));
    expect(screen.getByTestId("preview").textContent).toBe("https://acme.onrender.com");
  });

  it("a dead preview says why, offers Try again, and revert still works from the bar", async () => {
    pickedUrl = null;
    versionJob = { status: "dead", error: "The preview didn't start in time" };
    resources = [hosting("https://acme.onrender.com")];
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
    await waitFor(() => expect(screen.getByText("This version's preview didn't start")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("didn't start in time");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revert to this version" }));
    await waitFor(() => expect(posted.some((p) => p.path === "/api/workspace/autopilot/restore-checkpoint")).toBe(true));
  });

  it("a version that can never be shown says so honestly and offers no futile Try again", async () => {
    pickedUrl = null;
    versionJob = { status: "dead", url: null, error: "Zavi has no saved copy of this version's code, so it can't be shown.", retryable: false } as typeof versionJob;
    resources = [hosting("https://acme.onrender.com")];
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
    await waitFor(() => expect(screen.getByText("This version can't be shown")).toBeTruthy());
    expect(screen.queryByText("This version's preview didn't start")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("no saved copy of this version's code");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("Try again on a failed version preview asks the server again", async () => {
    pickedUrl = null;
    versionJob = { status: "dead", error: "Zavi couldn't build a preview of this version just now. Try again." };
    resources = [hosting("https://acme.onrender.com")];
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy());
    const before = posted.filter((p) => p.path === "/api/workspace/autopilot/version-preview").length;
    versionJob = { status: "starting" };
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(posted.filter((p) => p.path === "/api/workspace/autopilot/version-preview").length).toBe(before + 1));
    await waitFor(() => expect(screen.getByText("Starting a preview of this version")).toBeTruthy());
  });

  it("a refused revert on a booting version shows the reason in place", async () => {
    pickedUrl = null;
    restoreReply = { ok: false, body: { error: { code: "nothing_to_restore", message: "the original build's commit could not be found" } } };
    resources = [hosting("https://acme.onrender.com")];
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
    fireEvent.click(screen.getByRole("button", { name: "Revert to this version" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((el) => el.textContent?.includes("could not be found"))).toBe(true));
    expect(screen.getByTestId("history-version-boot")).toBeTruthy();
  });
});

describe("a parked change can be viewed but not reverted to", () => {
  it("shows Waiting for approval in place of the Revert button", () => {
    pickedRestorable = false;
    resources = [hosting("https://acme.onrender.com")];
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick version" }));
    expect(screen.queryByRole("button", { name: "Revert to this version" })).toBeNull();
    expect(screen.getByText("Waiting for approval")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to latest" })).toBeTruthy();
  });
});

describe("one browser for every Build state", () => {
  afterEach(() => {
    buildPreviewState.value = { building: false, loaded: true, previewUrl: null, runStatus: "done", stages: [], failure: null, settledNonce: 0 };
  });

  it("a build with no app yet shows the build progress inside the same preview bar, with Publish and the workspace tabs", () => {
    buildPreviewState.value = {
      building: true,
      loaded: true,
      previewUrl: null,
      runStatus: "running",
      stages: [
        { stage: "provision", status: "done" },
        { stage: "spec", status: "running" },
        { stage: "scaffold", status: "pending" },
        { stage: "build", status: "pending" },
        { stage: "qa", status: "pending" },
      ],
      failure: null,
      settledNonce: 0,
    };
    render(<AppWorkspace variant="build" appUrl={null} appUrlLive={false} />);
    const bar = screen.getByRole("progressbar", { name: "Website build progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("30");
    const chrome = screen.getByTestId("preview-bar");
    expect(chrome.contains(bar)).toBe(true);
    expect(chrome.contains(screen.getByRole("button", { name: "Publish" }))).toBe(true);
    expect(chrome.getAttribute("data-built")).toBe("false");
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toEqual(["Preview", "Files", "Code"]);
    expect(screen.queryByText("Loading preview")).toBeNull();
  });

  it("an in-progress build with an early sandbox address keeps the progress bar, frames nothing, and is never offered to Publish", () => {
    buildPreviewState.value = { ...buildPreviewState.value, classified: true, building: true, runStatus: "running" } as typeof buildPreviewState.value;
    render(<AppWorkspace variant="build" appUrl="https://3400-sandbox.e2b.app" appUrlLive={false} />);
    expect(screen.getByRole("progressbar", { name: "Website build progress" })).toBeTruthy();
    expect(screen.queryByTestId("preview")).toBeNull();
    const publish = screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
    expect(publish.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(publish);
    expect(screen.queryByTestId("publish-popover")).toBeNull();
  });

  it("a preview column with no app and no build yet shows a loading state in the same chrome, never the route box", () => {
    render(<AppWorkspace variant="build" appUrl={null} appUrlLive={false} />);
    const chrome = screen.getByTestId("preview-bar");
    expect(chrome.contains(screen.getByRole("status"))).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Loading preview");
    expect(chrome.contains(screen.getByRole("button", { name: "Publish" }))).toBe(true);
    expect(screen.queryByTestId("preview")).toBeNull();
  });

  it("Export is enabled before the repo exists, opens the GitHub export only, and never sends a founder to Settings", () => {
    render(<AppWorkspace variant="build" appUrl={null} appUrlLive={false} />);
    const github = screen.getByRole("button", { name: "GitHub export" });
    expect((github as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(github);
    expect(screen.getByRole("dialog", { name: "Export your code" }).textContent).not.toMatch(/Download ZIP/);
    expect(openTab).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "settings" }), expect.anything());
    expect(openTab).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "settings" }));
  });

  it("the built app is publishable from the same bar", () => {
    buildPreviewState.value = { ...buildPreviewState.value, classified: true } as typeof buildPreviewState.value;
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" appUrlLive />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.getByTestId("publish-popover").getAttribute("data-publishable")).toBe("true");
  });

  it("closes Publish when the founder clicks into the preview iframe", () => {
    buildPreviewState.value = { ...buildPreviewState.value, classified: true } as typeof buildPreviewState.value;
    render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" appUrlLive />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(screen.getByTestId("publish-popover")).toBeTruthy();

    const previewFrame = document.createElement("iframe");
    document.body.appendChild(previewFrame);
    previewFrame.focus();
    fireEvent.blur(window);

    expect(screen.queryByTestId("publish-popover")).toBeNull();
    previewFrame.remove();
  });
});

describe("the Build chat sends an app change as one refine of this build", () => {
  type BeforeSend = (message: string) => Promise<{ handled: boolean; system?: string; consumed?: boolean }>;
  const beforeSend = () => (panelProps as { onBeforeSend?: BeforeSend }).onBeforeSend!;
  const route = (r: string) => async () => ({ ok: true, status: 200, json: async () => ({ route: r }) });

  beforeEach(() => {
    startBuildRefineMock.mockClear();
    chatReply = route("operator");
  });

  it("an app change is a plain refine of this build (no small-edit flag)", async () => {
    chatReply = route("app_edit");
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    const out = await beforeSend()("Change the hero title to Rent bikes fast");
    expect(posted.find((r) => r.path === "/api/workspace/website/chat")?.body).toEqual({
      message: "Change the hero title to Rent bikes fast",
      conductor_run_id: "s1",
    });
    expect(startBuildRefineMock).toHaveBeenCalledWith("s1", "Change the hero title to Rent bikes fast", { optimistic: false, selection: null });
    expect(out).toMatchObject({ handled: true, consumed: true });
  });

  it("a screenshot sent with the change goes to this build's refine with the image attached", async () => {
    chatReply = route("app_edit");
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    const send = (panelProps as { onBeforeSend?: (m: string, images?: string[]) => ReturnType<BeforeSend> }).onBeforeSend!;
    const out = await send("Make this button bigger", ["tenant-1/chat/shot.png"]);
    expect(startBuildRefineMock).toHaveBeenCalledWith("s1", "Make this button bigger", {
      optimistic: false,
      selection: null,
      imagePaths: ["tenant-1/chat/shot.png"],
    });
    expect(out).toMatchObject({ handled: true, consumed: true });
  });

  it("a screenshot on the Website tab (no build) is left to the normal chat with its image", async () => {
    chatReply = route("app_edit");
    render(<AppWorkspace appUrl="https://bikes.onrender.com" />);
    const send = (panelProps as { onBeforeSend?: (m: string, images?: string[]) => ReturnType<BeforeSend> }).onBeforeSend!;
    const out = await send("Make this button bigger", ["tenant-1/chat/shot.png"]);
    expect(out.handled).toBe(false);
    expect(startBuildRefineMock).not.toHaveBeenCalled();
    expect(posted.some((r) => r.path === "/api/workspace/website/chat")).toBe(false);
  });

  it("the old in-preview edit route (never sent by the classifier) starts nothing", async () => {
    chatReply = route("app_edit_inline");
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    const out = await beforeSend()("Change the hero title to Rent bikes fast");
    expect(startBuildRefineMock).not.toHaveBeenCalled();
    expect(out.handled).toBe(false);
  });

  it("starts nothing when the classifier is down", async () => {
    chatReply = async () => {
      throw new Error("offline");
    };
    render(<AppWorkspace variant="build" appUrl="https://bikes.onrender.com" />);
    const out = await beforeSend()("Change the hero title to Rent bikes fast");
    expect(startBuildRefineMock).not.toHaveBeenCalled();
    expect(out.handled).toBe(true);
  });
});

describe("Export on a new-builder site", () => {
  it("treats the site's repo as Zavi's in any org: the export copies it, never links it", async () => {
    const before = buildPreviewState.value;
    try {
      buildPreviewState.value = {
        ...before,
        classified: true,
        site: { id: "s-1", hostname: "bikes.zaviagent.com", liveUrl: null, status: "building", repoUrl: "https://github.com/Zavi-Latest-Build/bikes-1" },
      } as typeof before;
      render(<AppWorkspace variant="build" appUrl="https://acme.onrender.com" />);
      await vi.waitFor(() => {
        fireEvent.click(screen.getByRole("button", { name: "GitHub export" }));
        expect(screen.getByRole("dialog", { name: "Export your code" }).textContent).toMatch(/Export to GitHub/);
      });
      expect(screen.queryByTestId("export-open-repo")).toBeNull();
    } finally {
      buildPreviewState.value = before;
    }
  });
});
