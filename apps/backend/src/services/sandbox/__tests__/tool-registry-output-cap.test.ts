import { afterEach, describe, expect, it } from "vitest";
import {
  RUN_BASH_OUTPUT_CAP,
  RUN_TESTS_OUTPUT_CAP,
  GIT_DIFF_OVERALL_CAP,
  capExecOutput,
  capExecResult,
  extractDiagnostics,
  stripAnsi,
  execOutputCapsEnabled,
} from "../tool-registry";

describe("execOutputCapsEnabled — default-ON, \"0\" is the kill switch", () => {
  const prev = process.env.SANDBOX_EXEC_OUTPUT_CAPS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SANDBOX_EXEC_OUTPUT_CAPS;
    else process.env.SANDBOX_EXEC_OUTPUT_CAPS = prev;
  });

  it("is ON when env unset (default-on)", () => {
    delete process.env.SANDBOX_EXEC_OUTPUT_CAPS;
    expect(execOutputCapsEnabled()).toBe(true);
  });
  it('is OFF only for the literal kill switch "0"', () => {
    process.env.SANDBOX_EXEC_OUTPUT_CAPS = "0";
    expect(execOutputCapsEnabled()).toBe(false);
    process.env.SANDBOX_EXEC_OUTPUT_CAPS = "1";
    expect(execOutputCapsEnabled()).toBe(true);
    process.env.SANDBOX_EXEC_OUTPUT_CAPS = "true";
    expect(execOutputCapsEnabled()).toBe(true);
  });
});

describe("stripAnsi", () => {
  it("removes color + cursor escape sequences", () => {
    expect(stripAnsi("\x1b[31mFAIL\x1b[0m foo")).toBe("FAIL foo");
    expect(stripAnsi("\x1b[2K\x1b[1Gprogress")).toBe("progress");
  });
  it("leaves plain text + handles null/undefined", () => {
    expect(stripAnsi("no escapes here")).toBe("no escapes here");
    expect(stripAnsi(undefined as unknown as string)).toBe("");
  });
});

describe("capExecOutput", () => {
  it("returns input untruncated when within budget", () => {
    const r = capExecOutput("short output", 1024);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("short output");
    expect(r.original_bytes).toBeUndefined();
  });

  it("strips ANSI before measuring (so color codes don't trip the cap)", () => {
    const colored = "\x1b[32m" + "x".repeat(50) + "\x1b[0m";
    const r = capExecOutput(colored, 100);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("x".repeat(50));
  });

  it("keeps a head+tail window + a self-describing marker when over budget", () => {
    const raw = "HEAD_START" + "m".repeat(50_000) + "TAIL_END";
    const cap = 2048;
    const r = capExecOutput(raw, cap);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("HEAD_START")).toBe(true);
    expect(r.text.endsWith("TAIL_END")).toBe(true);
    expect(r.text).toContain("[truncated");
    expect(r.original_bytes).toBe(Buffer.byteLength(raw, "utf8"));
    expect(r.kept_bytes!).toBeLessThanOrEqual(cap);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThan(cap + 256);
  });

  it("uses a custom hint in the marker when provided", () => {
    const r = capExecOutput("z".repeat(5000), 256, "use git_diff with a path");
    expect(r.text).toContain("use git_diff with a path");
  });

  it("never throws on multibyte content at the slice boundary", () => {
    const raw = "😀".repeat(10_000);
    expect(() => capExecOutput(raw, 1000)).not.toThrow();
    const r = capExecOutput(raw, 1000);
    expect(r.truncated).toBe(true);
  });
});

describe("capExecResult — enabled-path JSON shape (kill switch ON)", () => {
  const prev = process.env.SANDBOX_EXEC_OUTPUT_CAPS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SANDBOX_EXEC_OUTPUT_CAPS;
    else process.env.SANDBOX_EXEC_OUTPUT_CAPS = prev;
  });

  it('returns byte-identical shape when caps OFF (kill switch "0")', () => {
    process.env.SANDBOX_EXEC_OUTPUT_CAPS = "0";
    const r = { stdout: "x".repeat(100_000), stderr: "", exit_code: 0, ms: 5 };
    const out = capExecResult(r, RUN_BASH_OUTPUT_CAP);
    expect(out).toEqual({ stdout: r.stdout, stderr: "", exit_code: 0, ms: 5 });
    expect(out._truncated).toBeUndefined();
  });

  it("caps + sets _truncated + truncated envelope when ON and over budget", () => {
    process.env.SANDBOX_EXEC_OUTPUT_CAPS = "1";
    const r = { stdout: "s".repeat(100_000), stderr: "e".repeat(100_000), exit_code: 1, ms: 9 };
    const out = capExecResult(r, RUN_BASH_OUTPUT_CAP);
    expect(out._truncated).toBe(true);
    expect(JSON.stringify(out)).toContain('"_truncated":true');
    expect((out.truncated as Record<string, unknown>).hint).toBeTruthy();
    expect(Buffer.byteLength(out.stdout as string, "utf8")).toBeLessThanOrEqual(RUN_BASH_OUTPUT_CAP);
    expect(Buffer.byteLength(out.stderr as string, "utf8")).toBeLessThanOrEqual(RUN_BASH_OUTPUT_CAP);
    expect(out.exit_code).toBe(1);
  });

  it("does NOT set _truncated when ON but output fits", () => {
    process.env.SANDBOX_EXEC_OUTPUT_CAPS = "1";
    const r = { stdout: "small", stderr: "", exit_code: 0, ms: 1 };
    const out = capExecResult(r, RUN_BASH_OUTPUT_CAP);
    expect(out._truncated).toBeUndefined();
    expect(out.stdout).toBe("small");
  });
});

describe("extractDiagnostics — Layer-2 semantic extractor (engineer profile)", () => {
  it("keeps a tsc error buried deep in the log when over budget", () => {
    const noise = Array.from({ length: 4000 }, (_, i) => `compiling module ${i} ... ok`).join("\n");
    const raw = noise + "\nsrc/foo.ts(42,10): error TS2322: Type 'string' is not assignable to type 'number'.\n" + noise;
    const r = extractDiagnostics(raw, 4096, true);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("error TS2322");
    expect(r.errors?.some((e) => e.includes("error TS2322"))).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(4096);
  });

  it("preserves a jest assertion block in the middle of passing tests", () => {
    const pass = Array.from({ length: 2000 }, (_, i) => `✓ test case ${i} passed`).join("\n");
    const raw = pass + "\nFAIL src/x.test.ts\n  Expected: 5\n  Received: 4\n" + pass;
    const r = extractDiagnostics(raw, 3072, true);
    expect(r.text).toContain("Expected: 5");
    expect(r.text).toContain("Received: 4");
    expect(r.errors?.length).toBeGreaterThan(0);
  });

  it("matches eslint stylish-format diagnostics buried in a long log", () => {
    const noise = Array.from({ length: 3000 }, (_, i) => `ok ${i}`).join("\n");
    const raw = noise + "\n/repo/src/x.ts\n  12:3  error  'foo' is not defined  no-undef\n" + noise;
    const r = extractDiagnostics(raw, 2048, true);
    expect(r.text).toContain("12:3");
    expect(r.text).toContain("no-undef");
    expect(r.errors?.some((e) => e.includes("no-undef"))).toBe(true);
  });

  it("matches vitest diff format (- Expected / + Received, no colon)", () => {
    const noise = Array.from({ length: 3000 }, (_, i) => `✓ ok ${i}`).join("\n");
    const raw = noise + "\n  - Expected\n  + Received\n  - 42\n  + 41\n" + noise;
    const r = extractDiagnostics(raw, 2048, true);
    expect(r.text).toContain("- Expected");
    expect(r.text).toContain("+ Received");
  });

  it("falls back to head+tail when NO markers present", () => {
    const raw = "HEADLINE\n" + "plain log line\n".repeat(5000) + "LASTLINE";
    const r = extractDiagnostics(raw, 2048, false);
    expect(r.truncated).toBe(true);
    expect(r.errors).toBeUndefined();
    expect(r.text.startsWith("HEADLINE")).toBe(true);
    expect(r.text.endsWith("LASTLINE")).toBe(true);
  });

  it("never exceeds the byte ceiling even when the log is almost all errors", () => {
    const raw = Array.from({ length: 5000 }, (_, i) => `src/a.ts(${i},1): error TS1005: ';' expected.`).join("\n");
    const r = extractDiagnostics(raw, 2048, true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(2048 + 8);
    expect(r.errors?.length).toBeGreaterThan(0);
  });

  it("returns untruncated + surfaces errors when within budget", () => {
    const raw = "ok\nsrc/b.ts(1,1): error TS2304: Cannot find name 'foo'.\nok";
    const r = extractDiagnostics(raw, 8192, true);
    expect(r.truncated).toBe(false);
    expect(r.errors).toEqual(["src/b.ts(1,1): error TS2304: Cannot find name 'foo'."]);
  });
});

describe("capExecResult — engineer profile surfaces _errors", () => {
  const prev = process.env.SANDBOX_EXEC_OUTPUT_CAPS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SANDBOX_EXEC_OUTPUT_CAPS;
    else process.env.SANDBOX_EXEC_OUTPUT_CAPS = prev;
  });

  it("engineer profile keeps the error + emits _errors; default profile does not", () => {
    process.env.SANDBOX_EXEC_OUTPUT_CAPS = "1";
    const noise = "x".repeat(60_000);
    const r = { stdout: noise + "\nerror TS2552: did you mean 'bar'?\n" + noise, stderr: "", exit_code: 2, ms: 7 };

    const eng = capExecResult(r, RUN_TESTS_OUTPUT_CAP, "engineer");
    expect(eng._truncated).toBe(true);
    expect((eng._errors as string[]).some((e) => e.includes("TS2552"))).toBe(true);
    expect(eng.stdout as string).toContain("error TS2552");

    const def = capExecResult(r, RUN_TESTS_OUTPUT_CAP, "default");
    expect(def._errors).toBeUndefined();
  });
});

describe("cap consts are ordered to fit their tools", () => {
  it("run_tests budget >= run_bash budget; git_diff sits between", () => {
    expect(RUN_TESTS_OUTPUT_CAP).toBeGreaterThanOrEqual(RUN_BASH_OUTPUT_CAP);
    expect(GIT_DIFF_OVERALL_CAP).toBeGreaterThanOrEqual(RUN_BASH_OUTPUT_CAP);
  });
});
