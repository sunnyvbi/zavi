import { describe, it, expect } from "vitest";
import { extractSlackTs, nextStatusOnFailure, outboxThreadTs } from "../slack-outbox-drainer";

describe("extractSlackTs — proof-of-delivery ts from post_message MCP result", () => {
  it("parses ts from the JSON content payload (real McpCallResult shape)", () => {
    const res = { ok: true, is_error: false, ms: 10, content: JSON.stringify({ ts: "1700000000.0001", channel: "C1" }) };
    expect(extractSlackTs(res)).toBe("1700000000.0001");
  });
  it("reads top-level ts (already-parsed object — tests/defensive)", () => {
    expect(extractSlackTs({ ts: "1700000000.0002" })).toBe("1700000000.0002");
  });
  it("content present but no ts → null", () => {
    expect(extractSlackTs({ content: JSON.stringify({ channel: "C1" }) })).toBeNull();
  });
  it("malformed content JSON → null (never throws)", () => {
    expect(extractSlackTs({ content: "not json {" })).toBeNull();
  });
  it("null / missing / non-string → null (never throws)", () => {
    expect(extractSlackTs(null)).toBeNull();
    expect(extractSlackTs({})).toBeNull();
    expect(extractSlackTs({ ts: 123 })).toBeNull();
    expect(extractSlackTs("nope")).toBeNull();
  });
});

describe("nextStatusOnFailure — retry-until-cap then terminal", () => {
  it("under the cap → pending (re-claimed next tick)", () => {
    expect(nextStatusOnFailure(1, 5)).toBe("pending");
    expect(nextStatusOnFailure(4, 5)).toBe("pending");
  });
  it("at/over the cap → failed (terminal)", () => {
    expect(nextStatusOnFailure(5, 5)).toBe("failed");
    expect(nextStatusOnFailure(7, 5)).toBe("failed");
  });
});

describe("outboxThreadTs — omit empty thread_ts for top-level posts (Phase B1)", () => {
  it("maps the '' thread-root key (top-level post) to undefined so Slack omits thread_ts", () => {
    expect(outboxThreadTs("")).toBeUndefined();
  });
  it("maps null (non-run post) to undefined", () => {
    expect(outboxThreadTs(null)).toBeUndefined();
  });
  it("maps undefined to undefined", () => {
    expect(outboxThreadTs(undefined)).toBeUndefined();
  });
  it("passes a real thread ts through unchanged (thread reply — the existing side-post path)", () => {
    expect(outboxThreadTs("1700000000.0001")).toBe("1700000000.0001");
  });
});
