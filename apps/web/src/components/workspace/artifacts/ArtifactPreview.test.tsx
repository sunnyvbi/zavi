// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
import { ArtifactPreview, knownAspectRatio, resetAspectRatiosForTests } from "./ArtifactPreview";
import { MAX_INLINE_BYTES } from "./artifactRender";
import type { Artifact } from "./types";

let intersectionCallbacks: IntersectionObserverCallback[] = [];

const baseArtifact: Artifact = {
  id: "image-1",
  run_id: "run-1",
  title: "Campaign visual",
  filename: "campaign.png",
  mime: "image/png",
  type: "image",
  bytes: 1024,
  created_at: "2026-09-15T00:00:00Z",
  updated_at: "2026-09-15T00:00:00Z",
  preview_url: "https://storage.example/campaign.png",
  source: {
    kind: "task",
    id: "run-1",
    title: "Agent task",
    href: "/workspace/runs/run-1",
  },
};

const THUMB = "https://storage.example/render/campaign.png?width=480";
let seq = 0;
const nextId = () => `image-${++seq}`;

function thumbOk(url = THUMB) {
  apiFetch.mockImplementation(async (_path: string, init?: { body?: string }) => {
    const ids = (JSON.parse(init?.body ?? "{}") as { ids?: string[] }).ids ?? [];
    return { ok: true, json: async () => ({ thumbnails: Object.fromEntries(ids.map((id) => [id, url])) }) };
  });
}

beforeEach(() => {
  apiFetch.mockReset();
  intersectionCallbacks = [];
  vi.stubGlobal(
    "IntersectionObserver",
    vi.fn((callback: IntersectionObserverCallback) => {
      intersectionCallbacks.push(callback);
      return {
        observe: vi.fn(),
        disconnect: vi.fn(),
        unobserve: vi.fn(),
        takeRecords: vi.fn(() => []),
      };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetAspectRatiosForTests();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

function enterViewport() {
  act(() => {
    for (const callback of intersectionCallbacks) {
      callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
}

function loadWithSize(img: HTMLElement, width: number, height: number) {
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  act(() => {
    img.dispatchEvent(new Event("load"));
  });
}

describe("ArtifactPreview natural fit (the gallery sizes a tile by its image)", () => {
  const img = () => screen.queryByAltText("Preview of Campaign visual");
  const frame = () => document.querySelector<HTMLElement>("[data-fit]")!;

  it("cover fit keeps the fixed card frame, so the list and the file cards are unchanged", async () => {
    thumbOk();
    render(<ArtifactPreview artifact={{ ...baseArtifact, id: nextId() }} />);
    enterViewport();
    await waitFor(() => expect(img()).not.toBeNull());
    expect(frame().getAttribute("data-fit")).toBe("cover");
    expect(frame().className).toContain("h-44");
    expect(img()!.className).toContain("object-cover");
    loadWithSize(img()!, 300, 900);
    expect(frame().style.aspectRatio).toBe("");
  });

  it("natural fit shows a shimmer, never the icon, while the thumbnail is on its way", async () => {
    let release: () => void = () => {};
    apiFetch.mockImplementation(
      (_path: string, init?: { body?: string }) =>
        new Promise((resolve) => {
          const ids = (JSON.parse(init?.body ?? "{}") as { ids?: string[] }).ids ?? [];
          release = () =>
            resolve({ ok: true, json: async () => ({ thumbnails: Object.fromEntries(ids.map((id) => [id, THUMB])) }) });
        }),
    );
    const artifact = { ...baseArtifact, id: nextId() };
    const { container } = render(<ArtifactPreview artifact={artifact} fit="natural" />);
    expect(container.querySelector("[data-pending]")).not.toBeNull();
    expect(screen.queryByText("Campaign visual")).toBeNull();
    enterViewport();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(container.querySelector("[data-pending]")).not.toBeNull();
    release();
    await waitFor(() => expect(img()).not.toBeNull());
    expect(container.querySelector("[data-pending]")).toBeNull();
  });

  it("natural fit with no preview at all falls back to the icon tile", () => {
    const { container } = render(
      <ArtifactPreview artifact={{ ...baseArtifact, id: nextId(), preview_url: null }} fit="natural" />,
    );
    enterViewport();
    expect(container.querySelector("[data-pending]")).toBeNull();
    expect(screen.getByText("Campaign visual")).toBeTruthy();
  });

  it("natural fit lets the image set the tile height and pins the ratio once it is known", async () => {
    thumbOk();
    const artifact = { ...baseArtifact, id: nextId() };
    render(<ArtifactPreview artifact={artifact} fit="natural" />);
    enterViewport();
    await waitFor(() => expect(img()).not.toBeNull());
    expect(frame().getAttribute("data-fit")).toBe("natural");
    expect(frame().className).not.toContain("h-44");
    expect(frame().className).toContain("min-h-32");
    expect(img()!.className).toContain("h-auto");
    expect(img()!.className).not.toContain("object-cover");
    loadWithSize(img()!, 300, 900);
    expect(frame().style.aspectRatio).toBe(String(1 / 3));
    expect(frame().className).not.toContain("min-h-32");
    expect(knownAspectRatio(artifact.id)).toBeCloseTo(1 / 3);
  });

  it("the remembered ratio survives a new browser session, and a first write never wipes older entries", async () => {
    window.localStorage.setItem("zavi:artifact-ratios", JSON.stringify({ "older-image": 2 }));
    resetAspectRatiosForTests();
    thumbOk();
    const artifact = { ...baseArtifact, id: nextId() };
    render(<ArtifactPreview artifact={artifact} fit="natural" />);
    enterViewport();
    await waitFor(() => expect(img()).not.toBeNull());
    loadWithSize(img()!, 1600, 900);
    const stored = JSON.parse(window.localStorage.getItem("zavi:artifact-ratios")!) as Record<string, number>;
    expect(stored["older-image"]).toBe(2);
    expect(stored[artifact.id]).toBeCloseTo(1600 / 900);
    window.sessionStorage.clear();
    resetAspectRatiosForTests();
    expect(knownAspectRatio(artifact.id)).toBeCloseTo(1600 / 900);
  });

  it("keeps the remembered ratios bounded, dropping the oldest first", async () => {
    const seeded = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`old-${i}`, 1]));
    window.localStorage.setItem("zavi:artifact-ratios", JSON.stringify(seeded));
    resetAspectRatiosForTests();
    thumbOk();
    const artifact = { ...baseArtifact, id: nextId() };
    render(<ArtifactPreview artifact={artifact} fit="natural" />);
    enterViewport();
    await waitFor(() => expect(img()).not.toBeNull());
    loadWithSize(img()!, 1000, 1000);
    const stored = JSON.parse(window.localStorage.getItem("zavi:artifact-ratios")!) as Record<string, number>;
    expect(Object.keys(stored)).toHaveLength(500);
    expect(stored["old-0"]).toBeUndefined();
    expect(stored["old-499"]).toBe(1);
    expect(stored[artifact.id]).toBe(1);
  });

  it("a remount starts from the remembered ratio, so the column never jumps when the tile comes back", async () => {
    thumbOk();
    const artifact = { ...baseArtifact, id: nextId() };
    const first = render(<ArtifactPreview artifact={artifact} fit="natural" />);
    enterViewport();
    await waitFor(() => expect(img()).not.toBeNull());
    loadWithSize(img()!, 1600, 900);
    first.unmount();

    resetAspectRatiosForTests();
    render(<ArtifactPreview artifact={artifact} fit="natural" />);
    expect(frame().style.aspectRatio).toBe(String(1600 / 900));
    expect(frame().className).not.toContain("min-h-32");
  });

  it("keeps the ratio when the thumbnail fails and the original takes over", async () => {
    thumbOk();
    const artifact = { ...baseArtifact, id: nextId() };
    render(<ArtifactPreview artifact={artifact} fit="natural" />);
    enterViewport();
    await waitFor(() => expect(img()?.getAttribute("src")).toBe(THUMB));
    loadWithSize(img()!, 800, 700);
    act(() => {
      img()!.dispatchEvent(new Event("error"));
    });
    expect(img()?.getAttribute("src")).toBe(baseArtifact.preview_url);
    expect(frame().style.aspectRatio).toBe(String(800 / 700));
  });

  it("a zero-sized load event (a broken decode) does not poison the remembered ratio", async () => {
    thumbOk();
    const artifact = { ...baseArtifact, id: nextId() };
    render(<ArtifactPreview artifact={artifact} fit="natural" />);
    enterViewport();
    await waitFor(() => expect(img()).not.toBeNull());
    loadWithSize(img()!, 0, 0);
    expect(frame().style.aspectRatio).toBe("");
    expect(knownAspectRatio(artifact.id)).toBeNull();
  });

  it("a video tile takes the video's own shape once its metadata arrives, 16:9 only until then", () => {
    const artifact = {
      ...baseArtifact,
      id: nextId(),
      mime: "video/mp4",
      type: "video" as const,
      filename: "video-9x16.mp4",
      title: "Vertical clip",
    };
    const { container } = render(<ArtifactPreview artifact={artifact} fit="natural" />);
    enterViewport();
    const frame = () => container.querySelector<HTMLElement>("[data-fit]")!;
    const video = container.querySelector("video")!;
    expect(frame().getAttribute("data-fit")).toBe("natural");
    expect(frame().className).toContain("aspect-video");
    expect(frame().className).not.toContain("h-44");
    Object.defineProperty(video, "videoWidth", { value: 1080, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 1920, configurable: true });
    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(frame().style.aspectRatio).toBe(String(1080 / 1920));
    expect(frame().className).not.toContain("aspect-video");
    expect(knownAspectRatio(artifact.id)).toBeCloseTo(0.5625);
  });

  it("a video in cover fit keeps the fixed frame and never records a ratio", () => {
    const artifact = {
      ...baseArtifact,
      id: nextId(),
      mime: "video/mp4",
      type: "video" as const,
      filename: "clip.mp4",
    };
    const { container } = render(<ArtifactPreview artifact={artifact} />);
    enterViewport();
    const video = container.querySelector("video")!;
    Object.defineProperty(video, "videoWidth", { value: 1080, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 1920, configurable: true });
    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(container.querySelector<HTMLElement>("[data-fit]")!.style.aspectRatio).toBe("");
    expect(knownAspectRatio(artifact.id)).toBeNull();
  });

  it("list thumbnails ignore natural fit and stay the fixed 96x64 box", async () => {
    thumbOk();
    render(<ArtifactPreview artifact={{ ...baseArtifact, id: nextId() }} fit="natural" compact />);
    enterViewport();
    await waitFor(() => expect(img()).not.toBeNull());
    expect(frame().getAttribute("data-fit")).toBe("cover");
    expect(frame().className).toContain("w-24");
  });
});

describe("ArtifactPreview media loading", () => {
  const img = () => screen.queryByAltText("Preview of Campaign visual");

  it("waits until a small image is near the viewport, then loads the resized thumbnail", async () => {
    thumbOk();
    const artifact = { ...baseArtifact, id: nextId() };
    render(<ArtifactPreview artifact={artifact} />);
    expect(img()).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();

    enterViewport();

    await waitFor(() => expect(img()?.getAttribute("src")).toBe(THUMB));
    expect(apiFetch).toHaveBeenCalledWith("/api/run-artifacts/thumbnails", {
      method: "POST",
      body: JSON.stringify({ ids: [artifact.id] }),
    });
  });

  it("tiles that come into view together share ONE thumbnail request", async () => {
    thumbOk();
    const a = { ...baseArtifact, id: nextId(), title: "A" };
    const b = { ...baseArtifact, id: nextId(), title: "B" };
    const c = { ...baseArtifact, id: nextId(), title: "C" };
    render(
      <>
        <ArtifactPreview artifact={a} />
        <ArtifactPreview artifact={b} />
        <ArtifactPreview artifact={c} />
      </>,
    );
    enterViewport();
    await waitFor(() => expect(screen.queryByAltText("Preview of C")?.getAttribute("src")).toBe(THUMB));
    expect(screen.getByAltText("Preview of A").getAttribute("src")).toBe(THUMB);
    expect(screen.getByAltText("Preview of B").getAttribute("src")).toBe(THUMB);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(apiFetch.mock.calls[0][1].body).ids).toEqual([a.id, b.id, c.id]);
  });

  it("a batch that fails leaves every tile on its original image, not on an icon", async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    const a = { ...baseArtifact, id: nextId(), title: "A" };
    const b = { ...baseArtifact, id: nextId(), title: "B" };
    render(
      <>
        <ArtifactPreview artifact={a} />
        <ArtifactPreview artifact={b} />
      </>,
    );
    enterViewport();
    await waitFor(() => expect(screen.queryByAltText("Preview of B")?.getAttribute("src")).toBe(baseArtifact.preview_url));
    expect(screen.getByAltText("Preview of A").getAttribute("src")).toBe(baseArtifact.preview_url);
  });

  it("loads an image thumbnail past the 2 MB inline cap (#13)", async () => {
    thumbOk();
    render(
      <ArtifactPreview
        artifact={{ ...baseArtifact, id: nextId(), bytes: MAX_INLINE_BYTES + 1 }}
      />,
    );
    enterViewport();
    await waitFor(() => expect(img()?.getAttribute("src")).toBe(THUMB));
  });

  it("uses the original image when the thumbnail can't be signed", async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    render(<ArtifactPreview artifact={{ ...baseArtifact, id: nextId() }} />);
    enterViewport();
    await waitFor(() =>
      expect(img()?.getAttribute("src")).toBe(baseArtifact.preview_url),
    );
  });

  it("still does not load an oversized video", () => {
    const { container } = render(
      <ArtifactPreview
        artifact={{
          ...baseArtifact,
          id: nextId(),
          mime: "video/mp4",
          type: "video",
          filename: "clip.mp4",
          bytes: MAX_INLINE_BYTES + 1,
        }}
      />,
    );
    enterViewport();
    expect(container.querySelector("video")).toBeNull();
  });

  it("falls back thumbnail → original → icon, and retries a fresh URL", async () => {
    thumbOk();
    const artifact = { ...baseArtifact, id: nextId() };
    const { rerender } = render(<ArtifactPreview artifact={artifact} />);
    enterViewport();
    await waitFor(() => expect(img()?.getAttribute("src")).toBe(THUMB));

    act(() => {
      img()!.dispatchEvent(new Event("error"));
    });
    expect(img()?.getAttribute("src")).toBe(baseArtifact.preview_url);

    act(() => {
      img()!.dispatchEvent(new Event("error"));
    });
    expect(img()).toBeNull();

    const fresh = "https://storage.example/campaign.png?tok=new";
    rerender(<ArtifactPreview artifact={{ ...artifact, preview_url: fresh }} />);
    expect(img()?.getAttribute("src")).toBe(fresh);
  });
});
