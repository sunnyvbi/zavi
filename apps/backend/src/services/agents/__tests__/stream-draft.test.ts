import { describe, it, expect, vi } from "vitest";
import {
  createStreamDraftEmitter,
  FLUSH_CHARS,
  FLUSH_MS,
} from "../stream-draft";

function makeFakeSb(opts?: { failWith?: Error; returnError?: string }) {
  const upserts: Array<Record<string, unknown>> = [];
  const sb = { rpc(name: string, p: Record<string, unknown>) {
    if (name === "begin_stream_draft_writer") return { abortSignal: () => Promise.resolve({ data:1, error:null }) };
    const row = { run_id:p.p_run_id, tenant_id:p.p_tenant_id, thread_id:p.p_thread_id, agent_slug:p.p_agent_slug, seq:p.p_seq, text:p.p_text, status:p.p_status };
    upserts.push(row);
    if (opts?.failWith) throw opts.failWith;
    return { abortSignal: () => Promise.resolve({ data:true, error:opts?.returnError ? { message:opts.returnError } : null }) };
  } };
  return { sb: sb as never, upserts };
}

function baseOpts(sb: never, now: () => number) {
  return {
    runId: "run-1",
    tenantId: "tenant-A",
    threadId: "thread-1" as string | null,
    agentSlug: "pm",
    sb,
    now,
  };
}

describe("stream-draft emitter", () => {
  it("throttles: does NOT flush until >=FLUSH_CHARS chars accumulate", async () => {
    let t = 1000;
    const { sb, upserts } = makeFakeSb();
    const em = createStreamDraftEmitter(baseOpts(sb, () => t));
    await em.ready();

    await em.push("x".repeat(FLUSH_CHARS - 1));
    expect(upserts.length).toBe(0);

    await em.push("y");
    expect(upserts.length).toBe(1);
    expect(upserts[0].text).toBe("x".repeat(FLUSH_CHARS - 1) + "y");
  });

  it("throttles on TIME: a small delta flushes once >=FLUSH_MS elapsed", async () => {
    let t = 1000;
    const { sb, upserts } = makeFakeSb();
    const em = createStreamDraftEmitter(baseOpts(sb, () => t));
    await em.ready();

    await em.push("hi");
    expect(upserts.length).toBe(0);

    t += FLUSH_MS;
    await em.push("!");
    expect(upserts.length).toBe(1);
    expect(upserts[0].text).toBe("hi!");
  });

  it("seq is monotonic across flushes + the terminal finish", async () => {
    let t = 1000;
    const { sb, upserts } = makeFakeSb();
    const em = createStreamDraftEmitter(baseOpts(sb, () => t));
    await em.ready();

    await em.push("a".repeat(FLUSH_CHARS));
    t += FLUSH_MS;
    await em.push("b".repeat(FLUSH_CHARS));
    await em.finish("complete");

    const seqs = upserts.map((u) => u.seq);
    expect(seqs).toEqual(upserts.map((_, i) => i + 1));
    expect(upserts.at(-1)).toMatchObject({ text: "a".repeat(FLUSH_CHARS) + "b".repeat(FLUSH_CHARS), status: "complete" });
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i] as number).toBeGreaterThan(seqs[i - 1] as number);
    }
  });

  it("text is CUMULATIVE (full prefix), not per-delta", async () => {
    let t = 1000;
    const { sb, upserts } = makeFakeSb();
    const em = createStreamDraftEmitter(baseOpts(sb, () => t));
    await em.ready();

    await em.push("Hello ".repeat(10));
    const firstLen = (upserts[0].text as string).length;
    t += FLUSH_MS;
    await em.push("World");
    await em.finish("complete");
    const secondText = upserts.at(-1)!.text as string;
    expect(secondText.length).toBeGreaterThan(firstLen);
    expect(secondText.endsWith("World")).toBe(true);
    expect(secondText.startsWith("Hello ")).toBe(true);
  });

  it("finish() ALWAYS writes the terminal row + status, bypassing throttle", async () => {
    let t = 1000;
    const { sb, upserts } = makeFakeSb();
    const em = createStreamDraftEmitter(baseOpts(sb, () => t));
    await em.ready();

    await em.push("short");
    expect(upserts.length).toBe(0);
    await em.finish("complete");
    expect(upserts.length).toBe(1);
    expect(upserts[0].text).toBe("short");
    expect(upserts[0].status).toBe("complete");
  });

  it("carries run_id / tenant_id / thread_id / agent_slug onto every row", async () => {
    let t = 1000;
    const { sb, upserts } = makeFakeSb();
    const em = createStreamDraftEmitter(baseOpts(sb, () => t));
    await em.ready();
    await em.finish("complete");
    expect(upserts[0]).toMatchObject({
      run_id: "run-1",
      tenant_id: "tenant-A",
      thread_id: "thread-1",
      agent_slug: "pm",
    });
  });

  it("FAIL-SOFT: an upsert that returns an error is swallowed (no throw)", async () => {
    let t = 1000;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sb } = makeFakeSb({ returnError: "boom-rls-denied" });
    const em = createStreamDraftEmitter(baseOpts(sb, () => t));
    await em.ready();
    await expect(em.finish("complete")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("FAIL-SOFT: an upsert that THROWS is swallowed (no throw)", async () => {
    let t = 1000;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sb } = makeFakeSb({ failWith: new Error("network down") });
    const em = createStreamDraftEmitter(baseOpts(sb, () => t));
    await em.ready();
    await em.push("a".repeat(FLUSH_CHARS));
    await expect(em.finish("complete")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("is idempotent on finish() — a second finish() does nothing", async () => {
    let t = 1000;
    const { sb, upserts } = makeFakeSb();
    const em = createStreamDraftEmitter(baseOpts(sb, () => t));
    await em.ready();
    await em.finish("complete");
    await em.finish("failed");
    expect(upserts.length).toBe(1);
    expect(upserts[0].status).toBe("complete");
  });

  it("ignores empty deltas (no flush, no row)", async () => {
    let t = 1000;
    const { sb, upserts } = makeFakeSb();
    const em = createStreamDraftEmitter(baseOpts(sb, () => t));
    await em.ready();
    await em.push("");
    expect(upserts.length).toBe(0);
  });
});

describe("createStreamDraftEmitter — resetTurn", () => {
  it("clears the text and writes immediately, so the bubble empties", async () => {
    const { sb, upserts } = makeFakeSb();
    let t = 0;
    const em = createStreamDraftEmitter(baseOpts(sb, () => t));
    await em.ready();
    await em.push("n".repeat(FLUSH_CHARS));
    await em.resetTurn();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(upserts.at(-1)!.text).toBe("");
    expect(upserts.at(-1)!.status).toBe("streaming");
    expect(Number(upserts.at(-1)!.seq)).toBeGreaterThan(Number(upserts.at(-2)!.seq));
  });

  it("the final flush carries only the last turn — the answer", async () => {
    const { sb, upserts } = makeFakeSb();
    const em = createStreamDraftEmitter(baseOpts(sb, () => 0));
    await em.ready();
    await em.push("Pulling July now.");
    await em.resetTurn();
    await em.push("GMV grew 5.9%.");
    await em.finish("complete");
    expect(upserts.at(-1)!.text).toBe("GMV grew 5.9%.");
  });

  it("is a no-op when nothing was typed (parallel calls reset once)", async () => {
    const { sb, upserts } = makeFakeSb();
    const em = createStreamDraftEmitter(baseOpts(sb, () => 0));
    await em.ready();
    await em.resetTurn();
    await em.resetTurn();
    expect(upserts.length).toBe(0);
  });

  it("replacePrior (punt retry): clears the bubble at once with a seq above the first attempt's", async () => {
    const { sb, upserts } = makeFakeSb();
    const em = createStreamDraftEmitter({ ...baseOpts(sb, () => 1000), replacePrior: true });
    await em.ready();
    await em.finish("complete");
    expect(upserts[0]).toMatchObject({ text: "", status: "streaming", seq: 1 });
    expect(upserts[1].seq).toBe(2);
  });
});
