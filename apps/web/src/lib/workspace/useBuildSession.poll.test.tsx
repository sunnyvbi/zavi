// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: vi.fn(),
}));

import { useBuildSession } from "./useBuildSession";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const statusCalls = () =>
  apiFetch.mock.calls.filter((c) => String(c[0]).includes("build-status")).length;

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) =>
    path.includes("refines") ? json({ refines: [] }) : json({ run: null }, 404),
  );
});

afterEach(() => {
  cleanup();
});

describe("useBuildSession status polling", () => {
  it("believes the first 404 and stops, instead of re-reading a definitive answer", async () => {
    const { result } = renderHook(() => useBuildSession("b1", null));

    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.run).toBeNull();
    expect(statusCalls()).toBe(1);
  });

  it("clears a build already on screen when the session dies, so the notice can show", async () => {
    let tick = 0;
    apiFetch.mockImplementation(async (path: string) => {
      if (path.includes("refines")) return json({ refines: [] });
      tick += 1;
      return tick === 1
        ? json({ run: { id: "b1", status: "active" } })
        : json({ error: { code: "unauthenticated" } }, 401);
    });

    const { result } = renderHook(() => useBuildSession("b1", null));

    await waitFor(() => expect(result.current.run?.id).toBe("b1"));
    await waitFor(() => expect(result.current.authExpired).toBe(true), { timeout: 10_000 });
    expect(result.current.run).toBeNull();
  }, 15_000);

  it("drops the preview and live url too, so a dead session cannot still look live", async () => {
    let tick = 0;
    apiFetch.mockImplementation(async (path: string) => {
      if (path.includes("refines")) return json({ refines: [] });
      tick += 1;
      return tick === 1
        ? json({
            run: { id: "b1", status: "done" },
            target: { live_url: "https://b1.example.com", repo_url: "https://github.com/x/y" },
            preview: { url: "https://preview.example.com", kind: "live" },
          })
        : json({ error: { code: "unauthenticated" } }, 401);
    });

    const { result } = renderHook(() => useBuildSession("b1", null));

    await waitFor(() => expect(result.current.liveUrl).toBe("https://b1.example.com"));
    await waitFor(() => expect(result.current.authExpired).toBe(true), { timeout: 10_000 });
    expect(result.current.run).toBeNull();
    expect(result.current.liveUrl).toBeNull();
    expect(result.current.previewUrl).toBeNull();
    expect(result.current.previewKind).toBe("none");
    expect(result.current.repoUrl).toBeNull();
  }, 15_000);

  it("marks a rejected bearer as an expired session, not a load error", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.includes("refines")
        ? json({ refines: [] })
        : json({ error: { code: "unauthenticated" } }, 401),
    );

    const { result } = renderHook(() => useBuildSession("b1", null));

    await waitFor(() => expect(result.current.authExpired).toBe(true));
    expect(result.current.loadError).toBeNull();
    expect(result.current.notFound).toBe(false);
  });
});
