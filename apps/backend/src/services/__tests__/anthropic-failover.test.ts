import { describe, it, expect } from "vitest";
import { isRetryableAnthropicError, runWithTokenFailover } from "../anthropic";

const noSleep = async () => {};

describe("isRetryableAnthropicError", () => {
  it("treats 429 / 5xx / overload / transport faults as retryable", () => {
    expect(isRetryableAnthropicError({ status: 429 })).toBe(true);
    expect(isRetryableAnthropicError({ status: 500 })).toBe(true);
    expect(isRetryableAnthropicError({ status: 529 })).toBe(true);
    expect(isRetryableAnthropicError({ message: "Overloaded" })).toBe(true);
    expect(isRetryableAnthropicError({ name: "AbortError" })).toBe(true);
    expect(isRetryableAnthropicError({ message: "ECONNRESET" })).toBe(true);
    expect(isRetryableAnthropicError({ message: "Premature close" })).toBe(true);
  });
  it("does NOT retry deterministic 400 / 401 / 403", () => {
    expect(isRetryableAnthropicError({ status: 400 })).toBe(false);
    expect(isRetryableAnthropicError({ status: 401, message: "Invalid bearer token" })).toBe(false);
    expect(isRetryableAnthropicError({ status: 403 })).toBe(false);
  });
});

describe("runWithTokenFailover", () => {
  it("rotates to the next token on a retryable error and succeeds", async () => {
    const used: Array<string | undefined> = [];
    const out = await runWithTokenFailover(
      ["a", "b", "c"],
      async (t) => {
        used.push(t);
        if (t === "a") throw { status: 429 };
        return `ok:${t}`;
      },
      noSleep,
    );
    expect(out).toBe("ok:b");
    expect(used).toEqual(["a", "b"]);
  });

  it("bubbles a non-retryable error immediately WITHOUT rotating", async () => {
    const used: Array<string | undefined> = [];
    await expect(
      runWithTokenFailover(
        ["a", "b"],
        async (t) => {
          used.push(t);
          throw { status: 400, message: "bad request" };
        },
        noSleep,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(used).toEqual(["a"]);
  });

  it("throws the last error after exhausting the whole pool on retryable errors", async () => {
    const used: Array<string | undefined> = [];
    await expect(
      runWithTokenFailover(
        ["a", "b"],
        async (t) => {
          used.push(t);
          throw { status: 429, message: `limited-${t}` };
        },
        noSleep,
      ),
    ).rejects.toMatchObject({ message: "limited-b" });
    expect(used).toEqual(["a", "b"]);
  });

  it("STOPS rotating the moment the caller's signal is aborted (deadline, not transport)", async () => {
    const used: Array<string | undefined> = [];
    const signal = { aborted: false };
    await expect(
      runWithTokenFailover(
        ["a", "b", "c"],
        async (t) => {
          used.push(t);
          signal.aborted = true;
          throw { name: "AbortError", message: "aborted" };
        },
        noSleep,
        signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(used).toEqual(["a"]);
  });

  it("single-token pool calls exactly once", async () => {
    let n = 0;
    const out = await runWithTokenFailover(["only"], async () => { n++; return "x"; }, noSleep);
    expect(out).toBe("x");
    expect(n).toBe(1);
  });
});
