// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));

import { PREVIEW_OVERLAY_FADE_MS, WebsitePreview } from "./WebsitePreview";
import {
  READINESS_POLL_MS,
  READINESS_SLOW_AFTER_MS,
  READINESS_SLOW_POLL_MS,
  READY_CACHE_MS,
} from "@/lib/workspace/useAppReadiness";

const READINESS_PATH = "/api/workspace/app-preview/readiness";

type Answer = { status: number; body?: unknown } | Error | "hang";

let seq = 0;
function freshApp(domain = "onrender.com") {
  seq += 1;
  return `https://app-${seq}-${Math.random().toString(36).slice(2, 8)}.${domain}`;
}

const signals: AbortSignal[] = [];

function script(answers: Answer[]) {
  const queue = [...answers];
  apiFetch.mockImplementation(async (path: string, init?: { signal?: AbortSignal }) => {
    if (!String(path).startsWith(READINESS_PATH)) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (init?.signal) signals.push(init.signal);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === "hang") return new Promise(() => {});
    if (next instanceof Error) throw next;
    return { ok: next.status < 400, status: next.status, json: async () => next.body };
  });
}

const waking = { status: 200, body: { state: "waking" } };
const ready = { status: 200, body: { state: "ready" } };
const suspended = { status: 200, body: { state: "suspended" } };

const probes = () => apiFetch.mock.calls.filter(([p]) => String(p).startsWith(READINESS_PATH));
const frame = (root: ParentNode = document) => root.querySelector("iframe");

async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(url: string) {
  return render(<WebsitePreview liveUrl={url} cacheKey={null} appId={new URL(url).host} builtApp />);
}

beforeEach(() => {
  vi.useFakeTimers();
  signals.length = 0;
});

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
  vi.useRealTimers();
});

describe("WebsitePreview readiness gate", () => {
  it("keeps the iframe out until the app answers, polling waking, waking, ready", async () => {
    const url = freshApp();
    script([waking, waking, ready]);
    const view = mount(url);

    expect(frame()).toBeNull();
    await tick();
    expect(probes()).toHaveLength(1);
    expect(probes()[0][0]).toBe(`${READINESS_PATH}?url=${encodeURIComponent(url)}`);
    expect(frame()).toBeNull();
    expect(screen.getByText("Waking up your app")).toBeTruthy();
    expect(screen.getByTestId("app-starting-card").className).toContain("bg-cream/90");
    expect(view.container.textContent).not.toMatch(/render/i);

    await tick(READINESS_POLL_MS - 1);
    expect(probes()).toHaveLength(1);
    await tick(1);
    expect(probes()).toHaveLength(2);
    expect(frame()).toBeNull();

    await tick(READINESS_POLL_MS);
    expect(probes()).toHaveLength(3);
    const iframe = frame();
    expect(iframe?.getAttribute("src")).toBe(url);
    expect(screen.queryByText("Waking up your app")).toBeNull();

    await tick(READINESS_POLL_MS * 10);
    expect(probes()).toHaveLength(3);
  });

  it("carries the same startup screen through the iframe load with no skeleton, until the frame loads", async () => {
    const url = freshApp();
    script([waking, ready]);
    const view = mount(url);
    await tick();

    expect(screen.getByTestId("preview-readiness-gate")).toBeTruthy();
    const animation = screen.getByTestId("build-lottie");

    await tick(READINESS_POLL_MS);
    const iframe = frame();
    expect(iframe?.getAttribute("src")).toBe(url);
    expect(screen.queryByTestId("preview-readiness-gate")).toBeNull();
    expect(screen.getByTestId("preview-loading")).toBeTruthy();
    expect(screen.getByTestId("build-lottie")).toBe(animation);
    expect(screen.getByText("Loading your app…")).toBeTruthy();
    expect(view.container.querySelectorAll(".animate-pulse")).toHaveLength(0);

    fireEvent.load(iframe!);
    expect(screen.queryByTestId("preview-loading")).toBeNull();
    const fading = screen.getByTestId("preview-loading-fading");
    expect(fading.className).toMatch(/opacity-0/);
    expect(fading.className).toMatch(/pointer-events-none/);
    expect(fading.className).toMatch(/motion-reduce:transition-none/);
    expect(fading.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("build-lottie")).toBe(animation);
    await tick(PREVIEW_OVERLAY_FADE_MS);
    expect(screen.queryByTestId("preview-loading-fading")).toBeNull();
    expect(screen.queryByTestId("build-lottie")).toBeNull();
    expect(view.container.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  it("swaps the loading screen for the blocked-embed notice when the frame never loads", async () => {
    const url = freshApp();
    script([ready]);
    mount(url);
    await tick();

    expect(frame()?.getAttribute("src")).toBe(url);
    expect(screen.getByTestId("preview-loading")).toBeTruthy();
    await tick(30_000);
    expect(screen.queryByTestId("preview-loading")).toBeNull();
    expect(screen.getByText(/blocks inline embedding/)).toBeTruthy();
    expect(screen.getByTestId("preview-notice-card").className).toContain("bg-cream/95");
    expect(screen.getByText("Preview is still loading")).toBeTruthy();
  });

  it("shows our paused notice for a suspended app, never the iframe, and stops polling", async () => {
    const url = freshApp("zaviagent.com");
    script([suspended]);
    const view = mount(url);
    await tick();

    expect(frame()).toBeNull();
    expect(screen.getByText("This app is paused")).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/render/i);
    await tick(READINESS_SLOW_AFTER_MS);
    expect(probes()).toHaveLength(1);
    expect(frame()).toBeNull();
  });

  it("fails open and mounts the iframe when the readiness endpoint errors", async () => {
    const url = freshApp();
    script([{ status: 500, body: { error: "boom" } }]);
    mount(url);
    await tick();
    expect(frame()?.getAttribute("src")).toBe(url);
    await tick(READINESS_POLL_MS * 4);
    expect(probes()).toHaveLength(1);
  });

  it("fails open on a network throw and on an unknown state", async () => {
    const a = freshApp();
    script([new TypeError("Failed to fetch")]);
    mount(a);
    await tick();
    expect(frame()?.getAttribute("src")).toBe(a);
    cleanup();

    const b = freshApp();
    script([{ status: 200, body: { state: "sleeping-ish" } }]);
    mount(b);
    await tick();
    expect(frame()?.getAttribute("src")).toBe(b);
  });

  it("gates a sandbox dev-server preview (e2b) until its client answers, with no manual reload", async () => {
    seq += 1;
    const url = `https://5173-box${seq}${Math.random().toString(36).slice(2, 8)}.e2b.app`;
    script([waking, waking, ready]);
    mount(url);
    expect(frame()).toBeNull();
    await tick();
    expect(probes()[0][0]).toBe(`${READINESS_PATH}?url=${encodeURIComponent(url)}`);
    expect(frame()).toBeNull();
    await tick(READINESS_POLL_MS);
    expect(frame()).toBeNull();
    await tick(READINESS_POLL_MS);
    expect(frame()?.getAttribute("src")).toBe(url);
  });

  it("never gates a host that is not one of our app hosts", async () => {
    script([waking]);
    mount("https://preview-proxy.example.com/run/1");
    expect(frame()?.getAttribute("src")).toBe("https://preview-proxy.example.com/run/1");
    await tick(READINESS_POLL_MS * 3);
    expect(probes()).toHaveLength(0);
  });

  it("stops polling and aborts the in-flight probe on unmount", async () => {
    const url = freshApp();
    script([waking, "hang"]);
    const view = mount(url);
    await tick();
    await tick(READINESS_POLL_MS);
    expect(probes()).toHaveLength(2);
    expect(signals[1].aborted).toBe(false);

    view.unmount();
    expect(signals[1].aborted).toBe(true);
    await tick(READINESS_SLOW_AFTER_MS);
    expect(probes()).toHaveLength(2);
  });

  it("stops scheduled polls after unmount between probes", async () => {
    const url = freshApp();
    script([waking]);
    const view = mount(url);
    await tick();
    expect(probes()).toHaveLength(1);
    view.unmount();
    await tick(READINESS_POLL_MS * 20);
    expect(probes()).toHaveLength(1);
  });

  it("shares one poll stream across two previews of the same app and keeps it alive for the survivor", async () => {
    const url = freshApp();
    script([waking]);
    const first = mount(url);
    const second = mount(url);
    await tick();
    expect(probes()).toHaveLength(1);
    await tick(READINESS_POLL_MS);
    expect(probes()).toHaveLength(2);

    first.unmount();
    await tick(READINESS_POLL_MS);
    expect(probes()).toHaveLength(3);

    script([ready]);
    await tick(READINESS_POLL_MS);
    expect(probes()).toHaveLength(4);
    expect(frame(second.container)?.getAttribute("src")).toBe(url);
  });

  it("mounts a recently-ready app immediately on remount without re-probing, and re-gates after the cache expires", async () => {
    const url = freshApp();
    script([ready]);
    const first = mount(url);
    await tick();
    expect(frame()).not.toBeNull();
    first.unmount();

    script([waking]);
    const again = mount(url);
    expect(frame(again.container)?.getAttribute("src")).toBe(url);
    await tick(READINESS_POLL_MS * 3);
    expect(probes()).toHaveLength(1);
    again.unmount();

    await tick(READY_CACHE_MS);
    const later = mount(url);
    expect(frame(later.container)).toBeNull();
    await tick();
    expect(probes()).toHaveLength(2);
  });

  it("keeps a mounted iframe after the ready cache would have expired", async () => {
    const url = freshApp();
    script([ready]);
    const view = mount(url);
    await tick();
    const before = frame(view.container);
    expect(before).not.toBeNull();
    await tick(READY_CACHE_MS * 2);
    view.rerender(<WebsitePreview liveUrl={url} cacheKey={null} appId={new URL(url).host} builtApp />);
    expect(frame(view.container)).toBe(before);
  });

  it("reports slow after three minutes with our own notice, keeps polling slowly, and Retry probes now", async () => {
    const url = freshApp();
    script([waking]);
    const view = mount(url);
    await tick();
    await tick(READINESS_SLOW_AFTER_MS - READINESS_POLL_MS);
    expect(screen.queryByText(/taking longer than usual/)).toBeNull();
    await tick(READINESS_POLL_MS);
    expect(screen.getByText(/taking longer than usual/)).toBeTruthy();
    expect(frame()).toBeNull();
    expect(view.container.textContent).not.toMatch(/render/i);
    const open = screen.getByRole("link", { name: /Open your app/ });
    expect(open.getAttribute("href")).toBe(url);
    expect(open.getAttribute("target")).toBe("_blank");

    const atSlow = probes().length;
    await tick(READINESS_POLL_MS);
    expect(probes()).toHaveLength(atSlow);
    await tick(READINESS_SLOW_POLL_MS - READINESS_POLL_MS);
    expect(probes()).toHaveLength(atSlow + 1);
    expect(frame()).toBeNull();

    script([ready]);
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await tick();
    expect(probes()).toHaveLength(atSlow + 2);
    expect(frame()?.getAttribute("src")).toBe(url);
  });

  it("does not start the blocked-embed timer while the app is still waking", async () => {
    const url = freshApp();
    script([waking]);
    mount(url);
    await tick();
    await tick(60_000);
    expect(screen.queryByText(/blocks inline embedding/)).toBeNull();
    script([ready]);
    await tick(READINESS_POLL_MS);
    expect(frame()).not.toBeNull();
    expect(screen.queryByText(/blocks inline embedding/)).toBeNull();
    await tick(29_000);
    expect(screen.queryByText(/blocks inline embedding/)).toBeNull();
    await tick(1_000);
    expect(screen.getByText(/blocks inline embedding/)).toBeTruthy();
  });
});
