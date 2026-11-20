
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { SteerSource, UserContent } from "./types";

export interface SteerablePromptMessage {
  type: "user";
  message: { role: "user"; content: MessageParam["content"] };
  parent_tool_use_id: null;
  session_id: string;
}

export interface SteerablePromptOpts {
  steerSource?: SteerSource;
  signal?: AbortSignal;
  pollMs?: number;
  maxPerDrain?: number;
  onSteerDrained?: (count: number, turn: number) => void;
  modelIdle?: { value: boolean };
  onDrainFailure?: (args: {
    consecutive: number;
    error: string;
    degraded: boolean;
  }) => void;
}

const DEFAULT_POLL_MS = 2500;
const DEFAULT_MAX_PER_DRAIN = 10;
const MAX_CONSECUTIVE_DRAIN_ERRORS = 3;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function buildSteerablePromptStream(
  content: UserContent,
  sessionId: string,
  opts: SteerablePromptOpts = {},
): AsyncIterable<SteerablePromptMessage> {
  const { steerSource, signal, onSteerDrained, modelIdle, onDrainFailure } = opts;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const maxPerDrain = opts.maxPerDrain ?? DEFAULT_MAX_PER_DRAIN;

  return (async function* () {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content },
      parent_tool_use_id: null,
      session_id: sessionId,
    };

    if (!steerSource) return;

    let afterSeq = 0;
    let turn = 0;
    let consecutiveDrainErrors = 0;
    while (!signal?.aborted) {
      let steers;
      try {
        steers = await steerSource.drain(afterSeq, maxPerDrain);
        consecutiveDrainErrors = 0;
      } catch (e) {
        consecutiveDrainErrors += 1;
        const err = (e as Error)?.message ?? String(e);
        const degraded =
          consecutiveDrainErrors >= MAX_CONSECUTIVE_DRAIN_ERRORS ||
          modelIdle?.value === true;
        onDrainFailure?.({ consecutive: consecutiveDrainErrors, error: err, degraded });
        if (degraded) return;
        await abortableSleep(pollMs, signal);
        continue;
      }
      if (!steers || steers.length === 0) {
        if (modelIdle?.value) return;
        await abortableSleep(pollMs, signal);
        continue;
      }
      turn += 1;
      for (const s of steers) {
        if (signal?.aborted) return;
        if (modelIdle) modelIdle.value = false;
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: s.body },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
        if (signal?.aborted) return;
        try {
          await steerSource.markDrained([s.id], turn);
        } catch {
          await abortableSleep(pollMs, signal);
        }
        afterSeq = s.seq;
        onSteerDrained?.(1, turn);
      }
    }
  })();
}
