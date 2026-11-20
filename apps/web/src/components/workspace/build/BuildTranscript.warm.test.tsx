// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
  requests: [] as string[],
  clearers: [] as Array<() => void>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
    net.requests.push(path);
    const key = path.split("?")[0]!;
    return new Promise((resolve) => {
      const queue = net.pending.get(key) ?? [];
      queue.push((r: Reply) =>
        resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }),
      );
      net.pending.set(key, queue);
    });
  },
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: () => {} }));
vi.mock("@/lib/workspace/sessionScopedCache", () => ({
  registerSessionScopedCache: (clear: () => void) => {
    if (!net.clearers.includes(clear)) net.clearers.push(clear);
  },
}));

import { BuildTranscript } from "./BuildModePane";
import { BUILD_REFINE_FINISHED_EVENT, clearBuildSessionCache } from "@/lib/workspace/useBuildSession";

const A = "1ce7760e-4491-4be1-85cd-8eebc60a4e4f";
const B = "2de8871f-5502-4cf2-96de-9ffcd71b5f50";
const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";

const statusFor = (id: string, idea: string) => ({
  status: 200,
  body: {
    run: {
      id,
      objective: `Build product: Mohit — ${idea}`,
      status: "done",
      created_at: "2026-09-28T05:41:00.000Z",
      updated_at: "2026-09-28T05:56:00.000Z",
      stages: [],
    },
    target: { live_url: "https://spoke.test" },
  },
});

const refinesWith = (message: string, status: string) => ({
  status: 200,
  body: {
    refines: [
      {
        id: "30000000-0000-4000-8000-000000000000",
        message,
        status,
        summary: status === "done" ? `Did: ${message}` : null,
        created_at: "2026-09-28T06:30:00.000Z",
      },
    ],
  },
});

async function reply(path: string, r: Reply) {
  await waitFor(() => expect(net.pending.get(path)?.length ?? 0).toBeGreaterThan(0));
  const next = net.pending.get(path)!.shift()!;
  await act(async () => {
    next(r);
  });
}

const skeleton = () => screen.queryByRole("status", { name: "Loading conversation" });
const statusRequests = () => net.requests.filter((p) => p.startsWith(STATUS));

async function loadA() {
  const view = render(<BuildTranscript sessionId={A} />);
  expect(skeleton()).toBeTruthy();
  await reply(STATUS, statusFor(A, "a bike rental landing page"));
  await reply(REFINES, refinesWith("Use this photo as the hero", "running"));
  await screen.findByText("Use this photo as the hero");
  return view;
}

afterEach(() => {
  cleanup();
  clearBuildSessionCache();
  net.pending.clear();
  net.requests.length = 0;
});

describe("Build chat on open", () => {
  it("draws a loading skeleton at once on a cold open, then the conversation", async () => {
    render(<BuildTranscript sessionId={A} />);
    expect(skeleton()).toBeTruthy();
    expect(screen.queryByText(/bike rental/)).toBeNull();
    await reply(STATUS, statusFor(A, "a bike rental landing page"));
    expect(skeleton()).toBeNull();
    expect(screen.getByText(/a bike rental landing page/)).toBeTruthy();
  });

  it("draws a build it has already shown before any request answers, then refreshes it", async () => {
    (await loadA()).unmount();
    net.pending.clear();
    const before = statusRequests().length;

    render(<BuildTranscript sessionId={A} />);
    expect(skeleton()).toBeNull();
    expect(screen.getByText(/a bike rental landing page/)).toBeTruthy();
    expect(screen.getByText("Use this photo as the hero")).toBeTruthy();
    await waitFor(() => expect(statusRequests().length).toBe(before + 1));

    await reply(STATUS, statusFor(A, "a bike rental landing page, renamed"));
    expect(screen.getByText(/renamed/)).toBeTruthy();
  });

  it("does not announce a change as newly finished just because the cached copy saw it running", async () => {
    (await loadA()).unmount();
    net.pending.clear();
    const finished: string[] = [];
    const onFinished = (event: Event) => finished.push((event as CustomEvent<{ status: string }>).detail.status);
    window.addEventListener(BUILD_REFINE_FINISHED_EVENT, onFinished);
    try {
      render(<BuildTranscript sessionId={A} />);
      await reply(STATUS, statusFor(A, "a bike rental landing page"));
      await reply(REFINES, refinesWith("Use this photo as the hero", "done"));
      await screen.findByText("Did: Use this photo as the hero");
      expect(finished).toEqual([]);
    } finally {
      window.removeEventListener(BUILD_REFINE_FINISHED_EVENT, onFinished);
    }
  });

  it("forgets every cached build when the signed-in person changes", async () => {
    (await loadA()).unmount();
    expect(net.clearers.length).toBeGreaterThanOrEqual(1);
    for (const clear of net.clearers) clear();

    render(<BuildTranscript sessionId={A} />);
    expect(skeleton()).toBeTruthy();
    expect(screen.queryByText(/bike rental/)).toBeNull();
  });

  it("drops a cached build the server no longer resolves", async () => {
    (await loadA()).unmount();
    net.pending.clear();

    const second = render(<BuildTranscript sessionId={A} />);
    expect(screen.getByText(/a bike rental landing page/)).toBeTruthy();
    await reply(STATUS, { status: 404, body: { error: { code: "build_not_found" } } });
    await waitFor(() => expect(screen.queryByText(/a bike rental landing page/)).toBeNull());
    second.unmount();

    render(<BuildTranscript sessionId={A} />);
    expect(skeleton()).toBeTruthy();
    expect(screen.queryByText(/bike rental/)).toBeNull();
  });

  it("never files one build's conversation under another build's id", async () => {
    const view = await loadA();
    net.pending.clear();

    view.rerender(<BuildTranscript sessionId={B} />);
    await waitFor(() => expect(skeleton()).toBeTruthy());
    expect(screen.queryByText(/bike rental/)).toBeNull();
    view.unmount();

    render(<BuildTranscript sessionId={B} />);
    expect(skeleton()).toBeTruthy();
    expect(screen.queryByText(/bike rental/)).toBeNull();
  });
});
