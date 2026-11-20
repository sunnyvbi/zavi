import { describe, it, expect } from "vitest";
import { redactTrajectory } from "../redact-trajectory";

describe("redactTrajectory", () => {
  it("scrubs PII + secrets in nested string values", () => {
    const { value, redactions } = redactTrajectory({
      question: "email me at jane@acme.com or call 555-123-4567",
      nested: { token: "Bearer abcdefghijklmnopqrstuvwxyz123456" },
      count: 42,
      ok: true,
      nothing: null,
    });
    const v = value as Record<string, any>;
    expect(v.question).not.toContain("jane@acme.com");
    expect(v.question).not.toContain("555-123-4567");
    expect(v.nested.token).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(v.count).toBe(42);
    expect(v.ok).toBe(true);
    expect(v.nothing).toBeNull();
    expect(redactions).toBeGreaterThanOrEqual(2);
  });

  it("leaves clean text untouched with 0 redactions", () => {
    const { value, redactions } = redactTrajectory({ q: "how many bookings today" });
    expect((value as Record<string, any>).q).toBe("how many bookings today");
    expect(redactions).toBe(0);
  });

  it("recurses into arrays", () => {
    const { value } = redactTrajectory({ tools: ["ssn 123-45-6789", "ok"] });
    const tools = (value as Record<string, any>).tools;
    expect(tools[0]).not.toContain("123-45-6789");
    expect(tools[1]).toBe("ok");
  });

  it("scrubs GitHub + Slack tokens (sandbox / slack-handler leaks)", () => {
    const { value } = redactTrajectory({
      output_text: "pushed with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      error: "slack 401 token xoxb-123456789012-abcdefghijklmnop",
    });
    const v = value as Record<string, any>;
    expect(v.output_text).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(v.error).not.toContain("xoxb-123456789012-abcdefghijklmnop");
  });

  it("collapses undefined to null and keeps numbers", () => {
    const { value } = redactTrajectory({ a: undefined, b: 3.14 });
    const v = value as Record<string, any>;
    expect(v.a).toBeNull();
    expect(v.b).toBe(3.14);
  });
});
