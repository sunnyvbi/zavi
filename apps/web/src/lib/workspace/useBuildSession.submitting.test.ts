// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: vi.fn(), refreshBuildSessions: vi.fn() }));

import { BUILD_REFINE_SUBMITTING_EVENT, refineSubmittingFor, startBuildRefine } from "./useBuildSession";

describe("a change being sent is visible to every view (photo Retry holds off while it is)", () => {
  it("is on while any send for the session is in flight, optimistic or not, and off after, even on failure", async () => {
    const seen: Array<{ sessionId: string; submitting: boolean }> = [];
    window.addEventListener(BUILD_REFINE_SUBMITTING_EVENT, (e) => seen.push((e as CustomEvent).detail));
    let release: (v: unknown) => void = () => undefined;
    apiFetch.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const sending = startBuildRefine("s1", "Change the headline");
    expect(refineSubmittingFor("s1")).toBe(true);
    expect(refineSubmittingFor("s2")).toBe(false);
    release({ ok: false, status: 500, json: async () => ({ error: { code: "refine_product_failed", message: "That change could not start." } }) });
    await sending;
    expect(refineSubmittingFor("s1")).toBe(false);
    expect(seen).toEqual([{ sessionId: "s1", submitting: true }, { sessionId: "s1", submitting: false }]);
  });
});
