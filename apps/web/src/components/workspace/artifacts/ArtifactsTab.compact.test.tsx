// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const compact = { value: true };
vi.mock("@/lib/responsive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/responsive")>()),
  useIsCompact: () => compact.value,
  useMediaMatch: () => compact.value,
}));

const location = { value: "/workspace?tab=artifacts" };
vi.mock("../navigation/useWorkspaceLocation", () => ({
  useWorkspaceLocation: () => location.value,
}));
vi.mock("../navigation/workspaceRoutes", () => ({
  readWorkspaceLocation: () => "/workspace?tab=artifacts",
  replaceWorkspaceLocation: () => {},
}));
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ openAgentTab: () => {} }),
}));
const artifacts = { value: [] as Array<Record<string, unknown>> };
vi.mock("./useArtifacts", () => ({
  useArtifacts: () => ({
    artifacts: artifacts.value,
    loading: false,
    error: null,
    busyId: null,
    reload: () => {},
    remove: () => {},
    rename: () => {},
  }),
}));

vi.mock("./ArtifactItem", () => ({
  ArtifactItem: ({ view }: { view: string }) => <div data-testid="item" data-view={view} />,
}));
vi.mock("./ArtifactStates", () => ({
  ArtifactEmpty: () => <div data-testid="empty" />,
  ArtifactError: () => <div data-testid="error" />,
  ArtifactLoading: ({ view }: { view: string }) => <div data-testid="loading" data-view={view} />,
}));

import { ArtifactsTab } from "./ArtifactsTab";

const one = {
  id: "a1",
  run_id: "r1",
  title: "Plan",
  filename: "plan.md",
  mime: "text/markdown",
  type: "document",
  bytes: 12,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  preview_url: null,
  source: { kind: "chat", id: "c1", title: "Chat", href: "/x" },
};

const page = () =>
  document.querySelector<HTMLElement>(".min-h-full") as HTMLElement;

afterEach(() => {
  cleanup();
  compact.value = true;
  location.value = "/workspace?tab=artifacts";
  artifacts.value = [];
});

describe("Artifacts page padding", () => {
  it("does not print a second, empty header row under the phone's own", () => {
    render(<ArtifactsTab />);
    expect(page().className).toContain("compact:pt-3");
  });

  it("keeps the desktop padding that clears the floating back arrow", () => {
    render(<ArtifactsTab />);
    expect(page().className).toContain("pt-14");
  });

  it("uses a phone gutter, not a desktop one", () => {
    render(<ArtifactsTab />);
    expect(page().className).toContain("compact:px-4");
    expect(page().className).toContain("px-6");
  });
});

describe("Artifact type tabs", () => {
  it("desktop shows the tab row with the active type selected; a phone keeps the dropdown", () => {
    compact.value = false;
    location.value = "/workspace?tab=artifacts&artifact_type=image";
    render(<ArtifactsTab />);
    const tabs = screen.getByRole("tablist", { name: "Artifact type" });
    expect(tabs.className).toContain("sm:flex");
    expect(screen.getByRole("tab", { name: "Images" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByLabelText(/Filter artifacts by type/).closest(".sm\\:hidden")).not.toBeNull();
  });
});

describe("Artifacts view on a phone", () => {
  it("shows a grid even when a shared link asks for the list the phone cannot switch away from", () => {
    location.value = "/workspace?tab=artifacts&artifact_view=list";
    artifacts.value = [one];
    render(<ArtifactsTab />);
    const item = screen.getByTestId("item");
    expect(item.getAttribute("data-view")).toBe("grid");
    expect(item.parentElement?.className).toContain("break-inside-avoid");
    expect(item.parentElement?.parentElement?.className).toContain("columns-[");
    expect(item.parentElement?.parentElement?.className).not.toContain("space-y-3");
  });

  it("still honours the list view on a desktop", () => {
    compact.value = false;
    location.value = "/workspace?tab=artifacts&artifact_view=list";
    artifacts.value = [one];
    render(<ArtifactsTab />);
    const item = screen.getByTestId("item");
    expect(item.getAttribute("data-view")).toBe("list");
    expect(item.parentElement?.className).toBe("");
    expect(item.parentElement?.parentElement?.className).toContain("space-y-3");
  });
});
