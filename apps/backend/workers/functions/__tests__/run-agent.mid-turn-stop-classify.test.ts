
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NonRetriableError } from "inngest";

const SRC = readFileSync(join(__dirname, "../run-agent.ts"), "utf8");

async function classifyDispatchError(
  e: unknown,
  run_id: string,
  isRunStopRequested: (id: string) => Promise<boolean>,
): Promise<never> {
  const msg = (e as Error).message ?? "unknown dispatch error";
  if (
    msg !== "run_cancelled" &&
    /aborted by user/i.test(msg) &&
    (await isRunStopRequested(run_id))
  ) {
    throw new NonRetriableError("run_cancelled");
  }
  if (msg === "run_cancelled") throw e;
  throw e;
}

describe("run-agent — mid-turn stop classification (behavior)", () => {
  it("reclassifies 'aborted by user' + stop_requested=true → NonRetriableError(run_cancelled)", async () => {
    const isRunStopRequested = vi.fn().mockResolvedValue(true);
    const original = new Error("Claude Code process aborted by user");

    let caught: unknown;
    try {
      await classifyDispatchError(original, "run-1", isRunStopRequested);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(NonRetriableError);
    expect((caught as Error).message).toBe("run_cancelled");
    expect(isRunStopRequested).toHaveBeenCalledWith("run-1");
  });

  it("does NOT reclassify 'aborted by user' when stop_requested=false (ceiling/budget abort)", async () => {
    const isRunStopRequested = vi.fn().mockResolvedValue(false);
    const original = new Error("Claude Code process aborted by user");

    let caught: unknown;
    try {
      await classifyDispatchError(original, "run-2", isRunStopRequested);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(original);
    expect(caught).not.toBeInstanceOf(NonRetriableError);
    expect((caught as Error).message).toBe("Claude Code process aborted by user");
    expect(isRunStopRequested).toHaveBeenCalledWith("run-2");
  });

  it("rethrows a 'run_cancelled' throw UNCHANGED (tool-boundary path, never re-checks stop)", async () => {
    const isRunStopRequested = vi.fn().mockResolvedValue(true);
    const original = new Error("run_cancelled");

    let caught: unknown;
    try {
      await classifyDispatchError(original, "run-3", isRunStopRequested);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(original);
    expect(caught).not.toBeInstanceOf(NonRetriableError);
    expect(isRunStopRequested).not.toHaveBeenCalled();
  });
});

describe("run-agent — mid-turn stop classification (source wiring)", () => {
  it("imports NonRetriableError + isRunStopRequested", () => {
    expect(SRC).toMatch(/import \{ NonRetriableError \} from "inngest";/);
    expect(SRC).toMatch(
      /import \{ isRunStopRequested \} from "@\/services\/agents\/run-stop";/,
    );
  });

  it("reclassifies an 'aborted by user' Stop to NonRetriableError(run_cancelled)", () => {
    expect(SRC).toMatch(
      /msg !== "run_cancelled" &&\s*\n\s*\/aborted by user\/i\.test\(msg\) &&\s*\n\s*\(await isRunStopRequested\(run_id\)\)/,
    );
    expect(SRC).toMatch(/throw new NonRetriableError\("run_cancelled"\);/);
  });

  it("keeps the existing run_cancelled rethrow after the reclassification branch", () => {
    expect(SRC).toMatch(/if \(msg === "run_cancelled"\) throw e;/);
  });
});
