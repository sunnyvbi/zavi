// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const workspace = vi.hoisted(() => ({ buildSessionId: null as string | null }));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({
    tabs: [{ id: "b1", kind: "build", title: "Build" }],
    activeTabId: "b1",
    openBuildTab: vi.fn(),
    buildSessionId: workspace.buildSessionId,
  }),
}));
vi.mock("../WorkspacePane", () => ({
  WorkspacePane: () => <div data-testid="pane" />,
}));
vi.mock("../build/BuildModePane", () => ({
  BuildModePane: () => <div data-testid="build-pane" />,
}));
vi.mock("../build/ExistingProductPane", () => ({
  ExistingProductPane: () => <div data-testid="existing-product-pane" />,
}));

const productUrl = vi.hoisted(() => ({
  state: { status: "loading" } as
    | { status: "loading" }
    | { status: "ok"; value: { marketing?: string } }
    | { status: "error" },
}));
vi.mock("../useProductUrl", () => ({
  useProductUrlState: () => productUrl.state,
}));
const buildSessions = vi.hoisted(() => ({
  state: { sessions: [] as Array<{ id: string; state: string }>, loaded: true, failed: false },
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  useBuildSessions: () => buildSessions.state,
}));

import { ChatColumn } from "./ChatColumn";

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
  productUrl.state = { status: "loading" };
  workspace.buildSessionId = null;
  buildSessions.state = { sessions: [], loaded: true, failed: false };
});

describe("Build surface vs a tenant who already has a product", () => {
  it("shows the idea composer to a tenant with no product of their own", async () => {
    productUrl.state = { status: "ok", value: {} };
    renderColumn();
    await waitFor(() => expect(screen.getByTestId("build-pane")).toBeTruthy());
    expect(screen.queryByTestId("existing-product-pane")).toBeNull();
  });

  it("shows the idea composer when the registered URL is a Zavi-built app", async () => {
    productUrl.state = {
      status: "ok",
      value: { marketing: "https://upcarai-6ec4d609.onrender.com" },
    };
    renderColumn();
    await waitFor(() => expect(screen.getByTestId("build-pane")).toBeTruthy());
  });

  it("does NOT show the idea composer to a tenant with their own site", async () => {
    productUrl.state = {
      status: "ok",
      value: { marketing: "https://www.upcar.ai" },
    };
    renderColumn();
    await waitFor(() =>
      expect(screen.getByTestId("existing-product-pane")).toBeTruthy(),
    );
    expect(screen.queryByTestId("build-pane")).toBeNull();
  });

  it("shows neither while the product read is still pending", () => {
    productUrl.state = { status: "loading" };
    renderColumn();
    expect(screen.queryByTestId("build-pane")).toBeNull();
    expect(screen.queryByTestId("existing-product-pane")).toBeNull();
  });

  it("shows neither when the product read FAILED", () => {
    productUrl.state = { status: "error" };
    renderColumn();
    expect(screen.queryByTestId("build-pane")).toBeNull();
    expect(screen.queryByTestId("existing-product-pane")).toBeNull();
  });

  it("a tenant whose registered site is external but who already has a Zavi build keeps the builder, not the own-repo engineer", async () => {
    productUrl.state = { status: "ok", value: { marketing: "https://mohit.dev" } };
    buildSessions.state = { sessions: [{ id: "d130919a-bec1-48bc-9dbf-fba65217f05a", state: "ready" }], loaded: true, failed: false };
    renderColumn();
    await waitFor(() => expect(screen.getByTestId("build-pane")).toBeTruthy());
    expect(screen.queryByTestId("existing-product-pane")).toBeNull();
  });

  it("an external site with no Zavi build waits for the session list before offering the own-repo engineer", async () => {
    productUrl.state = { status: "ok", value: { marketing: "https://mohit.dev" } };
    buildSessions.state = { sessions: [], loaded: false, failed: false };
    const { rerender } = renderColumn();
    expect(screen.queryByTestId("build-pane")).toBeNull();
    expect(screen.queryByTestId("existing-product-pane")).toBeNull();
    buildSessions.state = { sessions: [], loaded: true, failed: false };
    rerender(
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
    await waitFor(() => expect(screen.getByTestId("existing-product-pane")).toBeTruthy());
    expect(screen.queryByTestId("build-pane")).toBeNull();
  });

  it("a failed session read settles the choice instead of leaving the Build tab blank", async () => {
    productUrl.state = { status: "ok", value: { marketing: "https://mohit.dev" } };
    buildSessions.state = { sessions: [], loaded: false, failed: true };
    renderColumn();
    await waitFor(() => expect(screen.getByTestId("existing-product-pane")).toBeTruthy());
  });

  it("shows the build a tenant with their own site already started", async () => {
    productUrl.state = { status: "ok", value: { marketing: "https://mohit.dev" } };
    workspace.buildSessionId = "d130919a-bec1-48bc-9dbf-fba65217f05a";
    renderColumn();
    await waitFor(() => expect(screen.getByTestId("build-pane")).toBeTruthy());
    expect(screen.queryByTestId("existing-product-pane")).toBeNull();
  });

  it("shows the bound build without waiting on the product read", () => {
    productUrl.state = { status: "loading" };
    workspace.buildSessionId = "d130919a-bec1-48bc-9dbf-fba65217f05a";
    renderColumn();
    expect(screen.getByTestId("build-pane")).toBeTruthy();
  });

  it("shows the bound build when the product read failed", () => {
    productUrl.state = { status: "error" };
    workspace.buildSessionId = "d130919a-bec1-48bc-9dbf-fba65217f05a";
    renderColumn();
    expect(screen.getByTestId("build-pane")).toBeTruthy();
    expect(screen.queryByText("Could not load your product details.")).toBeNull();
  });
});
