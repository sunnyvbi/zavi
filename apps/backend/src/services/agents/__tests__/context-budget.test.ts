import { describe, it, expect } from "vitest";
import {
  measureResumeTranscript,
  isContextLengthError,
  shouldSkipDurableResume,
  RESUME_TRANSCRIPT_WARN_TOKENS,
} from "../context-budget";

describe("measureResumeTranscript", () => {
  it("sums serialized size and derives approx tokens (chars/4)", () => {
    const entries = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
    const expectedChars =
      JSON.stringify(entries[0]).length + JSON.stringify(entries[1]).length;
    const m = measureResumeTranscript(entries);
    expect(m.entries).toBe(2);
    expect(m.chars).toBe(expectedChars);
    expect(m.approxTokens).toBe(Math.round(expectedChars / 4));
    expect(m.overWarn).toBe(false);
  });

  it("flags overWarn once approx tokens cross the ceiling", () => {
    const big = "x".repeat((RESUME_TRANSCRIPT_WARN_TOKENS + 5_000) * 4);
    const m = measureResumeTranscript([{ content: big }]);
    expect(m.approxTokens).toBeGreaterThan(RESUME_TRANSCRIPT_WARN_TOKENS);
    expect(m.overWarn).toBe(true);
  });

  it("treats non-array / null as empty (never throws)", () => {
    expect(measureResumeTranscript(null)).toMatchObject({ entries: 0, chars: 0, overWarn: false });
    expect(measureResumeTranscript(undefined)).toMatchObject({ entries: 0, chars: 0 });
    expect(measureResumeTranscript("not-an-array")).toMatchObject({ entries: 0, chars: 0 });
  });

  it("skips an unserializable (circular) entry instead of throwing", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const m = measureResumeTranscript([{ ok: "yes" }, circular]);
    expect(m.entries).toBe(2);
    expect(m.chars).toBe(JSON.stringify({ ok: "yes" }).length);
  });
});

describe("shouldSkipDurableResume (cap decision)", () => {
  it("does NOT cap a within-budget transcript (durable resume proceeds)", () => {
    const small = measureResumeTranscript([{ role: "user", content: "hi" }]);
    expect(small.overWarn).toBe(false);
    expect(shouldSkipDurableResume(small)).toBe(false);
  });

  it("CAPS an over-ceiling transcript (falls back to bounded flatten)", () => {
    const big = measureResumeTranscript([
      { content: "x".repeat((RESUME_TRANSCRIPT_WARN_TOKENS + 5_000) * 4) },
    ]);
    expect(big.overWarn).toBe(true);
    expect(shouldSkipDurableResume(big)).toBe(true);
  });

  it("cap decision tracks overWarn exactly across sizes (one signal, no drift)", () => {
    for (const n of [1, 10_000, RESUME_TRANSCRIPT_WARN_TOKENS - 1, RESUME_TRANSCRIPT_WARN_TOKENS + 50_000]) {
      const s = measureResumeTranscript([{ content: "z".repeat(n * 4) }]);
      expect(shouldSkipDurableResume(s)).toBe(s.overWarn);
    }
  });
});

describe("isContextLengthError", () => {
  it("matches known provider overflow phrasings (case-insensitive)", () => {
    expect(isContextLengthError("prompt is too long: 210000 tokens > 200000 maximum")).toBe(true);
    expect(isContextLengthError("This model's maximum context length is 128000 tokens")).toBe(true);
    expect(isContextLengthError(new Error("context_length_exceeded"))).toBe(true);
    expect(isContextLengthError("Exceeds the CONTEXT WINDOW for this model")).toBe(true);
  });

  it("does NOT match unrelated errors (abort, output cap, transport)", () => {
    expect(isContextLengthError("run_cancelled")).toBe(false);
    expect(isContextLengthError("max_tokens reached mid-envelope")).toBe(false);
    expect(isContextLengthError("ECONNRESET")).toBe(false);
    expect(isContextLengthError(null)).toBe(false);
    expect(isContextLengthError(undefined)).toBe(false);
    expect(isContextLengthError("")).toBe(false);
  });
});
