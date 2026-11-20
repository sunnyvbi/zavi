
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NonRetriableError } from "inngest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasRunFailureCode } from "../run-failure-code";
import {
  SDK_RUN_CEILING_CODE,
  SdkRunCeilingError,
  relabelIfCeilingHit,
} from "../sdk-run-ceiling";

const SDK_ABORT_MSG = "Claude Code process aborted by user";
const CEILING_MS = 25 * 60 * 1000;

async function runSpanLikeDispatcher(opts: {
  ceilingMs: number;
  consume: (signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const ac = new AbortController();
  let ceilingHit = false;
  const timer = setTimeout(() => {
    if (!ac.signal.aborted) {
      ceilingHit = true;
      ac.abort();
    }
  }, opts.ceilingMs);
  try {
    await opts.consume(ac.signal);
  } catch (spanErr) {
    throw relabelIfCeilingHit(spanErr, ceilingHit, opts.ceilingMs);
  } finally {
    clearTimeout(timer);
  }
}

function workerRethrow(e: unknown, stopRequested: boolean): unknown {
  const msg = (e as Error).message;
  if (/aborted by user/i.test(msg) && stopRequested) return new NonRetriableError("run_cancelled");
  if (hasRunFailureCode(e)) return new NonRetriableError(msg);
  return e;
}

const hangUntilAborted = (signal: AbortSignal) =>
  new Promise<void>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error(SDK_ABORT_MSG)));
  });

describe("SDK run ceiling terminalizes the run", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("a ceiling abort surfaces as a non-retryable sdk_run_ceiling error", async () => {
    const run = runSpanLikeDispatcher({ ceilingMs: CEILING_MS, consume: hangUntilAborted });
    const settled = run.catch((e) => e);
    await vi.advanceTimersByTimeAsync(CEILING_MS);
    const err = await settled;

    expect(err).toBeInstanceOf(SdkRunCeilingError);
    expect((err as Error).message).toMatch(/^sdk_run_ceiling: /);
    expect((err as Error).message).not.toMatch(/aborted by user/);

    const rethrown = workerRethrow(err, false);
    expect(rethrown).toBeInstanceOf(NonRetriableError);
    expect((rethrown as Error).message).toBe((err as Error).message);
  });

  it("the raw SDK abort error alone is retryable (the bug this fixes)", () => {
    const raw = new Error(SDK_ABORT_MSG);
    expect(hasRunFailureCode(raw)).toBe(false);
    expect(workerRethrow(raw, false)).toBe(raw);
  });

  it("an abort that is not the ceiling keeps its own error", async () => {
    const ac = new AbortController();
    const run = runSpanLikeDispatcher({
      ceilingMs: CEILING_MS,
      consume: async () => {
        ac.abort();
        throw new Error(SDK_ABORT_MSG);
      },
    }).catch((e) => e);
    const err = await run;
    expect(err).not.toBeInstanceOf(SdkRunCeilingError);
    expect((err as Error).message).toBe(SDK_ABORT_MSG);
  });
});

describe("relabelIfCeilingHit", () => {
  it("leaves errors alone when the ceiling did not fire", () => {
    const e = new Error(SDK_ABORT_MSG);
    expect(relabelIfCeilingHit(e, false, CEILING_MS)).toBe(e);
  });

  it("keeps an explicit Stop or kill switch label", () => {
    for (const code of ["run_cancelled", "kill_switch"]) {
      const e = new Error(code);
      expect(relabelIfCeilingHit(e, true, CEILING_MS)).toBe(e);
    }
  });

  it("relabels any other error once the ceiling fired, with the limit in minutes", () => {
    const out = relabelIfCeilingHit(new Error(SDK_ABORT_MSG), true, CEILING_MS);
    expect(out).toBeInstanceOf(SdkRunCeilingError);
    expect((out as SdkRunCeilingError).run_failure_code).toBe(SDK_RUN_CEILING_CODE);
    expect((out as Error).message).toContain("25-minute");
  });
});

describe("generic-dispatcher wires the ceiling relabel", () => {
  const src = readFileSync(join(__dirname, "..", "generic-dispatcher.ts"), "utf8");

  it("the ceiling timer sets the flag before it aborts", () => {
    expect(src).toMatch(/sdkCeilingHit = true;\s*\n\s*sdkAbortController\.abort\(\);\s*\n\s*\}\s*\n\s*\}, SDK_RUN_CEILING_MS\);/);
  });

  it("the SDK span catch relabels, and its finally clears the ceiling timer", () => {
    expect(src).toMatch(
      /\} catch \(spanErr\) \{[\s\S]{0,600}throw relabelIfCeilingHit\(spanErr, sdkCeilingHit, SDK_RUN_CEILING_MS\);\s*\n\s*\} finally \{[\s\S]{0,600}if \(sdkCeilingTimer\) clearTimeout\(sdkCeilingTimer\);\s*\n\s*\}\s*\n\s*\} \/\/ end Agent SDK path/,
    );
  });
});
