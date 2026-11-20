
import { describe, it, expect } from "vitest";
import {
  parseFailingTestNames,
  newlyFailing,
  type TestNameParse,
} from "../engineer-test-names";

describe("parseFailingTestNames — vitest", () => {
  const REAL_VITEST = `
 ❯ src/services/sandbox/browser-mcp/__tests__/fleet-browser-tool-isolation.test.ts:53:58
     51|   it("browser-operator's declared tool surface holds NO money/code…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[109/127]⎯

 FAIL  src/services/sandbox/browser-mcp/__tests__/fleet-browser-tool-isolation.test.ts > fleet browser-tool isolation (Option A delegation hub) > browser-operator's declared tool surface holds NO money/code/outbound tool (least-privilege)
 FAIL  src/agents/engineer/__tests__/ship-gate.test.ts > evaluateCtoShipGate — trust receipt > model self-reports ALL GREEN but the run_tests receipt says failed → HARD BLOCK

 Test Files  30 failed | 1407 passed (1459)
      Tests  118 failed | 16159 passed (16411)
`;

  it("extracts file + full describe/it chain as the identity", () => {
    const r = parseFailingTestNames(REAL_VITEST);
    expect(r.runner).toBe("vitest");
    expect(r.confidence).toBe("high");
    expect(r.names).toHaveLength(2);
    expect(r.names.some((n) => n.includes("fleet-browser-tool-isolation.test.ts"))).toBe(true);
    expect(r.names.some((n) => n.includes("least-privilege"))).toBe(true);
  });

  it("is stable across runs — same failures produce the same sorted, deduped set", () => {
    const a = parseFailingTestNames(REAL_VITEST);
    const b = parseFailingTestNames(REAL_VITEST + "\n" + REAL_VITEST);
    expect(b.names).toEqual(a.names);
  });
});

describe("parseFailingTestNames — other runners", () => {
  it("pytest: FAILED path::test", () => {
    const r = parseFailingTestNames(
      "FAILED tests/test_auth.py::test_expired_token - AssertionError: 401 != 200\n" +
        "FAILED tests/test_auth.py::test_missing_header - KeyError",
    );
    expect(r.runner).toBe("pytest");
    expect(r.confidence).toBe("high");
    expect(r.names).toEqual([
      "tests/test_auth.py::test_expired_token",
      "tests/test_auth.py::test_missing_header",
    ]);
  });

  it("go: --- FAIL: TestName", () => {
    const r = parseFailingTestNames("--- FAIL: TestLogin/expired (0.00s)\n--- FAIL: TestSignup (0.01s)");
    expect(r.runner).toBe("go");
    expect(r.confidence).toBe("high");
    expect(r.names).toEqual(["TestLogin/expired", "TestSignup"]);
  });

  it("jest: ● suite › test", () => {
    const r = parseFailingTestNames("  ● auth › rejects an expired token\n  ● auth › rejects a missing header");
    expect(r.runner).toBe("jest");
    expect(r.confidence).toBe("high");
    expect(r.names).toHaveLength(2);
  });
});

describe("parseFailingTestNames — REFUSES to guess (the safety property)", () => {
  it("unrecognised runner → confidence none, NOT an empty 'nothing failed'", () => {
    const r = parseFailingTestNames("make: *** [test] Error 1\nsome bespoke harness exploded");
    expect(r.confidence).toBe("none");
    expect(r.names).toEqual([]);
  });

  it("empty / non-string output → confidence none", () => {
    expect(parseFailingTestNames("").confidence).toBe("none");
    expect(parseFailingTestNames(undefined as unknown as string).confidence).toBe("none");
  });

  it("a suite that crashed before printing per-test failures → confidence none", () => {
    const r = parseFailingTestNames("Error: Cannot find module 'vitest'\nnpm ERR! code ELIFECYCLE");
    expect(r.confidence).toBe("none");
  });

  it("does not merge runners — a stray line cannot pollute another runner's set", () => {
    const r = parseFailingTestNames("FAILED t.py::test_a - boom\n--- FAIL: TestStray (0.0s)");
    expect(r.runner).toBe("pytest");
    expect(r.names).toEqual(["t.py::test_a"]);
  });
});

describe("newlyFailing — the set-diff the gate blocks on", () => {
  const parse = (names: string[]): TestNameParse => ({
    runner: "pytest",
    names,
    confidence: "high",
  });
  const unknown: TestNameParse = { runner: "unknown", names: [], confidence: "none" };

  it("pre-existing failures on base do NOT count as new (the Apna case)", () => {
    const head = parse(["a::1", "a::2", "a::3"]);
    const base = parse(["a::1", "a::2", "a::3"]);
    expect(newlyFailing(head, base)).toEqual([]);
  });

  it("a genuinely new failure IS returned", () => {
    const head = parse(["a::1", "a::2", "a::3", "b::new"]);
    const base = parse(["a::1", "a::2", "a::3"]);
    expect(newlyFailing(head, base)).toEqual(["b::new"]);
  });

  it("a FIXED test (red on base, green on head) does not block", () => {
    const head = parse(["a::1"]);
    const base = parse(["a::1", "a::2"]);
    expect(newlyFailing(head, base)).toEqual([]);
  });

  it("low-confidence HEAD → null (unknown), never an empty array", () => {
    expect(newlyFailing(unknown, parse(["a::1"]))).toBeNull();
  });

  it("low-confidence BASE → null — 'we could not enumerate base' is NOT 'base was green'", () => {
    expect(newlyFailing(parse(["a::1"]), unknown)).toBeNull();
  });
});

import { extractTestReceipt, classifyVerify } from "../engineer-verify-receipt";

const failedResult = (stdout: string) =>
  JSON.stringify({ exit_code: 1, stdout, stderr: "" });

describe("verify receipt carries failing names + the test command", () => {
  it("a failed run_tests captures the failing names AND the command", () => {
    const r = extractTestReceipt(
      "run_tests",
      failedResult("FAILED t.py::test_a - boom"),
      false,
      { command: "pytest -q" },
    );
    expect(r?.status).toBe("failed");
    expect(r?.failing_tests).toEqual(["t.py::test_a"]);
    expect(r?.names_confidence).toBe("high");
    expect(r?.command).toBe("pytest -q");
  });

  it("lifts the command out of a TRUNCATED input_preview string (not valid JSON)", () => {
    const r = extractTestReceipt(
      "run_tests",
      failedResult("FAILED t.py::test_a - boom"),
      false,
      '{"command":"npm test -- --run","cwd":"/repo","extra":"trunca',
    );
    expect(r?.command).toBe("npm test -- --run");
  });

  it("WEAKEST-WINS: one unparseable failing call poisons the whole set", () => {
    const parseable = extractTestReceipt(
      "run_tests",
      failedResult("FAILED t.py::test_a - boom"),
      false,
      { command: "pytest" },
    )!;
    const unparseable = extractTestReceipt(
      "run_tests",
      failedResult("make: *** [test] Error 1"),
      false,
      { command: "pytest" },
    )!;

    const agg = classifyVerify([parseable, unparseable]);
    expect(agg.status).toBe("failed");
    expect(agg.names_confidence).toBe("none");
    expect(agg.failing_tests).toEqual([]);
  });

  it("all failing calls parseable → union of names, high confidence", () => {
    const a = extractTestReceipt("run_tests", failedResult("FAILED t.py::test_a - x"), false)!;
    const b = extractTestReceipt("run_tests", failedResult("FAILED t.py::test_b - y"), false)!;
    const agg = classifyVerify([a, b]);
    expect(agg.names_confidence).toBe("high");
    expect(agg.failing_tests).toEqual(["t.py::test_a", "t.py::test_b"]);
  });

  it("a green run carries no failing set (nothing to diff)", () => {
    const r = extractTestReceipt("run_tests", JSON.stringify({ exit_code: 0, stdout: "ok" }), false)!;
    expect(r.status).toBe("passed");
    expect(classifyVerify([r]).failing_tests).toBeUndefined();
  });
});
