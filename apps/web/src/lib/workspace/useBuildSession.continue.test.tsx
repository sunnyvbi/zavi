// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: vi.fn(),
}));

import { useBuildSession, type ContinueRunError } from "./useBuildSession";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let continueResponse: () => Promise<Response> = async () => json({ ok: true, run_id: "b-fail" });

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/continue")) return continueResponse();
    if (path.includes("refines")) return json({ refines: [] });
    return json({ run: { id: "b-fail", status: "failed" } });
  });
});

afterEach(() => {
  cleanup();
});

async function continueOnce() {
  const { result } = renderHook(() => useBuildSession("b-fail", null));
  await waitFor(() => expect(result.current.run?.id).toBe("b-fail"));
  let outcome: ContinueRunError | null | "unset" = "unset";
  await act(async () => {
    outcome = await result.current.continueRun();
  });
  return outcome;
}

describe("useBuildSession continueRun", () => {
  it("returns the server's refusal code with its message", async () => {
    continueResponse = async () =>
      json({ error: { code: "not_paused", message: "This build is not paused." } }, 409);
    expect(await continueOnce()).toEqual({ code: "not_paused", message: "This build is not paused." });
  });

  it("returns the 5xx code so the caller can keep the error visible", async () => {
    continueResponse = async () => json({ error: { code: "continue_failed", message: "db down" } }, 500);
    expect(await continueOnce()).toEqual({ code: "continue_failed", message: "db down" });
  });

  it("returns a status code when the error body is unreadable", async () => {
    continueResponse = async () => new Response("<html>bad gateway</html>", { status: 502 });
    expect(await continueOnce()).toEqual({
      code: "http_502",
      message: "Couldn't continue the build (HTTP 502).",
    });
  });

  it("returns code network when the request never reaches the server", async () => {
    continueResponse = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await continueOnce()).toEqual({ code: "network", message: "Failed to fetch" });
  });

  it("returns null on success", async () => {
    continueResponse = async () => json({ ok: true, run_id: "b-fail" });
    expect(await continueOnce()).toBeNull();
  });

  it("marks the run active the moment the server resumes it, before any poll lands", async () => {
    let resumed = false;
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/continue")) {
        resumed = true;
        return json({ ok: true, run_id: "b-fail" });
      }
      if (path.includes("refines")) return json({ refines: [] });
      if (resumed) return new Promise<Response>(() => {});
      return json({
        run: { id: "b-fail", status: "failed", failure: { class: "app_database_setup", message: "app_database_setup_failed: x" } },
      });
    });
    const { result } = renderHook(() => useBuildSession("b-fail", null));
    await waitFor(() => expect(result.current.run?.status).toBe("failed"));
    await act(async () => {
      expect(await result.current.continueRun()).toBeNull();
    });
    expect(result.current.run?.status).toBe("active");
    expect(result.current.run?.failure).toBeNull();
  });

  it("leaves the run failed when the server refuses", async () => {
    continueResponse = async () =>
      json({ error: { code: "not_resumable", message: "no" } }, 409);
    const { result } = renderHook(() => useBuildSession("b-fail", null));
    await waitFor(() => expect(result.current.run?.status).toBe("failed"));
    await act(async () => {
      await result.current.continueRun();
    });
    expect(result.current.run?.status).toBe("failed");
  });
});
