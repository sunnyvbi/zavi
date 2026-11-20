// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  uiFlags: {} as Record<string, boolean>,
  connectors: [] as Array<{ slug: string }>,
  connectorsFail: false,
  calls: [] as string[],
}));

vi.mock("@/lib/workspace/useGithubRepos", () => ({
  useGithubRepos: () => ({
    state: { status: "ok", connected: false, repos: [], default: null, hiddenByScope: 0 },
    pending: false,
    setDefault: vi.fn(),
  }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string) => {
    h.calls.push(url);
    if (url === "/api/connectors" && h.connectorsFail) return { ok: false, status: 500, json: async () => ({}) };
    return {
      ok: true,
      json: async () =>
        url === "/api/workspace/autopilot/build-sessions"
          ? { current_session_id: null, sessions: [], flags: {}, ui_flags: h.uiFlags }
          : url === "/api/connectors"
            ? { connectors: h.connectors }
            : {},
    };
  }),
}));

import { BuildComposerMenu } from "./BuildComposerMenu";
import { __resetBuildSessionsForTest } from "@/lib/workspace/useBuildSessions";
import { _resetBuildFigmaFrameForTests, pendingBuildFigmaFrame, settleBuildFigmaFrame } from "@/lib/workspace/buildFigmaFrame";

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function openMenu(onManage = vi.fn()) {
  render(<BuildComposerMenu selectedChannels={[]} onToggleChannel={() => {}} role="owner" onManageConnectors={onManage} />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Add to this build" }));
  await flush();
  return onManage;
}

beforeEach(() => {
  __resetBuildSessionsForTest();
  _resetBuildFigmaFrameForTests();
  h.uiFlags = { figma_handoff: true };
  h.connectors = [{ slug: "figma" }];
  h.connectorsFail = false;
  h.calls = [];
});

afterEach(() => cleanup());

describe("Build composer: build from a Figma frame", () => {
  it("flag off for the tenant: no Figma row and no connectors read", async () => {
    h.uiFlags = { figma_handoff: false };
    await openMenu();
    expect(document.querySelector("[data-figma-row]")).toBeNull();
    expect(h.calls).not.toContain("/api/connectors");
  });

  it("not connected: the row says so and sends the founder to connectors without attaching anything", async () => {
    h.connectors = [{ slug: "github" }];
    const onManage = await openMenu();
    const row = document.querySelector("[data-figma-row]") as HTMLElement;
    expect(row.textContent).toContain("Not connected");
    fireEvent.click(row);
    await flush();
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(pendingBuildFigmaFrame()).toBeNull();
  });

  it("connected: a non-figma link is refused with a message, a figma frame link is attached as key and node", async () => {
    await openMenu();
    fireEvent.click(document.querySelector("[data-figma-row]") as HTMLElement);
    await flush();
    const input = screen.getByPlaceholderText(/figma\.com\/design/);
    fireEvent.change(input, { target: { value: "https://evil.example/design/AbCdEf1234567890XYZ/x?node-id=1-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach frame" }));
    expect(screen.getByRole("alert").textContent).toMatch(/not a figma\.com frame link/);
    expect(pendingBuildFigmaFrame()).toBeNull();
    fireEvent.change(input, { target: { value: "https://www.figma.com/design/AbCdEf1234567890XYZ/Home?node-id=12-34" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach frame" }));
    await flush();
    expect(pendingBuildFigmaFrame()).toEqual({ file_key: "AbCdEf1234567890XYZ", node_id: "12:34" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.querySelector("[data-figma-attached]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add to this build" }));
    await flush();
    expect((document.querySelector("[data-figma-row]") as HTMLElement).textContent).toContain("Frame 12:34 attached");
  });

  it("the soft note from the build start shows beside the button and can be dismissed", async () => {
    render(<BuildComposerMenu selectedChannels={[]} onToggleChannel={() => {}} role="owner" onManageConnectors={() => {}} />);
    await flush();
    act(() => settleBuildFigmaFrame("Figma is busy right now, so this build starts from your idea alone."));
    expect(screen.getByRole("status").textContent).toContain("idea alone");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector("[data-figma-note]")).toBeNull();
  });
});
