import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamDraftEmitter } from "../stream-draft";
import { draftStore } from "./stream-draft-store.fake";

const options = { runId: "r", tenantId: "t", threadId: null, agentSlug: "operator" };
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("streaming resumes after storage times out", () => {
  it.each([1, 2])("recovers after write %i stalls and rejects its late commit even after completion", async slowSeq => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store = draftStore(async attempt => { if (attempt.row.seq === slowSeq) await gate; });
    const emitter = createStreamDraftEmitter({ ...options, sb: store.sb });
    await emitter.push("a".repeat(40));
    await vi.advanceTimersByTimeAsync(0);
    if (slowSeq === 2) {
      await emitter.push("b".repeat(40));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.attempts.find(a => a.row.seq === slowSeq)?.signal?.aborted).toBe(true);
    await emitter.push(" recovered");
    await vi.advanceTimersByTimeAsync(250);
    expect(store.stored?.text).toContain(" recovered");
    await emitter.finish("complete");
    const final = { ...store.stored };
    expect(final.status).toBe("complete");
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.stored).toEqual(final);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds completion through repeated timeouts without building a per-token queue", async () => {
    const store = draftStore(() => new Promise(() => {}));
    const emitter = createStreamDraftEmitter({ ...options, sb: store.sb });
    for (let i = 0; i < 100; i++) await emitter.push("a".repeat(40));
    const finished = emitter.finish("complete");
    await vi.advanceTimersByTimeAsync(4000);
    await finished;
    expect(store.attempts).toHaveLength(2);
    expect(store.attempts.every(a => a.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a replacement run's answer when the prior emitter finishes late", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store = draftStore(async attempt => { if (attempt.row.writer_generation === 1 && attempt.row.seq === 2) await gate; });
    const old = createStreamDraftEmitter({ ...options, sb: store.sb });
    await old.push("old".repeat(20));
    await vi.advanceTimersByTimeAsync(0);
    const oldFinished = old.finish("complete");
    await vi.advanceTimersByTimeAsync(2000);
    await oldFinished;
    const replacement = createStreamDraftEmitter({ ...options, sb: store.sb, replacePrior: true });
    await replacement.push("Replacement answer");
    await replacement.finish("complete");
    expect(store.stored).toMatchObject({ text: "Replacement answer", status: "complete", writer_generation: 2 });
    const final = { ...store.stored };
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.stored).toEqual(final);

  });
});
