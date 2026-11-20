// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("./ChannelsPage", () => ({
  useOpenChannelSlug: () => null,
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tabs: [{ id: "artifacts", kind: "artifacts", title: "Artifacts" }],
    activeTabId: "artifacts",
    openBuildTab: vi.fn(),
    buildSessionId: null,
  }),
}));
vi.mock("../WorkspacePane", () => ({
  WorkspacePane: () => <div data-testid="pane" />,
}));
vi.mock("../build/BuildModePane", () => ({
  BuildModePane: () => <div data-testid="build-pane" />,
}));

import { ChatColumn } from "./ChatColumn";

function renderFullPage() {
  return render(
    <ChatColumn
      chrome={{ dropProps: {} } as never}
      compactLeading={
        <button type="button" aria-label="Open navigation" className="h-11 w-11">
          menu
        </button>
      }
      fullPage
      onExitFullPage={() => {}}
      chatFocus={false}
      workspaceMode="grow"
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

afterEach(cleanup);

describe("full-page header on a phone", () => {
  it("lays the hamburger and the Back arrow out on one line", () => {
    renderFullPage();
    const menu = screen.getByRole("button", { name: "Open navigation" });
    const back = screen.getByRole("button", { name: "Back to chat" });

    expect(menu.parentElement).toBe(back.parentElement);
    const row = back.parentElement as HTMLElement;
    expect(row.className).toContain("flex");
    expect(row.className).toContain("items-center");
  });

  it("gives the Back arrow a real tap target at phone widths", () => {
    renderFullPage();
    const back = screen.getByRole("button", { name: "Back to chat" });

    expect(back.className).toContain("compact:h-12");
    expect(back.className).toContain("compact:w-12");
  });
});

describe("the phone header does not start at the very top edge", () => {
  it("pads the row above the controls, without shrinking the 56px row", () => {
    renderFullPage();
    const row = screen
      .getByRole("button", { name: "Open navigation" })
      .closest("div")?.parentElement as HTMLElement;

    expect(row.className).toContain("compact:h-14");
    expect(row.className).toContain("compact:pt-2");
    expect(row.className).not.toContain("compact:pt-0");
  });
});
