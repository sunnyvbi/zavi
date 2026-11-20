// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { apiFetch, openBuildTab, h } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  openBuildTab: vi.fn(),
  h: { awaiting: true, started: false, flag: true },
}));

vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/builderClarifyFlag", () => ({
  isBuilderClarifyEnabled: () => false,
  isBuilderClarifyDynamicEnabled: () => false,
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tenantName: "Acme",
    creditsEnforced: false,
    builderRetryNonce: 0,
    ackBuilderRetry: () => {},
    openBuildTab,
  }),
  useWorkspaceOptional: () => null,
}));
vi.mock("../useProductUrl", () => ({
  useProductUrlState: () => ({ status: "ok", value: {} }),
}));
vi.mock("./LiveAppCard", () => ({ LiveAppCard: () => null }));
vi.mock("./BuilderThread", () => ({ BuilderThread: () => null }));
vi.mock("./ThemeControls", () => ({ ThemeControls: () => null }));
vi.mock("@/components/workspace/Markdown", () => ({ Markdown: () => null }));

import { BuilderChatCard } from "./BuilderChatCard";
import { resetSharedSiteDesigns } from "@/lib/workspace/useSiteDesign";
import { BUILD_WITH_LOOK } from "../build/LookPicker";

const BUILD_PATH = "/api/workspace/autopilot/build-product";
const DIRECTION = "/api/workspace/autopilot/site-design/direction";
const RUN = "6b1f6f0e-6a3f-4d47-9a43-1f1f2d6c0a11";

const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const look = (id: string) => ({
  id,
  label: `Look ${id}`,
  mood: `${id} mood`,
  recommended: id === "brand",
  fonts: { display: "Fraunces", body: "Inter" },
  swatches: { background: "#ffffff", foreground: "#111111", primary: "#2255aa", accent: "#ddeeff", muted: "#f3f3f3" },
  radius: "0.5rem",
});
const design = () => ({
  run_id: RUN,
  awaiting_pick: h.flag && h.awaiting,
  picked: h.started,
  source: "model",
  looks: [look("brand"), look("luxe"), look("studio")],
  chosen: "brand",
  applied: null,
  locked: null,
  plan: { audience: null, positioning: null, tone: null, main_action: null, sections: [], pages: [], facts: [] },
  checklist: null,
});
const statusRun = () => ({
  run: {
    id: RUN,
    status: "active",
    spend_usd: 0,
    max_usd: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    stages: [
      { stage: "provision", status: "done", error: null },
      { stage: "spec", status: "done", error: null },
      { stage: "scaffold", status: h.started || !h.flag ? "running" : "pending", error: null },
      { stage: "build", status: "pending", error: null },
    ],
  },
  target: { repo_url: null, live_url: null },
});

let built = false;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetSharedSiteDesigns();
  built = false;
  h.awaiting = true;
  h.started = false;
  h.flag = true;
  openBuildTab.mockReset();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/api/workspace/autopilot")
      return json({
        resources: built ? [{ resource_kind: "hosting", status: "provisioning", external_ref: {} }] : [],
        product_builder_enabled: true,
        build_app_intent: "fresh",
      });
    if (path.startsWith("/api/workspace/autopilot/build-status")) return json(built ? statusRun() : { run: null });
    if (path === BUILD_PATH) {
      built = true;
      return json({ ok: true, conductor_run_id: RUN });
    }
    if (path.startsWith("/api/workspace/autopilot/site-design?")) return json({ design: design() });
    if (path === DIRECTION && init?.method === "POST") {
      h.awaiting = false;
      h.started = true;
      return json({ started: true, design: design() });
    }
    return json({}, 404);
  });
});
afterEach(cleanup);

const posts = (path: string) => apiFetch.mock.calls.filter(([p, init]) => p === path && init?.method === "POST");

async function startBuildFromHome() {
  render(<BuilderChatCard />);
  const composer = await screen.findByLabelText("Describe the app you want your AI team to build");
  fireEvent.change(composer, { target: { value: "A bakery site for custom cakes" } });
  fireEvent.click(screen.getByRole("button", { name: "Build it" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Yes, build it" }));
  });
  await waitFor(() => expect(posts(BUILD_PATH)).toHaveLength(1));
}

describe("a founder who starts a build from Home can pick its look there", () => {
  it("the Home rail shows the three looks, a tile click posts nothing, Build with this look posts once and progress returns", async () => {
    await startBuildFromHome();
    const rail = await screen.findByLabelText("Build progress");
    const pick = await within(rail).findByTestId("build-status-pick", {}, { timeout: 4000 });
    expect(within(pick).getAllByTestId(/^look-tile-/)).toHaveLength(3);
    expect(within(rail).queryByRole("progressbar")).toBeNull();

    fireEvent.click(within(pick).getByTestId("look-tile-studio"));
    expect(posts(DIRECTION)).toHaveLength(0);
    fireEvent.click(within(pick).getByRole("button", { name: BUILD_WITH_LOOK }));
    await waitFor(() => expect(posts(DIRECTION)).toHaveLength(1));
    expect(JSON.parse(posts(DIRECTION)[0][1].body as string)).toEqual({ run_id: RUN, direction: "studio" });
    await waitFor(() => expect(within(rail).queryByTestId("build-status-pick")).toBeNull());
    await waitFor(() => expect(within(rail).getByRole("progressbar")).toBeTruthy(), { timeout: 4000 });
    expect(posts(DIRECTION)).toHaveLength(1);
    expect(posts(BUILD_PATH)).toHaveLength(1);
  });

  it("the rail opens the Build view on this build's session", async () => {
    await startBuildFromHome();
    const open = await screen.findByTestId("build-status-open-build", {}, { timeout: 4000 });
    fireEvent.click(open);
    expect(openBuildTab).toHaveBeenCalledTimes(1);
    expect(openBuildTab).toHaveBeenCalledWith(RUN, { push: true });
  });

  it("flag off: Home shows progress and no picker", async () => {
    h.flag = false;
    await startBuildFromHome();
    const rail = await screen.findByLabelText("Build progress");
    await waitFor(() => expect(apiFetch.mock.calls.some(([p]) => String(p).startsWith("/api/workspace/autopilot/site-design?"))).toBe(true), { timeout: 4000 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(within(rail).queryByTestId("build-status-pick")).toBeNull();
    expect(within(rail).getByRole("progressbar")).toBeTruthy();
    expect(posts(DIRECTION)).toHaveLength(0);
  });
});
