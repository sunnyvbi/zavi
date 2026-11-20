// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactItem, artifactIconTone } from "./ArtifactItem";
import type { Artifact } from "./types";

const ARTIFACT: Artifact = {
  id: "artifact-1",
  run_id: "run-1",
  title: "Quarterly report",
  filename: "quarterly-report.pdf",
  mime: "application/pdf",
  type: "document",
  bytes: 4096,
  created_at: "2026-09-08T10:00:00Z",
  updated_at: "2026-09-08T10:00:00Z",
  preview_url: "https://files.example/report.pdf",
  source: {
    kind: "chat",
    id: "thread-1",
    title: "Research chat",
    href: "/workspace?agent=research&thread=thread-1",
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ArtifactItem image tile", () => {
  const IMAGE: Artifact = {
    ...ARTIFACT,
    id: "image-1",
    title: "Launch visual",
    filename: "launch.png",
    mime: "image/png",
    type: "image",
    preview_url: "https://files.example/launch.png",
  };

  it("grid view renders an image as a natural-height tile with a persistent caption, and a file as a square tile", () => {
    const { container } = render(
      <ArtifactItem
        artifact={IMAGE}
        view="grid"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-tile="image"]')).not.toBeNull();
    expect(container.querySelector('[data-fit="natural"]')).not.toBeNull();
    expect(screen.getByLabelText("Open Launch visual preview")).toBeTruthy();
    expect(screen.getByLabelText("Rename Launch visual")).toBeTruthy();
    expect(screen.getByLabelText("Download Launch visual")).toBeTruthy();
    expect(screen.getByLabelText("Delete Launch visual")).toBeTruthy();
    expect(screen.getByText("Image · Sep 8")).toBeTruthy();
    cleanup();

    const file = render(
      <ArtifactItem
        artifact={ARTIFACT}
        view="grid"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(file.container.querySelector('[data-tile="image"]')).toBeNull();
    expect(file.container.querySelector('[data-fit="natural"]')).toBeNull();
    expect(file.container.querySelector('[data-tile="file"]')?.className).toContain("aspect-[5/4]");
    expect(file.container.querySelector('[data-tile="file"] h2')?.className).toContain("line-clamp-3");
  });

  it("a tile's menu runs each action and closes; the title is said once, with no badge or source line", () => {
    const open = vi.fn();
    const download = vi.fn();
    render(
      <ArtifactItem
        artifact={ARTIFACT}
        view="grid"
        busy={false}
        onOpen={open}
        onRename={vi.fn()}
        onDownload={download}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Quarterly report")).toHaveLength(1);
    expect(screen.queryByText("Document")).toBeNull();
    expect(screen.queryByText("From Research chat")).toBeNull();
    expect(screen.getByText(/^Sep 8/)).toBeTruthy();
    const details = screen.getByLabelText("More actions for Quarterly report").closest("details")!;
    fireEvent.click(screen.getByLabelText("More actions for Quarterly report"));
    details.setAttribute("open", "");
    fireEvent.click(screen.getByLabelText("Download Quarterly report"));
    expect(download).toHaveBeenCalledTimes(1);
    expect(details.hasAttribute("open")).toBe(false);
    details.setAttribute("open", "");
    fireEvent.click(document.body);
    expect(details.hasAttribute("open")).toBe(false);
    details.setAttribute("open", "");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(details.hasAttribute("open")).toBe(false);
  });

  it("the menu is never clipped: no overflow-hidden between the popover and the tile root", () => {
    const { container } = render(
      <ArtifactItem
        artifact={IMAGE}
        view="grid"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const tile = container.querySelector('[data-tile="image"]') as HTMLElement;
    let node = screen.getByRole("menu", { hidden: true }).parentElement;
    while (node && node !== tile.parentElement) {
      expect(node.className).not.toContain("overflow-hidden");
      node = node.parentElement;
    }
  });

  it("grid view renders a website as a square page preview, a PDF with a red icon, a sheet green", () => {
    const site = render(
      <ArtifactItem
        artifact={{ ...ARTIFACT, id: "site-1", title: "Landing draft", filename: "landing.html", mime: "text/html", type: "website" }}
        view="grid"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const tile = site.container.querySelector('[data-tile="website"]') as HTMLElement;
    expect(tile.className).not.toContain("aspect-square");
    expect(tile.querySelector(".aspect-square")).not.toBeNull();
    expect(site.container.querySelector('[data-fit="fill"]')).not.toBeNull();
    expect(site.container.querySelector("[data-pending]")).not.toBeNull();
    expect(screen.getByLabelText("More actions for Landing draft")).toBeTruthy();
    cleanup();

    expect(artifactIconTone(ARTIFACT)).toBe("text-[#e5484d]");
    expect(artifactIconTone({ type: "spreadsheet", mime: "text/csv", filename: "x.csv" })).toBe("text-[#1f9d55]");
    expect(artifactIconTone({ type: "document", mime: "text/markdown", filename: "x.md" })).toBe("text-inkMuted");
    const pdf = render(
      <ArtifactItem
        artifact={ARTIFACT}
        view="grid"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(pdf.container.querySelector(".text-\\[\\#e5484d\\]")).not.toBeNull();
  });

  it("shows a bounded table glimpse for CSV files instead of a generic document icon", async () => {
    const fetchFile = vi.fn(async () =>
      new Response("Bike,Price,Range\nCity,25,40 km\nTouring,40,80 km\nCargo,55,35 km\n"),
    );
    vi.stubGlobal("fetch", fetchFile);
    const csv = {
      ...ARTIFACT,
      id: "csv-1",
      title: "Bike fleet",
      filename: "bike-fleet.csv",
      mime: "text/csv",
      type: "spreadsheet" as const,
      preview_url: "https://files.example/bike-fleet.csv",
    };

    const { container } = render(
      <ArtifactItem
        artifact={csv}
        view="grid"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(container.querySelector('[data-preview="csv"]')).not.toBeNull();
    expect(container.querySelector(".lucide-file-text")).toBeNull();
    await waitFor(() => expect(screen.getByText("Bike")).toBeTruthy());
    expect(screen.getByText("City")).toBeTruthy();
    expect(screen.getByText("25")).toBeTruthy();
    expect(fetchFile).toHaveBeenCalledWith(
      csv.preview_url,
      expect.objectContaining({
        headers: { Range: "bytes=0-49151" },
      }),
    );
  });

  it("a video tile carries a play badge, an image tile does not", () => {
    const video = render(
      <ArtifactItem
        artifact={{ ...IMAGE, id: "video-1", title: "Clip", filename: "clip.mp4", mime: "video/mp4", type: "video" }}
        view="grid"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(video.container.querySelector('[data-tile="video"] .lucide-play')).not.toBeNull();
    cleanup();
    const image = render(
      <ArtifactItem
        artifact={IMAGE}
        view="grid"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(image.container.querySelector(".lucide-play")).toBeNull();
  });

  it("list view keeps the image in the fixed thumbnail box", () => {
    const { container } = render(
      <ArtifactItem
        artifact={IMAGE}
        view="list"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-tile="image"]')).toBeNull();
    expect(container.querySelector('[data-fit="cover"]')).not.toBeNull();
  });
});

describe("ArtifactItem", () => {
  it("uses supplied disambiguating context for duplicate-title actions", () => {
    render(
      <ArtifactItem
        artifact={{ ...ARTIFACT, title: "hero-car" }}
        accessibilityName="hero-car, image, Sep 8, item 2 of 2"
        view="grid"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Open hero-car, image, Sep 8, item 2 of 2 preview")).toBeTruthy();
    expect(screen.getByLabelText("More actions for hero-car, image, Sep 8, item 2 of 2")).toBeTruthy();
  });

  it("renders the complete artifact metadata and actions", () => {
    render(
      <ArtifactItem
        artifact={ARTIFACT}
        view="grid"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Quarterly report")).toHaveLength(1);
    expect(screen.getByText(/^Sep 8/)).toBeTruthy();
    expect(screen.getByLabelText("Download Quarterly report")).toBeTruthy();
    expect(screen.getByLabelText("Delete Quarterly report")).toBeTruthy();
  });

  it("list view keeps the badge and the source line", () => {
    render(
      <ArtifactItem
        artifact={ARTIFACT}
        view="list"
        busy={false}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Document")).toBeTruthy();
    expect(screen.getByText("From Research chat")).toBeTruthy();
  });

  it("opens in the app instead of linking out to storage", () => {
    const open = vi.fn();
    render(
      <ArtifactItem
        artifact={ARTIFACT}
        view="grid"
        busy={false}
        onOpen={open}
        onRename={vi.fn()}
        onDownload={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const trigger = screen.getByLabelText("Open Quarterly report");
    expect(trigger.getAttribute("href")).toBeNull();
    fireEvent.click(trigger);
    expect(open).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Open Quarterly report preview"));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("renames inline and keeps delete separate from the source", async () => {
    const rename = vi.fn(async () => true);
    const remove = vi.fn(async () => true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ArtifactItem
        artifact={ARTIFACT}
        view="list"
        busy={false}
        onOpen={vi.fn()}
        onRename={rename}
        onDownload={vi.fn()}
        onDelete={remove}
      />,
    );
    fireEvent.click(screen.getByLabelText("Rename Quarterly report"));
    fireEvent.change(screen.getByLabelText("Artifact title"), { target: { value: "Board report" } });
    fireEvent.click(screen.getByLabelText("Save title"));
    await waitFor(() => expect(rename).toHaveBeenCalledWith("Board report"));
    fireEvent.click(screen.getByLabelText("Delete Quarterly report"));
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("source chat will stay intact"));
  });
});
