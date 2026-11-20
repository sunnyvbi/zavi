// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const workspace = vi.hoisted(() => ({
  kind: "build" as "build" | "home",
  buildSessionId: null as string | null,
  openBuildTab: vi.fn(),
}));
const buildPane = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tabs: [{ id: "t1", kind: workspace.kind, title: "Tab" }],
    activeTabId: "t1",
    openBuildTab: workspace.openBuildTab,
    buildSessionId: workspace.buildSessionId,
  }),
}));
vi.mock("../WorkspacePane", () => ({
  WorkspacePane: () => <div data-testid="pane" />,
}));
vi.mock("../build/BuildModePane", () => ({
  BuildModePane: (props: Record<string, unknown>) => {
    buildPane.props = props;
    return <div data-testid="build-pane" />;
  },
}));
vi.mock("../build/ExistingProductPane", () => ({
  ExistingProductPane: () => <div data-testid="existing-product-pane" />,
}));
vi.mock("../useProductUrl", () => ({
  useProductUrlState: () => ({ status: "ok", value: {} }),
}));

import { ChatColumn } from "./ChatColumn";
import { BUILD_CHAT_DEFAULT_PX, BUILD_CHAT_MIN_PX } from "./buildSplit";

function renderColumn() {
  return render(
    <ChatColumn
      chrome={{ dropProps: {} } as never}
      fullPage={false}
      onExitFullPage={() => {}}
      chatFocus={false}
      workspaceMode="build"
      previewOpen={false}
      buildFocusNonce={0}
      buildResetNonce={0}
      onResetBuild={() => {}}
      onOpenBuildPreview={() => {}}
      onCloseBuildPreview={() => {}}
      onBuildPreviewUnavailable={() => {}}
      onBuildPreviewProgress={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  workspace.kind = "build";
  workspace.buildSessionId = null;
  workspace.openBuildTab.mockReset();
  buildPane.props = null;
});

describe("the build chat pane", () => {
  it("sits on grey, not on the chat cream", async () => {
    renderColumn();
    const pane = await screen.findByLabelText("Build");
    expect(pane.className).toContain("bg-[#f9f9f9]");
    expect(pane.className).not.toContain("bg-cream");
  });

  it("hands dark mode a hook so the grey is a LIGHT-mode change only", async () => {
    renderColumn();
    const pane = await screen.findByLabelText("Build");
    expect(pane.className).toContain("build-chat-card");
    expect(pane.className).not.toContain("bg-bone");
  });

  it("carries the same 16px radius as the preview card beside it", async () => {
    renderColumn();
    const pane = await screen.findByLabelText("Build");
    expect(pane.className).toContain("rounded-2xl");
  });

  it("keeps a hover that is visible against grey", async () => {
    workspace.buildSessionId = "build-1";
    renderColumn();
    await waitFor(() => expect(screen.getByTestId("build-pane")).toBeTruthy());
    const newBuild = screen.getByRole("button", { name: "New build" });
    expect(newBuild.className).toContain("hover:bg-cream");
    expect(newBuild.className).not.toContain("hover:bg-bone");
    expect(newBuild.className).toContain("build-chat-hover");
  });

  it("does not repeat the new-build action on the cold-start composer", async () => {
    renderColumn();
    await waitFor(() => expect(screen.getByTestId("build-pane")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "New build" })).toBeNull();
  });

  it("leaves every other chat surface on cream", async () => {
    workspace.kind = "home";
    renderColumn();
    const pane = await screen.findByLabelText("Chat");
    expect(pane.className).toContain("bg-cream");
    expect(pane.className).toContain("rounded-2xl");
  });

  it("honors the Build activation intent captured when submission began", async () => {
    workspace.kind = "home";
    renderColumn();
    await waitFor(() => expect(buildPane.props).toBeTruthy());

    const open = buildPane.props?.onOpenSession as
      | ((id: string, activate?: boolean) => void)
      | undefined;
    open?.("run-delayed", true);

    expect(workspace.openBuildTab).toHaveBeenCalledWith("run-delayed", {
      activate: true,
    });
  });

  it("opens narrow enough to leave the preview the room", () => {
    expect(BUILD_CHAT_DEFAULT_PX).toBe(360);
    expect(BUILD_CHAT_DEFAULT_PX).toBeGreaterThanOrEqual(BUILD_CHAT_MIN_PX);
  });
});
