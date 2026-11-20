// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
const sessionClearers = vi.hoisted(() => new Set<() => void>());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("./sessionScopedCache", () => ({ registerSessionScopedCache: (clear: () => void) => sessionClearers.add(clear) }));

import { startBuildSession } from "./useBuildSession";
import {
  _resetBuildFigmaFrameForTests,
  attachBuildFigmaFrame,
  pendingBuildFigmaFrame,
  useBuildFigmaFrame,
} from "./buildFigmaFrame";
import { _resetBuildStartKeyForTests } from "./buildStartKey";
import { renderHook } from "@testing-library/react";

const LINK = "https://www.figma.com/design/AbCdEf1234567890XYZ/Landing?node-id=12-34&t=x";
const LINK_B = "https://www.figma.com/design/ZyXwVu9876543210QRS/Home?node-id=56-78&t=x";

function res(status: number, body: unknown) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body });
}
function sentBodies(): Array<Record<string, unknown>> {
  return apiFetch.mock.calls
    .filter(([url]) => url === "/api/workspace/autopilot/build-product")
    .map(([, init]) => JSON.parse(init.body as string));
}

beforeEach(() => {
  apiFetch.mockReset();
  _resetBuildFigmaFrameForTests();
  _resetBuildStartKeyForTests();
});

describe("startBuildSession with a Figma frame", () => {
  it("sends only the parsed file key and node id, never the pasted link or any image URL", async () => {
    expect(attachBuildFigmaFrame(LINK)).toBe(true);
    apiFetch.mockReturnValueOnce(res(200, { conductor_run_id: "run-1" }));
    expect(await startBuildSession({ idea: "a bakery site", companyName: "Shop" })).toEqual({ id: "run-1" });
    const [body] = sentBodies();
    expect(body.figma).toEqual({ file_key: "AbCdEf1234567890XYZ", node_id: "12:34" });
    expect(JSON.stringify(body)).not.toContain("figma.com");
    expect(body).not.toHaveProperty("reference_images");
    expect(pendingBuildFigmaFrame()).toBeNull();
  });

  it("a soft Figma note comes back to the caller and the store, and the build still opens", async () => {
    attachBuildFigmaFrame(LINK);
    const note = "Figma refused access to that frame, so this build starts from your idea alone.";
    apiFetch.mockReturnValueOnce(res(200, { conductor_run_id: "run-2", figma_note: note }));
    const { result } = renderHook(() => useBuildFigmaFrame());
    expect(await startBuildSession({ idea: "a bakery site", companyName: "Shop" })).toEqual({ id: "run-2", figmaNote: note });
    expect(result.current).toEqual({ frame: null, note });
  });

  it("a refused start keeps the frame for the retry", async () => {
    attachBuildFigmaFrame(LINK);
    apiFetch.mockReturnValueOnce(res(409, { error: { code: "build_already_in_progress" } }));
    const out = await startBuildSession({ idea: "a bakery site", companyName: "Shop" });
    expect(out).toHaveProperty("error");
    expect(pendingBuildFigmaFrame()).toEqual({ file_key: "AbCdEf1234567890XYZ", node_id: "12:34" });
  });

  it("settling one build never clears a newer attached frame", async () => {
    let release: (response: Awaited<ReturnType<typeof res>>) => void = () => {};
    const pending = new Promise<Awaited<ReturnType<typeof res>>>((resolve) => (release = resolve));
    attachBuildFigmaFrame(LINK);
    apiFetch.mockReturnValueOnce(pending);
    const started = startBuildSession({ idea: "a bakery site", companyName: "Shop" });
    attachBuildFigmaFrame(LINK_B);
    release(await res(200, { conductor_run_id: "run-a" }));
    expect(await started).toEqual({ id: "run-a" });
    expect(pendingBuildFigmaFrame()).toEqual({ file_key: "ZyXwVu9876543210QRS", node_id: "56:78" });
  });

  it("a setup failure with a run consumes its frame because that run owns it", async () => {
    attachBuildFigmaFrame(LINK);
    apiFetch.mockReturnValueOnce(res(503, { error: { code: "build_setup_failed", run_id: "run-failed" } }));
    expect(await startBuildSession({ idea: "a bakery site", companyName: "Shop" })).toEqual({ id: "run-failed" });
    expect(pendingBuildFigmaFrame()).toBeNull();
  });

  it("clears a pending private frame when the signed-in session changes", () => {
    attachBuildFigmaFrame(LINK);
    expect(pendingBuildFigmaFrame()).not.toBeNull();
    for (const clear of sessionClearers) clear();
    expect(pendingBuildFigmaFrame()).toBeNull();
  });

  it("no frame attached: no figma field and a stray figma_note is ignored", async () => {
    apiFetch.mockReturnValueOnce(res(200, { conductor_run_id: "run-3", figma_note: "x" }));
    expect(await startBuildSession({ idea: "a bakery site", companyName: "Shop" })).toEqual({ id: "run-3" });
    expect(sentBodies()[0]).not.toHaveProperty("figma");
  });

  it("an explicit null figma overrides a pending frame", async () => {
    attachBuildFigmaFrame(LINK);
    apiFetch.mockReturnValueOnce(res(200, { conductor_run_id: "run-4" }));
    await startBuildSession({ idea: "a bakery site", companyName: "Shop", figma: null });
    expect(sentBodies()[0]).not.toHaveProperty("figma");
    expect(pendingBuildFigmaFrame()).not.toBeNull();
  });

  it.each([
    "https://evil.example/design/AbCdEf1234567890XYZ/x?node-id=12-34",
    "http://www.figma.com/design/AbCdEf1234567890XYZ/x?node-id=12-34",
    "https://www.figma.com/design/AbCdEf1234567890XYZ/x",
    "https://www.figma.com.evil.example/design/AbCdEf1234567890XYZ/x?node-id=12-34",
  ])("refuses %s client side so nothing is sent", async (link) => {
    expect(attachBuildFigmaFrame(link)).toBe(false);
    apiFetch.mockReturnValueOnce(res(200, { conductor_run_id: "run-5" }));
    await startBuildSession({ idea: "a bakery site", companyName: "Shop" });
    expect(sentBodies()[0]).not.toHaveProperty("figma");
  });
});
