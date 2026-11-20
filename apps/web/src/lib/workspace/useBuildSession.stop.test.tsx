// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: vi.fn(),
}));

import { useBuildSession } from "./useBuildSession";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const cancelCalls = () =>
  apiFetch.mock.calls.map((call) => String(call[0])).filter((path) => path.endsWith("/cancel"));

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/cancel")) return json({ ok: true, cancelled: true });
    if (path.includes("refines"))
      return json({ refines: [{ id: "ref-9", message: "x", status: "running", created_at: "2026-09-25T09:00:00Z" }] });
    return json({ run: { id: "b-stop", status: "done" }, target: { live_url: "https://x.example.com" } });
  });
});

afterEach(() => {
  cleanup();
});

describe("useBuildSession cancelRun", () => {
  it("cancels the named change's own run, never the build it belongs to", async () => {
    const { result } = renderHook(() => useBuildSession("b-stop", null));
    await waitFor(() => expect(result.current.run?.id).toBe("b-stop"));

    let error: string | null = "unset";
    await act(async () => {
      error = await result.current.cancelRun("ref-9");
    });

    expect(error).toBeNull();
    expect(cancelCalls()).toEqual(["/api/workspace/autopilot/runs/ref-9/cancel"]);
  });

  it("with no target still stops the build itself", async () => {
    const { result } = renderHook(() => useBuildSession("b-stop", null));
    await waitFor(() => expect(result.current.run?.id).toBe("b-stop"));

    await act(async () => {
      await result.current.cancelRun();
    });

    expect(cancelCalls()).toEqual(["/api/workspace/autopilot/runs/b-stop/cancel"]);
  });

  it("surfaces a failed stop instead of pretending the change stopped", async () => {
    const { result } = renderHook(() => useBuildSession("b-stop", null));
    await waitFor(() => expect(result.current.run?.id).toBe("b-stop"));
    apiFetch.mockImplementation(async (path: string) =>
      path.endsWith("/cancel")
        ? json({ error: { message: "cancel_failed: boom" } }, 500)
        : json({ refines: [] }),
    );

    let error: string | null = null;
    await act(async () => {
      error = await result.current.cancelRun("ref-9");
    });

    expect(error).toBe("cancel_failed: boom");
  });
});
