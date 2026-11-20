// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
const readiness = vi.hoisted(() => ({ state: "checking" as string }));
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));
vi.mock("@/lib/workspace/useAppReadiness", () => ({
  useAppReadiness: () => ({ state: readiness.state, retry: () => {} }),
}));

import { WebsitePreview, previewSnapshotFor } from "./WebsitePreview";

const SITE = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTHER_SITE = "bbbbbbbb-0000-4000-8000-00000000000b";
const APP_URL = "https://5173-sbxsnap.e2b.app";
const DESKTOP = "https://signed.example/desktop.jpg";
const MOBILE = "https://signed.example/mobile.jpg";

let broken = new Set<string>();
const decoded: string[] = [];

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(url: string) {
    decoded.push(url);
    queueMicrotask(() => (broken.has(url) ? this.onerror?.() : this.onload?.()));
  }
}

function serve(snapshots: Record<string, unknown>) {
  apiFetch.mockImplementation(async (path: string) => {
    if (String(path).startsWith("/api/website/preview-snapshot")) return { ok: true, status: 200, json: async () => ({ snapshots }) };
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

const shot = (url: string, width = 1280, height = 800) => ({ url, width, height, taken_at: "2026-10-13T12:00:00Z" });

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function mount(appId = `site:${SITE}`) {
  return render(<WebsitePreview liveUrl={APP_URL} cacheKey={null} appId={appId} builtApp />);
}

const snapshotImg = () => screen.queryByTestId("preview-snapshot")?.querySelector("img")?.getAttribute("src") ?? null;

beforeEach(() => {
  readiness.state = "checking";
  broken = new Set();
  decoded.length = 0;
  vi.stubGlobal("Image", FakeImage);
});

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  vi.unstubAllGlobals();
});

describe("WebsitePreview snapshot cover", () => {
  it("shows the saved snapshot while the live app is still waking, instead of the loading screen", async () => {
    serve({ desktop: shot(DESKTOP) });
    mount();
    await flush();
    expect(snapshotImg()).toBe(DESKTOP);
    expect(screen.queryByTestId("app-starting-card")).toBeNull();
    expect(screen.getByText("Loading the live site…")).toBeTruthy();
    expect(apiFetch.mock.calls.some(([p]) => p === `/api/website/preview-snapshot?app_id=${encodeURIComponent(`site:${SITE}`)}`)).toBe(true);
  });

  it("never shows a snapshot the browser could not decode (no broken image), falling back to the loader", async () => {
    broken.add(DESKTOP);
    serve({ desktop: shot(DESKTOP) });
    mount();
    await flush();
    expect(decoded).toEqual([DESKTOP]);
    expect(screen.queryByTestId("preview-snapshot")).toBeNull();
    expect(screen.getByTestId("app-starting-card")).toBeTruthy();
  });

  it("keeps the snapshot up until the live page has loaded, then never shows it again for this mount", async () => {
    serve({ desktop: shot(DESKTOP) });
    const view = mount();
    await flush();
    readiness.state = "ready";
    view.rerender(<WebsitePreview liveUrl={APP_URL} cacheKey={null} appId={`site:${SITE}`} builtApp />);
    await flush();
    const frame = view.container.querySelector("iframe")!;
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("loading")).not.toBe("lazy");
    expect(snapshotImg()).toBe(DESKTOP);
    fireEvent.load(frame);
    await flush();
    expect(screen.getByTestId("preview-loading-fading")).toBeTruthy();
    expect(snapshotImg()).toBe(DESKTOP);
    expect(screen.queryByTestId("app-starting-card")).toBeNull();
    readiness.state = "checking";
    view.rerender(<WebsitePreview liveUrl={APP_URL} cacheKey={null} appId={`site:${SITE}`} builtApp />);
    await flush();
    expect(screen.queryByTestId("preview-snapshot")).toBeNull();
    expect(screen.getByTestId("app-starting-card")).toBeTruthy();
  });

  it("does not ask for a snapshot for an app that is not a site, and shows none", async () => {
    serve({ desktop: shot(DESKTOP) });
    mount("spoke.zaviagent.com");
    await flush();
    expect(apiFetch.mock.calls.some(([p]) => String(p).startsWith("/api/website/preview-snapshot"))).toBe(false);
    expect(screen.queryByTestId("preview-snapshot")).toBeNull();
  });

  it("drops a snapshot that arrives for a site the pane no longer shows", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    apiFetch.mockImplementation(async (path: string) => {
      if (String(path).includes(encodeURIComponent(`site:${SITE}`))) {
        await gate;
        return { ok: true, status: 200, json: async () => ({ snapshots: { desktop: shot(DESKTOP) } }) };
      }
      if (String(path).startsWith("/api/website/preview-snapshot")) return { ok: true, status: 200, json: async () => ({ snapshots: {} }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const view = mount();
    await flush();
    view.rerender(<WebsitePreview liveUrl={APP_URL} cacheKey={null} appId={`site:${OTHER_SITE}`} builtApp />);
    await flush();
    release();
    await flush();
    expect(screen.queryByTestId("preview-snapshot")).toBeNull();
  });
});

describe("previewSnapshotFor", () => {
  const base = {
    snapshots: { desktop: shot(DESKTOP), mobile: shot(MOBILE, 390, 844) },
    device: "desktop" as const,
    path: "/",
    liveSeen: false,
    refreshed: false,
    building: false,
    readiness: "checking" as const,
  };
  it("matches the device, and has no tablet snapshot", () => {
    expect(previewSnapshotFor(base)?.url).toBe(DESKTOP);
    expect(previewSnapshotFor({ ...base, device: "mobile" })?.url).toBe(MOBILE);
    expect(previewSnapshotFor({ ...base, device: "tablet" })).toBeNull();
  });
  it("is only for the first open of the home page", () => {
    expect(previewSnapshotFor({ ...base, path: "/menu" })).toBeNull();
    expect(previewSnapshotFor({ ...base, liveSeen: true })).toBeNull();
    expect(previewSnapshotFor({ ...base, refreshed: true })).toBeNull();
    expect(previewSnapshotFor({ ...base, building: true })).toBeNull();
  });
  it("gives way to the loading screen when the app is slow or paused, so its message and actions show", () => {
    expect(previewSnapshotFor({ ...base, readiness: "slow" })).toBeNull();
    expect(previewSnapshotFor({ ...base, readiness: "suspended" })).toBeNull();
    expect(previewSnapshotFor({ ...base, readiness: "ready" })?.url).toBe(DESKTOP);
  });
});
