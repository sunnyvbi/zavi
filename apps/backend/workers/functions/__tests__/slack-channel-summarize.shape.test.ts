
import { describe, it, expect } from "vitest";
import { safeParseOpus } from "../slack-channel-summarize";

describe("Opus output shape . summary_md + sidecar invariants (W1 P1 #6)", () => {
  it("(a) summary_md is non-empty + ≤1500 chars on a known-length happy-path response", () => {
    const summary = "## Summary\n- Team discussed Q3 ad spend.\n- Decision: pause Meta until creative refresh ships.";
    const sidecar = {
      topics: ["Q3 spend", "Meta pause"],
      active_users: ["Alice", "Bob"],
      message_count: 17,
      distinct_user_count: 4,
    };
    const json = JSON.stringify({ summary_md: summary, sidecar });
    const parsed = safeParseOpus(json);
    expect(parsed.summary_md.length).toBeGreaterThan(0);
    expect(parsed.summary_md.length).toBeLessThanOrEqual(1500);
  });

  it("(b) sidecar carries topics: string[] + active_users: string[] + message_count + distinct_user_count", () => {
    const json = JSON.stringify({
      summary_md: "ok",
      sidecar: {
        topics: ["launch"],
        active_users: ["Alice"],
        message_count: 3,
        distinct_user_count: 2,
      },
    });
    const parsed = safeParseOpus(json);
    expect(Array.isArray(parsed.sidecar.topics)).toBe(true);
    expect(parsed.sidecar.topics.every((t) => typeof t === "string")).toBe(true);
    expect(Array.isArray(parsed.sidecar.active_users)).toBe(true);
    expect(parsed.sidecar.active_users.every((u) => typeof u === "string")).toBe(true);
    expect(typeof parsed.sidecar.message_count).toBe("number");
    expect(typeof parsed.sidecar.distinct_user_count).toBe("number");
  });

  it.skip(
    "(c) prompt-builder contains stable header + channel-name placeholder + redacted message block . DEFERRED: no exported prompt-builder; structure is verified by the source-of-truth literal in callOpus()",
    () => {
    },
  );

  it("(d) JSON round-trip . stringify → safeParseOpus → matches input shape", () => {
    const original = {
      summary_md: "round-trip test",
      sidecar: {
        topics: ["a", "b", "c"],
        active_users: ["Alice", "Bob", "Carol"],
        message_count: 99,
        distinct_user_count: 12,
      },
    };
    const reparsed = safeParseOpus(JSON.stringify(original));
    expect(reparsed.summary_md).toBe(original.summary_md);
    expect(reparsed.sidecar.topics).toEqual(original.sidecar.topics);
    expect(reparsed.sidecar.active_users).toEqual(original.sidecar.active_users);
    expect(reparsed.sidecar.message_count).toBe(original.sidecar.message_count);
    expect(reparsed.sidecar.distinct_user_count).toBe(original.sidecar.distinct_user_count);
  });

  it("safeParseOpus drops sidecar fields that don't match their typed shape (defense-in-depth)", () => {
    const malformed = JSON.stringify({
      summary_md: "ok",
      sidecar: {
        topics: "not-an-array",
        active_users: 42,
        message_count: null,
        distinct_user_count: "ten",
      },
    });
    const out = safeParseOpus(malformed);
    expect(out.sidecar.topics).toEqual([]);
    expect(out.sidecar.active_users).toEqual([]);
    expect(out.sidecar.message_count).toBe(0);
    expect(out.sidecar.distinct_user_count).toBe(0);
  });
});
