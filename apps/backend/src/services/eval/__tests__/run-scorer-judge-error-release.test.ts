
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRetryableJudgeError } from "../run-scorer";

describe("isRetryableJudgeError", () => {
  it("retries a rate limit", () => {
    expect(isRetryableJudgeError("429 Rate limit reached for gpt-5.5")).toBe(true);
    expect(isRetryableJudgeError("rate_limit_exceeded")).toBe(true);
  });

  it("retries provider 5xx and overload", () => {
    for (const m of ["500 internal error", "502 Bad Gateway", "503", "504 gateway timeout", "Overloaded"]) {
      expect(isRetryableJudgeError(m)).toBe(true);
    }
  });

  it("retries a transport hiccup", () => {
    for (const m of ["ETIMEDOUT", "ECONNRESET", "socket hang up", "fetch failed", "Request timed out"]) {
      expect(isRetryableJudgeError(m)).toBe(true);
    }
  });

  it("does NOT retry a failure that will never fix itself", () => {
    expect(
      isRetryableJudgeError("401 Incorrect API key provided: sk-proj-****"),
    ).toBe(false);
    expect(isRetryableJudgeError("403 Project does not have access to model gpt-5.5")).toBe(false);
    expect(
      isRetryableJudgeError("404 The model `gpt-5.5` does not exist or you do not have access to it"),
    ).toBe(false);
    expect(
      isRetryableJudgeError("callModel: OPENAI_API_KEY unset but provider 'openai' was requested"),
    ).toBe(false);
    expect(isRetryableJudgeError("run-scorer: unparseable judge reply for run abc")).toBe(false);
  });

  it("does not treat a bare 400 schema rejection as retryable", () => {
    expect(
      isRetryableJudgeError("400 Invalid schema for response_format 'extract'"),
    ).toBe(false);
  });

  it("is safe on empty/garbage input", () => {
    expect(isRetryableJudgeError("")).toBe(false);
    expect(isRetryableJudgeError(undefined as unknown as string)).toBe(false);
  });

  it("does not match a status-code-like substring inside an identifier", () => {
    expect(isRetryableJudgeError("unparseable judge reply for run a429b1c2-dead")).toBe(false);
  });
});

describe("judge-blackout alert pages a human", () => {
  const src = readFileSync(join(__dirname, "../run-scorer.ts"), "utf8");
  const blackout = src.slice(src.indexOf("run_scorer_judge_blackout"));
  const block = blackout.slice(0, blackout.indexOf("}).catch("));

  it("opts into the email page (default-OFF is wrong for an L4-bar outage)", () => {
    expect(block).toMatch(/email:\s*\{/);
  });

  it("dedupes on the INCIDENT, not the tick — one mail per day, not per cron fire", () => {
    expect(block).toMatch(/dedupeKey:\s*`run_scorer_judge_blackout:\$\{key\}`/);
  });

  it("does NOT repeat the raw provider error into the unscrubbed email detail", () => {
    const detail = block.slice(block.indexOf("detail:"));
    expect(detail).not.toMatch(/\$\{reason\}/);
  });
});
