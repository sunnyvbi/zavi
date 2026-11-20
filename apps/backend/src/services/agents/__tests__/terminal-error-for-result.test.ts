import { describe, it, expect } from "vitest";

import {
  PARSE_FAILED_USER_ERROR,
  terminalErrorForResult,
} from "../runner";

describe("terminalErrorForResult", () => {
  it("clears the error on success (racing-writer defence is preserved)", () => {
    expect(terminalErrorForResult({ parse_ok: true })).toBeNull();
  });

  it("records a customer-safe explanation on parse_failed", () => {
    expect(terminalErrorForResult({ parse_ok: false })).toBe(
      PARSE_FAILED_USER_ERROR,
    );
  });

  it("never writes null on parse_failed — that was the bug", () => {
    expect(terminalErrorForResult({ parse_ok: false })).not.toBeNull();
  });

  it("a parse_failed run is distinguishable from a clean success", () => {
    expect(terminalErrorForResult({ parse_ok: false })).not.toBe(
      terminalErrorForResult({ parse_ok: true }),
    );
  });
});

describe("the customer-facing string leaks no internals", () => {
  const FORBIDDEN =
    /envelope|parse_ok|parse_error|schema|json|sandbox|dispatch|redispatch|boot_reap|stack|null|undefined|<[a-z]/i;

  it("uses no parser or control-plane jargon", () => {
    expect(PARSE_FAILED_USER_ERROR).not.toMatch(FORBIDDEN);
  });

  it("tells the customer what it means for them", () => {
    expect(PARSE_FAILED_USER_ERROR).toMatch(/follow-up actions were skipped/i);
    expect(PARSE_FAILED_USER_ERROR.length).toBeLessThan(200);
  });
});
