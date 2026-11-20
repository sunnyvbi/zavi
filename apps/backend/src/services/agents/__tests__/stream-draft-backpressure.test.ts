import { describe, it, expect, vi, afterEach } from "vitest";
import { createStreamDraftEmitter } from "../stream-draft";
import { draftStore } from "./stream-draft-store.fake";

describe("draft writes never hold model event consumption", () => {
  it("consumes a burst while storage is stalled, coalesces it, and preserves the exact final text", async () => {
    let release!: () => void;
    const stalled = new Promise<void>((r) => { release = r; });
    const store = draftStore(() => stalled);
    const em = createStreamDraftEmitter({ runId: "r", tenantId: "t", threadId: null, agentSlug: "operator", sb: store.sb });
    let consumed = 0;
    const consume = (async () => { for (let i = 0; i < 100; i++) { await em.push("word".repeat(10)); consumed++; } })();
    for (let i = 0; i < 250; i++) await Promise.resolve();
    const beforeRelease = consumed;
    release();
    await consume;
    await em.finish("complete");
    const rows = store.attempts.map(a => a.row);
    expect(beforeRelease).toBe(100);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.at(-1)).toMatchObject({ text: "word".repeat(1000), status: "complete" });
    expect(rows.map(r => r.seq)).toEqual([...rows.keys()].map(i => i + 1));
  });
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("draft writer recovery and turn boundaries", () => {
  it("never appends narration to the next answer while a write is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const store = draftStore(() => gate);
    const em = createStreamDraftEmitter({ runId: "r", tenantId: "t", threadId: null, agentSlug: "operator", sb: store.sb });
    await em.push("Reading your data. ".repeat(5));
    await em.resetTurn();
    await em.push("The answer.");
    const finished = em.finish("complete");
    release();
    await finished;
    expect(store.stored).toMatchObject({ text: "The answer.", status: "complete" });
  });
  it("flushes a short sentence without requiring another token", async () => {
    vi.useFakeTimers();
    const store = draftStore();
    const em = createStreamDraftEmitter({ runId: "r", tenantId: "t", threadId: null, agentSlug: "operator", sb: store.sb });
    await em.push("Hello");
    expect(store.attempts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(store.stored?.text).toBe("Hello");
    await em.finish("complete");
    expect(vi.getTimerCount()).toBe(0);
  });
});
