// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
const mocks = vi.hoisted(() => ({ options: null as any, read: vi.fn() }));
vi.mock("./useRealtimeChannel", () => ({ useRealtimeChannel: (o: unknown) => { mocks.options = o; } }));
vi.mock("@/lib/realtimeAuth", () => ({ getBrowserSupabaseSingleton: () => ({ from: () => ({ select: () => ({ eq: (_: string, id: string) => ({ maybeSingle: () => mocks.read(id) }) }) }) }) }));
import { useRunStreamDraft } from "./useRunStreamDraft";
const row = (run_id: string, seq: number, text: string) => ({ run_id, seq, text, status: "streaming" });
beforeEach(() => { mocks.read.mockReset().mockResolvedValue({ data: row("r1", 3, "Already written") }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("stream draft catch-up", () => {
  it("loads the existing row without waiting for another token", async () => {
    const { result } = renderHook(() => useRunStreamDraft("r1", true));
    await waitFor(() => expect(result.current.text).toBe("Already written"));
  });
  it("catches up on subscription/rejoin without rolling back newer live text", async () => {
    const { result } = renderHook(() => useRunStreamDraft("r1", true));
    await waitFor(() => expect(result.current.text).toBe("Already written"));
    act(() => mocks.options.onInsert(row("r1", 5, "Live newer")));
    await act(async () => { mocks.options.onSubscribed(); });
    expect(result.current.text).toBe("Live newer");
    mocks.read.mockResolvedValue({ data: row("r1", 9, "After reconnect") });
    await act(async () => { mocks.options.onSubscribed(); });
    expect(result.current.text).toBe("After reconnect");
  });
  it("drops old-run reads and events after switching runs", async () => {
    let resolve!: (value: unknown) => void;
    mocks.read.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ data: row("r2", 1, "New run") });
    const { result, rerender } = renderHook(({ id }) => useRunStreamDraft(id, true), { initialProps: { id: "r1" } });
    const oldCallback = mocks.options.onInsert;
    rerender({ id: "r2" });
    await waitFor(() => expect(result.current.text).toBe("New run"));
    await act(async () => { resolve({ data: row("r1", 999, "Stale") }); oldCallback(row("r1", 1000, "Stale event")); });
    expect(result.current.text).toBe("New run");
  });
  it("never reads when disabled", () => {
    renderHook(() => useRunStreamDraft("r1", false));
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("recovers a quiet stream, then stops polling after its terminal row", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRunStreamDraft("r1", true));
    await act(async () => {});
    mocks.read.mockResolvedValue({ data: { ...row("r1", 4, "Finished answer"), status: "complete" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(result.current).toEqual({ text: "Finished answer", status: "complete" });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it("recovers immediately when the tab becomes visible and ignores deleted rows", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { result } = renderHook(() => useRunStreamDraft("r1", true));
    expect(mocks.read).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(result.current.text).toBe("Already written");
    act(() => { mocks.options.onInsert(null); mocks.options.onInsert({}); });
    expect(result.current.text).toBe("Already written");
    expect(mocks.options.event).toBe("*");
  });
});
