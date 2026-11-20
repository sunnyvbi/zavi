// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/responsive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/responsive")>()),
  useIsCompact: () => false,
  useMediaMatch: () => false,
}));

const location = { value: "/workspace?tab=artifacts" };
vi.mock("../navigation/useWorkspaceLocation", () => ({
  useWorkspaceLocation: () => location.value,
}));
vi.mock("../navigation/workspaceRoutes", () => ({
  readWorkspaceLocation: () => location.value,
  replaceWorkspaceLocation: () => {},
}));
const openBuildTab = vi.fn();
vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ openAgentTab: () => {}, openBuildTab }),
}));
const data = {
  artifacts: [] as Array<Record<string, unknown>>,
  sites: [] as Array<Record<string, unknown>>,
  error: null as string | null,
};
vi.mock("./useArtifacts", () => ({
  useArtifacts: () => ({
    artifacts: data.artifacts,
    sites: data.sites,
    loading: false,
    error: data.error,
    busyId: null,
    reload: () => {},
    remove: () => {},
    rename: () => {},
  }),
}));
vi.mock("./ArtifactItem", () => ({
  ArtifactItem: ({ artifact }: { artifact: { id: string } }) => <div data-testid="file" data-id={artifact.id} />,
}));
vi.mock("./ArtifactStates", () => ({
  ArtifactEmpty: () => <div data-testid="empty" />,
  ArtifactError: () => <div data-testid="error" />,
  ArtifactLoading: () => <div data-testid="loading" />,
}));

import { ArtifactsTab } from "./ArtifactsTab";

const file = (id: string, created_at: string, type = "website") => ({
  id,
  run_id: "r1",
  title: `Draft ${id}`,
  filename: `${id}.html`,
  mime: "text/html",
  type,
  bytes: 12,
  created_at,
  updated_at: created_at,
  preview_url: null,
  source: { kind: "chat", id: "c1", title: "Chat", href: "/x" },
});

const site = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  title: "Mile High Coffee",
  hostname: "mile-high-coffee-693dfbdb-523441.zaviagent.com",
  status: "live",
  live_url: "https://mile-high-coffee-693dfbdb-523441.zaviagent.com",
  build_session_id: "11111111-1111-4111-8111-111111111111",
  created_at: "2026-10-01T12:23:18Z",
  updated_at: "2026-10-01T12:27:21Z",
  ...over,
});

const order = () =>
  Array.from(document.querySelectorAll("[data-site-artifact], [data-testid=file]")).map(
    (el) => el.getAttribute("data-site-artifact") ?? el.getAttribute("data-id"),
  );

afterEach(() => {
  cleanup();
  openBuildTab.mockReset();
  location.value = "/workspace?tab=artifacts";
  data.artifacts = [];
  data.sites = [];
  data.error = null;
});

describe("Artifacts lists built websites (QA B35)", () => {
  it("shows a built site under Websites with its clean name, status and live link", () => {
    location.value = "/workspace?tab=artifacts&artifact_type=website";
    data.sites = [site()];
    data.artifacts = [file("seo-draft", "2026-09-25T00:00:00Z")];
    render(<ArtifactsTab />);
    expect(screen.getAllByText("Mile High Coffee").length).toBeGreaterThan(0);
    expect(screen.getByText("Live")).toBeTruthy();
    const live = screen.getByLabelText("Open Mile High Coffee live site") as HTMLAnchorElement;
    expect(live.href).toBe("https://mile-high-coffee-693dfbdb-523441.zaviagent.com/");
    expect(live.target).toBe("_blank");
    expect(order()).toEqual(["s1", "seo-draft"]);
  });

  it("opens the site's Build session", () => {
    data.sites = [site()];
    render(<ArtifactsTab />);
    fireEvent.click(screen.getByLabelText("Open Mile High Coffee in Build"));
    expect(openBuildTab).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", { push: true });
  });

  it("has no open button when the session is gone, and no live link when the site is not live", () => {
    data.sites = [site({ build_session_id: null, status: "paused", live_url: null })];
    render(<ArtifactsTab />);
    expect(screen.queryByLabelText("Open Mile High Coffee in Build")).toBeNull();
    expect(screen.queryByLabelText("Open Mile High Coffee live site")).toBeNull();
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("lists finished sites only: building, publishing and failed stay in Build", () => {
    data.sites = [
      site({ id: "live" }),
      site({ id: "building", status: "building", live_url: null }),
      site({ id: "provisioning", status: "provisioning", live_url: null }),
      site({ id: "publishing", status: "publishing", live_url: null }),
      site({ id: "failed", status: "failed", live_url: null }),
      site({ id: "paused", status: "paused", live_url: null }),
      site({ id: "unpublished", status: "building", live_url: null, built: true }),
    ];
    render(<ArtifactsTab />);
    expect(order()).toEqual(["live", "paused", "unpublished"]);
    expect(screen.getByText("Not published")).toBeTruthy();
    expect(screen.queryByText("Building")).toBeNull();
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("hides sites under another type and filters them by search", () => {
    data.sites = [site(), site({ id: "s2", title: "Lucky Paws", hostname: "lucky-paws-693dfbdb-687f66.zaviagent.com" })];
    location.value = "/workspace?tab=artifacts&artifact_type=image";
    const { unmount } = render(<ArtifactsTab />);
    expect(order()).toEqual([]);
    expect(screen.getByTestId("empty")).toBeTruthy();
    unmount();

    location.value = "/workspace?tab=artifacts&q=lucky";
    render(<ArtifactsTab />);
    expect(order()).toEqual(["s2"]);
  });

  it("a failed refresh still shows its error when only sites are listed", () => {
    data.sites = [site()];
    data.error = "Could not load your artifacts.";
    render(<ArtifactsTab />);
    expect(screen.getByRole("alert").textContent).toContain("Could not load your artifacts.");
    expect(screen.getAllByText("Mile High Coffee").length).toBeGreaterThan(0);
  });

  it("shows the site's screenshot as its card, and the globe when it has none or it fails to load", () => {
    data.sites = [
      site({ id: "shot", thumbnail_url: "https://storage.example/t/s/site-thumb-0123456789ab.jpg?token=x" }),
      site({ id: "none", title: "Lucky Paws", thumbnail_url: null }),
    ];
    const { container } = render(<ArtifactsTab />);
    const shot = container.querySelector('[data-site-artifact="shot"] img[data-site-thumbnail]') as HTMLImageElement;
    expect(shot.src).toContain("site-thumb-0123456789ab.jpg");
    expect(shot.alt).toBe("Preview of Mile High Coffee");
    expect(container.querySelector('[data-site-artifact="shot"] [data-site-status="Live"]')).toBeTruthy();
    expect(container.querySelector('[data-site-artifact="none"] img')).toBeNull();
    fireEvent.error(shot);
    expect(container.querySelector('[data-site-artifact="shot"] img[data-site-thumbnail]')).toBeNull();
  });

  it("a site alone is not an empty page", () => {
    data.sites = [site()];
    render(<ArtifactsTab />);
    expect(screen.queryByTestId("empty")).toBeNull();
  });
});
