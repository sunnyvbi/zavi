// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { useCompactHeaderSlot } from "./compactHeaderSlot";

const seen: Array<HTMLElement | null> = [];

vi.mock("./ChannelsPage", () => ({
  useOpenChannelSlug: () => null,
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tabs: [{ id: "analytics", kind: "analytics", title: "Analytics" }],
    activeTabId: "analytics",
    openBuildTab: vi.fn(),
    buildSessionId: null,
  }),
}));
vi.mock("../WorkspacePane", () => ({
  WorkspacePane: () => {
    seen.push(useCompactHeaderSlot());
    return null;
  },
}));
vi.mock("../build/BuildModePane", () => ({
  BuildModePane: () => null,
}));

import { ChatColumn } from "./ChatColumn";

function column(fullPage: boolean) {
  return (
    <ChatColumn
      chrome={{ dropProps: {} } as never}
      fullPage={fullPage}
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
    />
  );
}

beforeEach(() => {
  seen.length = 0;
});

afterEach(cleanup);

describe("the compact header slot", () => {
  it("is already there on the pane's very first render of a deep-linked full page", () => {
    render(column(true));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBeInstanceOf(HTMLElement);
    expect(seen).not.toContain(null);
  });

  it("is attached inside the header row, so a portal into it lands in the document", () => {
    const { container } = render(column(true));
    const slot = seen[0]!;
    expect(container.contains(slot)).toBe(true);
    expect(slot.parentElement?.className).toContain("compact:flex");
  });

  it("survives the flip from the column layout to a full page without a null frame", () => {
    const { rerender } = render(column(false));
    const before = seen[0];
    expect(before).toBeInstanceOf(HTMLElement);
    seen.length = 0;
    rerender(column(true));
    expect(seen[0]).toBe(before);
    expect(seen).not.toContain(null);
  });

  it("keeps the host hidden while the column is not a full page", () => {
    render(column(false));
    const host = seen[0]!.parentElement!;
    expect(host.className.split(" ")).toContain("hidden");
    expect(host.className).not.toContain("compact:flex");
    expect(host.style.minWidth).toBe("");
  });
});
