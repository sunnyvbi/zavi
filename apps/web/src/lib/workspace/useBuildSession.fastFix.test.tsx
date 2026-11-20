// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: vi.fn(),
}));

import { FAST_FIX_WATCH_MS, latestBusyRefine, useBuildSession } from "./useBuildSession";
import { resetSharedBuildReads } from "./useBuildPreview";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const T0 = Date.parse("2026-10-06T10:00:00.000Z");
const MIN = 60_000;
const FIX = 'Fix this error in the preview:\n\nOn /: Failed to resolve import "lucide-react" from "src/App.tsx". Does the file exist?';

let refinesAnswer: () => unknown[] = () => [];
let refineReply: () => unknown = () => ({ ok: true, conductor_run_id: null, fast_fix: { kind: "deps_reinstall", packages: ["lucide-react"] } });

const refineReads = () => apiFetch.mock.calls.filter((c) => String(c[0]).includes("/refines?")).length;
const agentPass = (status: string) => ({ id: "agent-1", status, message: FIX, created_at: new Date(T0 + 4 * MIN).toISOString() });

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
  resetSharedBuildReads();
  refinesAnswer = () => [];
  refineReply = () => ({ ok: true, conductor_run_id: null, fast_fix: { kind: "deps_reinstall", packages: ["lucide-react"] } });
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/refine-product")) return json(refineReply());
    if (path.includes("/refines?")) return json({ refines: refinesAnswer() });
    return json({ run: { id: "b1", status: "done", updated_at: new Date(T0 - 2 * 60 * MIN).toISOString() } });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Fix error answered by the dependency fast path on a build that finished long ago", () => {
  it("shows the agent pass the server starts minutes later when the reinstall fails", async () => {
    const { result } = renderHook(() => useBuildSession("b1", null));
    await advance(0);
    await act(async () => {
      const sent = result.current.sendRefine(FIX);
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await sent).toBeNull();
    });
    expect(latestBusyRefine(result.current.refines)).toBeNull();

    await advance(4 * MIN);
    refinesAnswer = () => [agentPass("active")];
    await advance(10_000);
    expect(latestBusyRefine(result.current.refines)?.id).toBe("agent-1");

    refinesAnswer = () => [agentPass("done")];
    await advance(8_000);
    expect(result.current.refines.map((r) => r.status)).toEqual(["done"]);
  });

  it("stops watching once the reinstall window has passed", async () => {
    const { result } = renderHook(() => useBuildSession("b1", null));
    await advance(0);
    await act(async () => {
      const sent = result.current.sendRefine(FIX);
      await vi.advanceTimersByTimeAsync(11_000);
      await sent;
    });
    await advance(FAST_FIX_WATCH_MS + 20_000);
    const atEnd = refineReads();
    await advance(30 * MIN);
    expect(refineReads()).toBe(atEnd);
  });

  it("an agent reply does not start the fast-fix watch", async () => {
    refineReply = () => ({ ok: true, conductor_run_id: "agent-0" });
    refinesAnswer = () => [{ id: "agent-0", status: "done", message: FIX, created_at: new Date(T0).toISOString() }];
    const { result } = renderHook(() => useBuildSession("b1", null));
    await advance(0);
    await act(async () => {
      const sent = result.current.sendRefine(FIX);
      await vi.advanceTimersByTimeAsync(11_000);
      await sent;
    });
    const afterSend = refineReads();
    await advance(5 * MIN);
    expect(refineReads()).toBe(afterSend);
  });
});
