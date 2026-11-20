// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/builderClarifyFlag", () => ({
  isBuilderClarifyEnabled: () => true,
  isBuilderClarifyDynamicEnabled: () => false,
}));
let role: string | null = "member";
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tenantName: "Acme",
    creditsEnforced: false,
    builderRetryNonce: 0,
    ackBuilderRetry: () => {},
    role,
  }),
}));
vi.mock("../useProductUrl", () => ({
  useProductUrlState: () => ({ status: "ok", value: {} }),
}));
vi.mock("./LiveAppCard", () => ({ LiveAppCard: () => null }));
vi.mock("./BuildStatusPanel", () => ({ BuildStatusPanel: () => null }));
vi.mock("./BuilderThread", () => ({ BuilderThread: () => null }));
vi.mock("./ThemeControls", () => ({ ThemeControls: () => null }));
vi.mock("@/components/workspace/Markdown", () => ({ Markdown: () => null }));

import { BuilderChatCard } from "./BuilderChatCard";
import { START_SITE_ROLE_ERROR, START_SITE_VIEWER_ERROR } from "@/lib/workspace/buildRoles";

const BUILD_PATH = "/api/workspace/autopilot/build-product";
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  window.sessionStorage.clear();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/api/workspace/autopilot")
      return json({ resources: [], product_builder_enabled: true, build_app_intent: "fresh" });
    if (path.startsWith("/api/workspace/autopilot/build-status")) return json({ run: null });
    if (path === BUILD_PATH) return json({ ok: true, conductor_run_id: "run-1" });
    return { ok: false, status: 404, json: async () => ({}) };
  });
});
afterEach(cleanup);

async function ask(idea: string) {
  render(<BuilderChatCard />);
  const composer = await screen.findByLabelText("Describe the app you want your AI team to build");
  fireEvent.change(composer, { target: { value: idea } });
  fireEvent.click(screen.getByRole("button", { name: "Build it" }));
}

describe("the Home build card tells a member up front that only an owner or admin starts a site", () => {
  it("a member gets the refusal, no questions, no confirm, and nothing is posted", async () => {
    role = "member";
    await ask("A site for a neighbourhood bike repair shop");
    expect(screen.getByText(START_SITE_ROLE_ERROR)).toBeTruthy();
    expect(screen.queryByLabelText("Type a name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Yes, build it" })).toBeNull();
    expect(apiFetch.mock.calls.filter(([p]) => p === BUILD_PATH)).toHaveLength(0);
  });

  it("a viewer is not told they can change sites", async () => {
    role = "viewer";
    await ask("A site for a neighbourhood bike repair shop");
    expect(screen.getByText(START_SITE_VIEWER_ERROR)).toBeTruthy();
  });

  it("an owner still gets the questions", async () => {
    role = "owner";
    await ask("A site for a neighbourhood bike repair shop");
    expect(screen.getByLabelText("Type a name")).toBeTruthy();
    expect(screen.queryByText(START_SITE_ROLE_ERROR)).toBeNull();
  });
});
