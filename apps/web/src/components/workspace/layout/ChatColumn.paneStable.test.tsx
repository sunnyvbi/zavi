// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { cleanup, render } from "@testing-library/react";

const h = vi.hoisted(() => ({ kind: "home" as string, mounts: 0 }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tabs: [{ id: "t1", kind: h.kind, title: "Tab" }],
    activeTabId: "t1",
    openBuildTab: vi.fn(),
    buildSessionId: null,
  }),
}));
vi.mock("../WorkspacePane", () => ({
  WorkspacePane: () => {
    useEffect(() => {
      h.mounts += 1;
    }, []);
    return <div data-testid="pane" />;
  },
}));
vi.mock("../build/BuildModePane", () => ({ BuildModePane: () => null }));
vi.mock("../build/ExistingProductPane", () => ({ ExistingProductPane: () => null }));
vi.mock("../useProductUrl", () => ({
  useProductUrlState: () => ({ status: "ok", value: {} }),
  retryProductUrl: vi.fn(),
}));

import { ChatColumn } from "./ChatColumn";

const column = (fullPage: boolean) => (
  <ChatColumn
    chrome={{ dropProps: {}, grip: null } as never}
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

afterEach(() => {
  cleanup();
  h.kind = "home";
  h.mounts = 0;
});

it("keeps one WorkspacePane mounted across Home -> Growth -> Home", () => {
  const view = render(column(false));
  h.kind = "autopilot";
  view.rerender(column(true));
  h.kind = "home";
  view.rerender(column(false));
  expect(h.mounts).toBe(1);
});
