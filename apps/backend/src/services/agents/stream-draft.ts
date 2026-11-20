
import { serviceClient } from "@/services/supabase";

type Sb = ReturnType<typeof serviceClient>;

export const FLUSH_CHARS = 40;
export const FLUSH_MS = 250;

export interface StreamDraftEmitterOpts {
  runId: string;
  tenantId: string;
  threadId: string | null;
  agentSlug: string;
  sb?: Sb;
  now?: () => number;
  replacePrior?: boolean;
}

export interface StreamDraftEmitter {
  ready(): Promise<void>;
  push(delta: string): Promise<void>;
  resetTurn(): Promise<void>;
  finish(status: "complete" | "failed" | "cancelled"): Promise<void>;
}

export function extractTextDeltaFromStreamEvent(event: unknown): string {
  const ev = event as
    | { type?: string; delta?: { type?: string; text?: unknown } }
    | undefined;
  if (
    ev?.type === "content_block_delta" &&
    ev.delta?.type === "text_delta" &&
    typeof ev.delta.text === "string"
  ) {
    return ev.delta.text;
  }
  return "";
}

export function createStreamDraftEmitter(
  opts: StreamDraftEmitterOpts,
): StreamDraftEmitter {
  const sb = opts.sb ?? serviceClient();
  const now = opts.now ?? (() => Date.now());

  let cumulative = "";
  let seq = 0;
  let lastFlushedLen = 0;
  let lastFlushAt = now();
  let finished = false;

  const WRITE_TIMEOUT_MS = 2000;
  type Snapshot = { text: string; status: string };
  let pending: Snapshot | null = null;
  let draining: Promise<void> | null = null;
  let generation: number | null = null;
  const ready = (async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        sb.rpc("begin_stream_draft_writer", { p_run_id: opts.runId, p_tenant_id: opts.tenantId }).abortSignal(controller.signal),
        new Promise<{ data: null; error: null }>(resolve => {
          timer = setTimeout(() => { controller.abort(); resolve({ data: null, error: null }); }, WRITE_TIMEOUT_MS);
        }),
      ]);
      if (!result.error && Number.isSafeInteger(result.data) && result.data > 0) generation = result.data;
    } catch {  }
    finally { clearTimeout(timer); }
  })();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function clearFlushTimer() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  }

  async function writeRow(snapshot: Snapshot): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const row = {
        run_id: opts.runId, tenant_id: opts.tenantId,
        thread_id: opts.threadId, agent_slug: opts.agentSlug,
        seq: ++seq, text: snapshot.text, status: snapshot.status,
        updated_at: new Date().toISOString(),
      };
      await ready;
      if (generation === null) return;
      const persist = () => sb.rpc("write_stream_draft", {
        p_run_id: opts.runId, p_tenant_id: opts.tenantId,
        p_generation: generation, p_seq: row.seq, p_text: row.text,
        p_status: row.status, p_thread_id: opts.threadId, p_agent_slug: opts.agentSlug,
      }).abortSignal(controller.signal);
      const { error } = await Promise.race([
        persist(),
        new Promise<{ error: { message: string } }>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve({ error: { message: "write timed out" } });
          }, WRITE_TIMEOUT_MS);
        }),
      ]);
      if (error) console.warn(`[stream-draft] upsert failed for run ${opts.runId} (non-fatal): ${error.message}`);
    } catch (e) {
      console.warn(`[stream-draft] upsert threw for run ${opts.runId} (non-fatal): ${(e as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function drain(): Promise<void> {
    while (pending) {
      const next = pending;
      pending = null;
      await writeRow(next);
    }
  }

  function startDrain(): void {
    if (!draining) draining = drain().finally(() => {
      draining = null;
      if (pending) startDrain();
    });
  }

  function enqueueWrite(status: string): void {
    clearFlushTimer();
    pending = { text: cumulative, status };
    lastFlushedLen = cumulative.length;
    lastFlushAt = now();
    startDrain();
  }

  if (opts.replacePrior) enqueueWrite("streaming");

  return {
    ready: () => ready,
    async push(delta: string): Promise<void> {
      if (finished || !delta) return;
      cumulative += delta;
      if (cumulative.length - lastFlushedLen >= FLUSH_CHARS || now() - lastFlushAt >= FLUSH_MS) {
        enqueueWrite("streaming");
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => enqueueWrite("streaming"), FLUSH_MS);
        flushTimer.unref?.();
      }
    },
    async resetTurn(): Promise<void> {
      if (finished || cumulative.length === 0) return;
      cumulative = "";
      enqueueWrite("streaming");
    },
    async finish(status): Promise<void> {
      if (!finished) {
        finished = true;
        enqueueWrite(status);
      }
      while (draining) await draining;
    },
  };
}
