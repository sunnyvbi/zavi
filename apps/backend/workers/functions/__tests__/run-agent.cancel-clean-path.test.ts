import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(__dirname, "../run-agent.ts"), "utf8");

describe("run-agent — run_cancelled is a clean terminal, not a failure", () => {
  it("inner dispatch catch rethrows run_cancelled unadorned (no error bookkeeping)", () => {
    expect(SRC).toMatch(/if \(msg === "run_cancelled"\) throw e;/);
  });

  it("outer catch derives isCancelled and gates the failure side-channel on it", () => {
    expect(SRC).toMatch(/const isCancelled = message === "run_cancelled";/);
    expect(SRC).toMatch(/if \(!isCancelled\) \{[\s\S]*?code: "run_terminal_error"/);
    expect(SRC).toMatch(
      /if \(!isCancelled\) \{[\s\S]*?emitWorker\("failed", \{ code: "dispatch_error" \}\)[\s\S]*?name: "agent\.run\.failed"/,
    );
    expect(SRC).toMatch(/claim\.trigger === "cron" && !isCancelled/);
  });

  it("returns the clean 'cancelled' status (not dispatch_error) on a Stop", () => {
    expect(SRC).toMatch(
      /if \(isCancelled\) \{\s*\n\s*return \{ run_id, status: "cancelled" as const, error: null \};/,
    );
  });
});
