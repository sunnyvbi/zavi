// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  preview: {} as Record<string, unknown>,
  calls: [] as Array<{ path: string; method?: string; body?: unknown }>,
  restart: { ok: true, status: 202, body: { ok: true, preview_state: "starting" } as unknown },
  resumed: [] as Array<unknown>,
  refines: [] as Array<Record<string, unknown>>,
  mounts: 0,
  loads: [] as string[],
  gate: null as Promise<void> | null,
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
vi.mock("./website/WebsitePreview", async () => {
  const React = await import("react");
  return {
  WebsitePreview: ({
    body,
    liveUrl,
    cacheKey,
  }: {
    body?: React.ReactNode;
    liveUrl?: string | null;
    cacheKey?: string | null;
  }) => {
    const [mount] = React.useState(() => ++h.mounts);
    const load = `${mount}|${liveUrl ?? ""}|${cacheKey ?? ""}`;
    if (liveUrl && h.loads[h.loads.length - 1] !== load) h.loads.push(load);
    return (
      <div data-testid="frame" data-live={liveUrl ?? ""} data-cache={cacheKey ?? ""} data-mount={mount}>
        {body}
      </div>
    );
  },
  AppStartingScreen: () => null,
  chatEditErrorMessage: () => "",
  };
});
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
    classified: true,
    previewUrl: null,
    runStatus: "done",
    runId: "s1",
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
    refines: h.refines,
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
    resolveEnabled: async () => false,
    refresh: vi.fn(),
    publish: vi.fn(),
    discard: vi.fn(),
    wake: vi.fn(),
  }),
}));
vi.mock("@/components/ui/toast", () => ({ toast: { add: () => "t", update: () => {} } }));
vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts: { method?: string; body?: string } = {}) => {
    h.calls.push({ path, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (path === "/api/workspace/autopilot/build-preview/restart") {
      const r = h.restart;
      return Promise.resolve({ ok: r.ok, status: r.status, json: async () => r.body });
    }
    const body = path === "/api/connectors/product-url" ? { product_url: {} } : { resources: [] };
    const answer = { ok: true, status: 200, json: async () => body };
    return h.gate ? h.gate.then(() => answer) : Promise.resolve(answer);
  },
}));

import { AppWorkspace } from "./WebsiteTab";

const SITE = { id: "aaaaaaaa-0000-4000-8000-000000000001", hostname: "rental.zavi.site", liveUrl: null, status: "building", repoUrl: null };
const BOX = "https://5173-sbx.e2b.app";
const NEW_BOX = "https://5173-fresh.e2b.app";
const ready = (url = BOX) => ({ site: SITE, previewState: null, previewUrl: url, previewKind: "instant", previewCompiling: false });
const restarting = () => ({ site: SITE, previewState: "starting", previewUrl: null, previewKind: "none", previewCompiling: false });
const change = (status: string) => ({ id: "r1", message: "Make the hero blue", status, created_at: "2026-11-03T10:00:00Z", kind: "change" });

type Screen = { pane: string; live: string; mount: string; cache: string; updating: boolean };
function screenNow(): Screen {
  const frame = screen.getAllByTestId("frame")[0]!;
  const pane = screen.queryByTestId("preview-stopped-card")
    ? "stopped-or-starting"
    : screen.queryByTestId("preview-pending-card")
      ? "pending"
      : screen.queryByTestId("preview-compiling")
        ? "compiling"
        : frame.getAttribute("data-live")
          ? "frame"
          : "empty";
  return {
    pane,
    live: frame.getAttribute("data-live") ?? "",
    mount: frame.getAttribute("data-mount") ?? "",
    cache: frame.getAttribute("data-cache") ?? "",
    updating: !!screen.queryByTestId("preview-updating"),
  };
}

async function step(view: ReturnType<typeof render>, preview: Record<string, unknown>, refines: Array<Record<string, unknown>>, appRevision: string | null) {
  h.preview = preview;
  h.refines = refines;
  view.rerender(<AppWorkspace variant="build" appUrl={preview.previewUrl as string | null} appRevision={appRevision} />);
  await act(async () => {});
  return screenNow();
}

beforeEach(() => {
  h.calls.length = 0;
  h.mounts = 0;
  h.loads = [];
  h.refines = [];
  h.preview = ready();
  h.gate = null;
});
afterEach(() => cleanup());

describe("one change on a site with a working preview", () => {
  it("keeps the current preview mounted through every dev-server restart, then swaps to the new one once, when it is ready", async () => {
    const view = render(<AppWorkspace variant="build" appUrl={BOX} appRevision="initial" />);
    await act(async () => {});
    const before = screenNow();
    expect(before).toMatchObject({ pane: "frame", live: BOX, updating: false });

    const during: Screen[] = [];
    during.push(await step(view, ready(), [change("queued")], "initial"));
    during.push(await step(view, ready(), [change("running")], "initial"));
    during.push(await step(view, restarting(), [change("running")], null));
    during.push(await step(view, ready(), [change("running")], "initial"));
    during.push(await step(view, { ...ready(), previewCompiling: true }, [change("running")], "initial"));
    during.push(await step(view, restarting(), [change("running")], null));
    during.push(await step(view, { site: SITE, previewState: null, previewUrl: null, previewKind: "none" }, [change("running")], null));
    during.push(await step(view, restarting(), [change("done")], null));
    during.push(await step(view, restarting(), [change("done")], null));

    expect(during.map((s) => s.pane)).toEqual(during.map(() => "frame"));
    expect(during.map((s) => `${s.live} #${s.mount} ${s.cache}`)).toEqual(during.map(() => `${BOX} #${before.mount} ${before.cache}`));
    expect(during.map((s) => s.updating)).toEqual(during.map(() => true));

    const after = await step(view, ready(NEW_BOX), [change("done")], "r1-done");
    expect(after).toMatchObject({ pane: "frame", live: NEW_BOX, updating: false });
    expect(after.mount).not.toBe(before.mount);
    const settled = await step(view, ready(NEW_BOX), [change("done")], "r1-done");
    expect(settled).toEqual(after);
    expect(h.mounts - Number(before.mount)).toBe(1);
  });

  it("a change that lands while the dev server keeps answering reloads the frame once, not once for the change and again for a cache bust", async () => {
    const view = render(<AppWorkspace variant="build" appUrl={BOX} appRevision="initial" />);
    await act(async () => {});
    const before = screenNow();
    await step(view, ready(), [change("running")], "initial");
    const loadsBefore = h.loads.length;
    let open = () => {};
    h.gate = new Promise<void>((r) => (open = r));
    const landed = await step(view, ready(), [change("done")], "r1-done");
    await act(async () => {
      open();
      await new Promise((r) => setTimeout(r, 0));
    });
    const later = screenNow();
    expect(landed.updating).toBe(false);
    expect(later).toEqual(landed);
    expect(h.mounts - Number(before.mount)).toBe(1);
    expect(h.loads.slice(loadsBefore)).toHaveLength(1);
  });

  it("a preview that does not come back after the change shows the stopped screen, never a held dead frame", async () => {
    const view = render(<AppWorkspace variant="build" appUrl={BOX} appRevision="initial" />);
    await act(async () => {});
    await step(view, ready(), [change("running")], "initial");
    await step(view, restarting(), [change("done")], null);
    const stopped = await step(view, { site: SITE, previewState: "stopped", previewUrl: null, previewKind: "none" }, [change("done")], null);
    expect(stopped.pane).toBe("stopped-or-starting");
    expect(stopped.updating).toBe(false);
    expect(screen.getByText("Your preview stopped")).toBeTruthy();
  });

  it("a change on a site whose preview was already stopped does not frame the dead address", async () => {
    h.preview = { site: SITE, previewState: "stopped", previewUrl: null, previewKind: "none" };
    const view = render(<AppWorkspace variant="build" appUrl={null} appRevision={null} />);
    await act(async () => {});
    const s = await step(view, restarting(), [change("running")], null);
    expect(s.pane).toBe("stopped-or-starting");
    expect(s.live).toBe("");
    expect(screen.getByText("Starting your preview")).toBeTruthy();
  });
});
