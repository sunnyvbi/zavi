// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const openChannel = { slug: null as string | null };

vi.mock("./ChannelsPage", () => ({
  useOpenChannelSlug: () => openChannel.slug,
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tabs: [{ id: "channels", kind: "channels", title: "Growth Channels" }],
    activeTabId: "channels",
    openBuildTab: vi.fn(),
    buildSessionId: null,
  }),
}));
vi.mock("../WorkspacePane", () => ({
  WorkspacePane: () => <div data-testid="pane" />,
}));
vi.mock("../build/BuildModePane", () => ({
  BuildModePane: () => null,
}));

import { ChatColumn } from "./ChatColumn";

function renderChannelsPage() {
  return render(
    <ChatColumn
      chrome={{ dropProps: {} } as never}
      compactLeading={
        <button type="button" aria-label="Open navigation" className="h-11 w-11">
          menu
        </button>
      }
      fullPage
      showExitFullPage={false}
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

const headerRow = () =>
  screen.getByRole("heading", { name: "Growth Channels" })
    .parentElement as HTMLElement;

afterEach(() => {
  openChannel.slug = null;
  cleanup();
});

describe("the shell's page header on the channels surface", () => {
  it("draws the page title on the channel LIST, where it is the only header", () => {
    renderChannelsPage();

    expect(headerRow().className.split(/\s+/)).not.toContain("compact:hidden");
  });

  it("gets out of the way on a phone once a channel's own header is on screen", () => {
    openChannel.slug = "linkedin_ads";
    renderChannelsPage();

    expect(headerRow().className.split(/\s+/)).toContain("compact:hidden");
  });

  it("keeps the desktop header in both states — the fold is phone-only", () => {
    openChannel.slug = "linkedin_ads";
    renderChannelsPage();
    const inChannel = headerRow().className;
    cleanup();
    openChannel.slug = null;
    renderChannelsPage();
    const onList = headerRow().className;

    for (const cls of ["absolute", "left-2", "top-2", "compact:static", "compact:h-14"]) {
      expect(inChannel.split(/\s+/)).toContain(cls);
      expect(onList.split(/\s+/)).toContain(cls);
    }
    expect(inChannel.split(/\s+/)).not.toContain("hidden");
    expect(onList.split(/\s+/)).not.toContain("hidden");
  });

  it("still names the surface for a screen reader while the title is folded away", () => {
    openChannel.slug = "linkedin_ads";
    renderChannelsPage();

    expect(
      screen.getByRole("region", { name: "Growth Channels" }),
    ).toBeTruthy();
  });
});
