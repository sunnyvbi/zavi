// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
const h = vi.hoisted(() => ({ starter: vi.fn() }));
vi.mock("./draftStarter", async (load) => ({ ...(await load<typeof import("./draftStarter")>()), runDraftStarter: h.starter }));
vi.mock("@/lib/api", () => ({ apiFetch: async () => ({ ok: true, json: async () => ({ enabled: true, done: true, home_seen: false,
  docs: { status: "skipped", files: 0, facts: 0 }, connectors: { status: "skipped" },
  draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: true } }) }) }));
vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({ tabs: [{ id: "t", kind: "autopilot" }], activeTabId: "t", role: "owner" }) }));
vi.mock("../layout/shared", () => ({ useOpenStatic: () => () => {} }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
import { SetupProvider, useSetupOptional } from "./SetupProvider";
afterEach(cleanup);
describe("recoverable draft startup", () => {
  it("surfaces exhausted startup retries and lets an explicit retry clear the error", async () => {
    h.starter.mockReset().mockResolvedValueOnce({ gaveUp: true }).mockResolvedValueOnce({ status: "queued", run_id: "r" });
    const ctx: { current: ReturnType<typeof useSetupOptional> } = { current: null };
    function Probe() { ctx.current = useSetupOptional(); return null; }
    render(<SetupProvider><Probe /></SetupProvider>);
    await waitFor(() => expect(ctx.current?.draftStartError).toMatch(/try again/i));
    expect(ctx.current?.draftStarting).toBe(false); expect(h.starter).toHaveBeenCalledTimes(1);
    await act(async () => { await ctx.current!.startDraft(); });
    expect(ctx.current?.draftStartError).toBeNull(); expect(h.starter).toHaveBeenCalledTimes(2);
  });
});
