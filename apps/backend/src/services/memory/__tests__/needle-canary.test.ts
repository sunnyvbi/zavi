import { describe, it, expect } from "vitest";
import {
  NONCE_RE,
  evaluateNeedle,
  summarizeNeedleRun,
  type NeedleResult,
} from "../needle-canary";

const ALL = ["BLUE-FALCON-713", "AMBER-COYOTE-284", "SILVER-HERON-908"];

function evalOne(prompt: string, answer: string, nonce = "BLUE-FALCON-713") {
  return evaluateNeedle({ prompt, answer, nonce, allNonces: ALL });
}

describe("NONCE_RE", () => {
  it("matches WORD-WORD-NNN nonce shape, not ordinary text", () => {
    expect("code is BLUE-FALCON-713.".match(NONCE_RE)).toEqual(["BLUE-FALCON-713"]);
    expect("blue-falcon-713".match(NONCE_RE)).toBeNull();
    expect("BLUE-FALCON-71".match(NONCE_RE)).toBeNull();
    expect("state-of-the-art launch-review".match(NONCE_RE)).toBeNull();
  });
});

describe("evaluateNeedle verdicts", () => {
  it("pass — nonce in prompt AND answer, nothing foreign", () => {
    const r = evalOne(
      "company memory: format code is BLUE-FALCON-713.",
      "Your preferred format code is BLUE-FALCON-713.",
    );
    expect(r.verdict).toBe("pass");
    expect(r.prompt_has).toBe(true);
    expect(r.answer_has).toBe(true);
    expect(r.foreign_known).toEqual([]);
    expect(r.hallucinated).toEqual([]);
  });

  it("answer_missing — the target regression: memory in prompt, ignored in answer", () => {
    const r = evalOne(
      "company memory: format code is BLUE-FALCON-713.",
      "I don't have a specific format code on record for you.",
    );
    expect(r.verdict).toBe("answer_missing");
    expect(r.prompt_has).toBe(true);
    expect(r.answer_has).toBe(false);
  });

  it("prompt_missing — seeding/recall/anchor bug, not a model failure", () => {
    const r = evalOne(
      "company memory: (no format code present)",
      "Your format code is BLUE-FALCON-713.",
    );
    expect(r.verdict).toBe("prompt_missing");
    expect(r.prompt_has).toBe(false);
  });

  it("hallucinated — answer invents a nonce-shaped token that was never seeded", () => {
    const r = evalOne(
      "company memory: format code is BLUE-FALCON-713.",
      "Your format code is GREEN-WALRUS-001.",
    );
    expect(r.verdict).toBe("hallucinated");
    expect(r.answer_has).toBe(false);
    expect(r.hallucinated).toEqual(["GREEN-WALRUS-001"]);
  });

  it("bleed — right nonce present but a different seeded fact leaked in too", () => {
    const r = evalOne(
      "company memory: BLUE-FALCON-713 and AMBER-COYOTE-284.",
      "Format is BLUE-FALCON-713 (and unrelatedly AMBER-COYOTE-284).",
    );
    expect(r.verdict).toBe("bleed");
    expect(r.answer_has).toBe(true);
    expect(r.foreign_known).toEqual(["AMBER-COYOTE-284"]);
    expect(r.hallucinated).toEqual([]);
  });

  it("prompt_missing outranks answer content (infra failure reported first)", () => {
    const r = evalOne("no memory here", "BLUE-FALCON-713");
    expect(r.verdict).toBe("prompt_missing");
  });
});

describe("summarizeNeedleRun", () => {
  it("counts verdicts, computes pass_rate, and lists non-pass failures", () => {
    const results: NeedleResult[] = [
      { nonce: "A", prompt_has: true, answer_has: true, foreign_known: [], hallucinated: [], verdict: "pass" },
      { nonce: "B", prompt_has: true, answer_has: false, foreign_known: [], hallucinated: [], verdict: "answer_missing" },
      { nonce: "C", prompt_has: false, answer_has: false, foreign_known: [], hallucinated: [], verdict: "prompt_missing" },
    ];
    const s = summarizeNeedleRun(results);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(1);
    expect(s.pass_rate).toBeCloseTo(1 / 3);
    expect(s.by_verdict.answer_missing).toBe(1);
    expect(s.by_verdict.prompt_missing).toBe(1);
    expect(s.failures.map((f) => f.verdict)).toEqual(["answer_missing", "prompt_missing"]);
  });

  it("empty run is pass_rate 0, not NaN", () => {
    expect(summarizeNeedleRun([]).pass_rate).toBe(0);
  });
});
