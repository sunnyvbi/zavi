import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc }),
}));

const logEvent = vi.fn(async () => {});
vi.mock("@/services/logging/logEvent", () => ({ logEvent: (...a: unknown[]) => logEvent(...(a as [])) }));
const sent = vi.hoisted(() => [] as unknown[]);
vi.mock("../../client", () => ({
  inngest: { createFunction: (c: unknown, t: unknown, f: unknown) => ({ c, t, f }), send: async (e: unknown) => void sent.push(e) },
}));

import {
  runTranscriptRetentionPurge,
  runDataRetentionPurge,
  runDbRawResultsSweep,
  drainPurge,
  checkRetentionBacklog,
  BATCH_PAUSE_MS,
  DB_RETENTION_BATCH,
  ACCESS_LOG_BATCH,
  DRAIN_BUDGET_MS,
  continuationEventId,
  readBatch,
  runDbCleanup,
  CLEANUP_PURGES,
  CLEANUP_MAX_PASSES,
  CLEANUP_NIGHT_ROWS,
  CLEANUP_NIGHT_MS,
  CLEANUP_PAUSE_MS,
  type StepRunner,
} from "../transcript-retention-purge";
const fast = { pause: async () => undefined };

function routeRpc(transcripts: Array<{ data: unknown; error: unknown }>, accessLog: { data: unknown; error: unknown } | Error) {
  const queue = [...transcripts];
  rpc.mockImplementation(async (name: string) => {
    if (name === "purge_data_access_log") {
      if (accessLog instanceof Error) throw accessLog;
      return accessLog;
    }
    return queue.shift() ?? { data: 0, error: null };
  });
}

describe("transcript-retention-purge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.TRANSCRIPT_RETENTION_PURGE_ENABLED;
  });

  it("loops the RPC until a partial batch, summing the count", async () => {
    routeRpc([{ data: 500, error: null }, { data: 120, error: null }], { data: 0, error: null });
    const out = await runTranscriptRetentionPurge(async () => {});
    expect(out).toEqual({ purged: 620, skipped: false });
    expect(rpc.mock.calls.filter((c) => c[0] === "purge_expired_raw_transcripts")).toHaveLength(2);
    expect(rpc).toHaveBeenCalledWith("purge_expired_raw_transcripts", {
      p_default_ttl_days: 14,
      p_batch_limit: 500,
    });
  });

  it("throws on RPC error", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    await expect(runTranscriptRetentionPurge()).rejects.toThrow(/boom/);
  });

  it("kill switch skips entirely", async () => {
    process.env.TRANSCRIPT_RETENTION_PURGE_ENABLED = "false";
    const out = await runTranscriptRetentionPurge();
    expect(out).toEqual({ purged: 0, skipped: true });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("caps a night at 10 full batches and pauses between them (disk IO budget)", async () => {
    routeRpc(Array.from({ length: 10 }, () => ({ data: 500, error: null })), { data: 0, error: null });
    const pause = vi.fn(async () => {});
    const out = await runTranscriptRetentionPurge(pause);
    expect(out.purged).toBe(5000);
    expect(rpc.mock.calls.filter((c) => c[0] === "purge_expired_raw_transcripts")).toHaveLength(10);
    expect(pause).toHaveBeenCalledTimes(10);
    expect(pause).toHaveBeenCalledWith(BATCH_PAUSE_MS);
  });

  it("the transcript purge never touches the data access log", async () => {
    routeRpc([{ data: 3, error: null }], { data: 42, error: null });
    await runTranscriptRetentionPurge(async () => {});
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["purge_expired_raw_transcripts"]);
  });
});

describe("data-retention-purge (independent of the transcript purge)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.TRANSCRIPT_RETENTION_PURGE_ENABLED;
    delete process.env.DATA_ACCESS_LOG_PURGE_ENABLED;
  });

  it("purges the data access log even when the transcript purge is switched off", async () => {
    process.env.TRANSCRIPT_RETENTION_PURGE_ENABLED = "false";
    routeRpc([], { data: 42, error: null });
    const out = await runDataRetentionPurge();
    expect(out.access_log_purged).toBe(42);
    expect(rpc).toHaveBeenCalledWith("purge_data_access_log", { p_batch_limit: ACCESS_LOG_BATCH });
  });

  it("purges the data access log even when the transcript purge fails", async () => {
    routeRpc([{ data: null, error: { message: "boom" } }], { data: 9, error: null });
    await expect(runTranscriptRetentionPurge(async () => {})).rejects.toThrow(/boom/);
    expect((await runDataRetentionPurge()).access_log_purged).toBe(9);
  });

  it("its own kill switch skips the log purge", async () => {
    process.env.DATA_ACCESS_LOG_PURGE_ENABLED = "false";
    routeRpc([], { data: 42, error: null });
    const out = await runDataRetentionPurge();
    expect(out).toMatchObject({ access_log_purged: 0, access_log_skipped: true });
    expect(rpc.mock.calls.some((c) => c[0] === "purge_data_access_log")).toBe(false);
  });

  it("an error is logged and ignored; a throw too", async () => {
    routeRpc([], { data: null, error: { message: "nope" } });
    expect((await runDataRetentionPurge()).access_log_purged).toBe(0);
    routeRpc([], new Error("network"));
    expect((await runDataRetentionPurge()).access_log_purged).toBe(0);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "data_access_log_purge_failed" }));
  });
});

describe("database retention drains (final review finding 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
  });

  it("nightly: chat answers drain, independent of the log purge outcome", async () => {
    const chat = [DB_RETENTION_BATCH, 4];
    rpc.mockImplementation(async (name: string) => {
      if (name === "purge_data_access_log") throw new Error("log down");
      if (name === "purge_db_chat_answers") return { data: chat.shift() ?? 0, error: null };
      return { data: {}, error: null };
    });
    const out = await runDataRetentionPurge(fast);
    expect(out).toMatchObject({ access_log_purged: 0, chat_answers_deleted: DB_RETENTION_BATCH + 4 });
    expect(rpc).toHaveBeenCalledWith("purge_db_chat_answers", { p_batch_limit: DB_RETENTION_BATCH });
  });

  it("drains in batches until a partial batch (no fixed nightly cap)", async () => {
    const counts = Array.from({ length: 12 }, () => DB_RETENTION_BATCH).concat([7]);
    rpc.mockImplementation(async (name: string) =>
      name === "enqueue_db_run_retention_page" ? { data: [{ scanned: 10, enqueued: 2, wrapped: true }], error: null } : { data: counts.shift() ?? 0, error: null },
    );
    expect(await runDbRawResultsSweep(fast)).toEqual({ scrubbed: 12 * DB_RETENTION_BATCH + 7, enqueued: 2 });
    expect(rpc.mock.calls.filter((c) => c[0] === "purge_db_raw_results")).toHaveLength(13);
    expect(sent).toHaveLength(0);
  });

  it("over the time budget with backlog left: one continuation event, then the pass ends", async () => {
    let t = 0;
    rpc.mockImplementation(async () => ({ data: DB_RETENTION_BATCH, error: null }));
    const continueLater = vi.fn(async () => undefined);
    const out = await drainPurge("raw_results", { now: () => (t += DRAIN_BUDGET_MS / 3), pause: async () => undefined, continueLater });
    expect(out.backlog).toBe(true);
    expect(continueLater).toHaveBeenCalledWith("raw_results", undefined);
  });

  it("the default continuation sends db-retention.continue with a bucketed id", async () => {
    let t = 0;
    rpc.mockImplementation(async () => ({ data: DB_RETENTION_BATCH, error: null }));
    await drainPurge("chat_answers", { now: () => (t += DRAIN_BUDGET_MS), pause: async () => undefined });
    expect(sent[0]).toMatchObject({ name: "db-retention.continue", data: { purge: "chat_answers" } });
  });

  it("a continuation's own continuation gets a new id, so a long drain never stalls on dedupe", async () => {
    let t = 0;
    rpc.mockImplementation(async () => ({ data: DB_RETENTION_BATCH, error: null }));
    await drainPurge("raw_results", { now: () => (t += DRAIN_BUDGET_MS), pause: async () => undefined }, { parentKey: "evt-link-1" });
    await drainPurge("raw_results", { now: () => (t += DRAIN_BUDGET_MS), pause: async () => undefined }, { parentKey: "evt-link-2" });
    const ids = sent.map((e) => (e as { id?: string }).id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(continuationEventId("raw_results", "evt-link-1", 0)).toBe(ids[0]);
  });

  it("a retried send of the same link keeps the same id (dedupes), and ticks still bucket per 5 minutes", () => {
    expect(continuationEventId("chat_answers", "evt-a", 1)).toBe(continuationEventId("chat_answers", "evt-a", 999_999_999));
    expect(continuationEventId("chat_answers", undefined, 0)).toBe(continuationEventId("chat_answers", undefined, 299_999));
    expect(continuationEventId("chat_answers", undefined, 0)).not.toBe(continuationEventId("chat_answers", undefined, 300_000));
  });

  it("an error ends the pass, logged, never thrown", async () => {
    rpc.mockImplementation(async () => ({ data: null, error: { message: "x" } }));
    expect(await runDbRawResultsSweep(fast)).toEqual({ scrubbed: 0, enqueued: 0 });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "db_raw_results_purge_failed" }));
  });

  it("coverage walk pages until it wraps, then the raw purge drains (legacy runs without a log row get covered)", async () => {
    const pages = [{ scanned: 5000, enqueued: 3, wrapped: false }, { scanned: 120, enqueued: 1, wrapped: true }];
    rpc.mockImplementation(async (name: string) =>
      name === "enqueue_db_run_retention_page" ? { data: [pages.shift()], error: null } : { data: 0, error: null },
    );
    expect(await runDbRawResultsSweep(fast)).toEqual({ scrubbed: 0, enqueued: 4 });
    expect(rpc.mock.calls.filter((c) => c[0] === "enqueue_db_run_retention_page")).toHaveLength(2);
  });

  it("oldest overdue past its threshold is an error (alert); under it, silence", async () => {
    rpc.mockImplementation(async () => ({ data: { raw_results: 3 * 3600, chat_answers: 60, access_log: 0 }, error: null }));
    await checkRetentionBacklog();
    const errors = logEvent.mock.calls.filter((c) => (c as unknown[])[0] && ((c as unknown[])[0] as { code?: string }).code === "db_retention_overdue");
    expect(errors).toHaveLength(1);
    expect(((errors[0] as unknown[])[0] as { message: string }).message).toMatch(/raw_results/);
  });
});

describe("database cleanup (migration 20261105100000)", () => {
  const steps: string[] = [];
  const step: StepRunner = async (id, fn) => {
    steps.push(id);
    return fn();
  };
  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    steps.length = 0;
  });
  afterEach(() => {
    delete process.env.DB_CLEANUP_PURGE_ENABLED;
  });

  it("reads a row count (full batch = more) or a keyset purge's own {deleted, more}", () => {
    expect(readBatch(5000, 5000)).toEqual({ n: 5000, more: true, oversized: 0 });
    expect(readBatch(12, 5000)).toEqual({ n: 12, more: false, oversized: 0 });
    expect(readBatch({ deleted: 3, more: true }, 1000)).toEqual({ n: 3, more: true, oversized: 0 });
    expect(readBatch({ deleted: 0, sessions: 0, oversized: 2, more: false }, 1000)).toEqual({ n: 0, more: false, oversized: 2 });
    expect(readBatch(null, 10)).toEqual({ n: 0, more: false, oversized: 0 });
  });

  it("a keyset purge keeps draining while it says more, even on a batch with nothing deleted", async () => {
    const results = [{ deleted: 0, more: true }, { deleted: 40, more: true }, { deleted: 2, more: false }];
    rpc.mockImplementation(async () => ({ data: results.shift(), error: null }));
    expect(await drainPurge("sdk_sessions", fast)).toEqual({ total: 42, backlog: false, failed: false });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc).toHaveBeenCalledWith("purge_sdk_sessions", { p_batch_limit: 5000 });
  });

  it("a 1,500-entry session is deleted in one call; with less of the night left it waits for tomorrow", async () => {
    const fake = async (_name: string, args: { p_batch_limit: number }) =>
      args.p_batch_limit >= 1500
        ? { data: { deleted: 1500, sessions: 1, oversized: 0, deferred: false, more: false }, error: null }
        : { data: { deleted: 0, sessions: 0, oversized: 0, deferred: true, more: false }, error: null };
    rpc.mockImplementation(fake);
    expect(await drainPurge("sdk_sessions", fast)).toEqual({ total: 1500, backlog: false, failed: false });
    rpc.mockClear();
    rpc.mockImplementation(fake);
    expect(await drainPurge("sdk_sessions", fast, { maxRows: 1000 })).toEqual({ total: 0, backlog: false, failed: false });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("purge_sdk_sessions", { p_batch_limit: 1000 });
  });

  it("a session too big for one batch is logged as skipped, not deleted", async () => {
    rpc.mockImplementation(async () => ({ data: { deleted: 0, sessions: 0, oversized: 1, more: false }, error: null }));
    expect(await drainPurge("sdk_sessions", fast)).toEqual({ total: 0, backlog: false, failed: false });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", code: "sdk_sessions_oversized_skipped", meta: { total: 1 } }));
  });

  it("expires stale code indexes, then drains every purge one after another, and logs the counts", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "expire_stale_code_indexes") return { data: 1, error: null };
      if (name === "purge_run_events") return { data: 7, error: null };
      if (name === "purge_code_index_orphans") return { data: { deleted: 9, more: false }, error: null };
      return { data: 0, error: null };
    });
    const out = await runDbCleanup(step, fast);
    expect(out.expired_code_indexes).toBe(1);
    expect(out.deleted).toMatchObject({ run_events: 7, code_index_orphans: 9, stream_drafts: 0 });
    expect(steps).toEqual(["start", "expire-stale-code-indexes", ...CLEANUP_PURGES.map((p) => `${p}-0`)]);
    expect(rpc).toHaveBeenCalledWith("expire_stale_code_indexes", { p_limit: 50 });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "info", code: "db_cleanup_done", meta: { removed: 16, total: 1 } }));
    expect(sent).toHaveLength(0);
  });

  it("each purge gets a fair share of the night's rows; a big backlog cannot take them all", async () => {
    rpc.mockImplementation(async (name: string, args: { p_batch_limit?: number }) =>
      name === "expire_stale_code_indexes" ? { data: 0, error: null } : { data: args.p_batch_limit, error: null },
    );
    const pause = vi.fn(async () => undefined);
    const out = await runDbCleanup(step, { pause });
    const total = Object.values(out.deleted).reduce((a, b) => a + (b ?? 0), 0);
    expect(total).toBe(CLEANUP_NIGHT_ROWS);
    for (const p of CLEANUP_PURGES) expect(out.deleted[p]).toBeGreaterThan(0);
    expect(out.deleted.stream_drafts).toBeLessThanOrEqual(Math.ceil(CLEANUP_NIGHT_ROWS / CLEANUP_PURGES.length));
    for (const c of rpc.mock.calls) {
      if (c[0] !== "expire_stale_code_indexes") expect((c[1] as { p_batch_limit: number }).p_batch_limit).toBeLessThanOrEqual(5000);
    }
    expect(pause).toHaveBeenCalledWith(CLEANUP_PAUSE_MS);
  });

  it("a purge still behind after a pass gets another, up to the pass cap", async () => {
    let t = 0;
    rpc.mockImplementation(async (name: string) =>
      name === "purge_sdk_sessions" ? { data: { deleted: 10, more: true }, error: null } : { data: 0, error: null },
    );
    const out = await runDbCleanup(step, { now: () => (t += 10_000), pause: async () => undefined });
    expect(steps.filter((s) => s.startsWith("sdk_sessions-"))).toHaveLength(CLEANUP_MAX_PASSES);
    expect(out.deleted.sdk_sessions).toBeGreaterThan(0);
    expect(steps.filter((s) => s.startsWith("run_events-"))).toEqual(["run_events-0"]);
    expect(sent).toHaveLength(0);
  });

  it("stops for the night when the time budget is spent", async () => {
    let t = 0;
    rpc.mockImplementation(async (name: string) =>
      name === "expire_stale_code_indexes" ? { data: 0, error: null } : { data: { deleted: 1, more: true }, error: null },
    );
    const out = await runDbCleanup(step, { now: () => (t += 4 * 60_000), pause: async () => undefined });
    expect(out.stopped).toBe("budget");
    expect(steps.some((s) => s.startsWith("code_index_orphans-"))).toBe(false);
    expect(CLEANUP_NIGHT_MS).toBe(20 * 60_000);
  });

  it("the kill switch is read again before every pass", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "purge_run_events") process.env.DB_CLEANUP_PURGE_ENABLED = "false";
      return { data: 0, error: null };
    });
    const out = await runDbCleanup(step, fast);
    expect(out.stopped).toBe("kill_switch");
    expect(steps).toEqual(["start", "expire-stale-code-indexes", "stream_drafts-0", "run_events-0"]);
  });

  it("a failing purge is logged and the rest still run", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "purge_thread_event_steps") return { data: null, error: { message: "boom" } };
      if (name === "purge_praxis_logs") return { data: 3, error: null };
      return { data: 0, error: null };
    });
    const out = await runDbCleanup(step, fast);
    expect(out.deleted.praxis_logs).toBe(3);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ code: "thread_event_steps_purge_failed" }));
  });

  it("the nightly purge starts the cleanup once a day; its kill switch stops both", async () => {
    rpc.mockImplementation(async () => ({ data: 0, error: null }));
    const startDbCleanup = vi.fn(async () => undefined);
    expect((await runDataRetentionPurge({ ...fast, startDbCleanup })).db_cleanup_started).toBe(true);
    expect(startDbCleanup).toHaveBeenCalledTimes(1);

    await runDataRetentionPurge({ ...fast, now: () => Date.UTC(2026, 9, 14, 9, 45) });
    await runDataRetentionPurge({ ...fast, now: () => Date.UTC(2026, 9, 14, 9, 46) });
    const ids = sent.filter((e) => (e as { name?: string }).name === "db-cleanup.run").map((e) => (e as { id: string }).id);
    expect(ids).toEqual(["db-cleanup-2026-10-14", "db-cleanup-2026-10-14"]);

    process.env.DB_CLEANUP_PURGE_ENABLED = "false";
    startDbCleanup.mockClear();
    expect((await runDataRetentionPurge({ ...fast, startDbCleanup })).db_cleanup_started).toBe(false);
    expect(startDbCleanup).not.toHaveBeenCalled();
    expect(await runDbCleanup(step, fast)).toEqual({ skipped: true, expired_code_indexes: 0, deleted: {} });
    expect(steps).toHaveLength(0);
  });
});
