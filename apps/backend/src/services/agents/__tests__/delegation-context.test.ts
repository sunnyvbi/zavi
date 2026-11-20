import { describe, it, expect } from "vitest";
import {
  buildDelegationContext,
  DELEGATION_CONTEXT_MAX_BYTES,
  TRUNCATION_MARKER,
} from "../delegation-context";

describe("buildDelegationContext — PII / secret REDACTION (non-skippable)", () => {
  it("Luhn-valid CC in recall body → REDACTED (never raw)", () => {
    const bundle = buildDelegationContext({
      recall: [
        {
          note_id: "note-1",
          title: "billing memo",
          body: "the customer's card on file is 5555-5555-5555-4444 — flagged for review",
        },
      ],
    });
    const blob = JSON.stringify(bundle);
    expect(blob).not.toMatch(/5555-5555-5555-4444/);
    expect(blob).toContain("[CARD]");
  });

  it("OpenAI-style API key in recent_findings → REDACTED", () => {
    const bundle = buildDelegationContext({
      recent_findings: [
        {
          tool_name: "memory__search",
          text: "found a leaked sk-abc123ABCDEFGHIJKLMNOPQRSTUVWXYZ in note body",
        },
      ],
    });
    const blob = JSON.stringify(bundle);
    expect(blob).not.toMatch(/sk-abc123ABCDEFGHIJKLMNOPQRSTUVWXYZ/);
    expect(blob).toContain("[API_KEY]");
  });

  it("JWT in thread excerpt → REDACTED", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.signature-bytes-here-long-enough";
    const bundle = buildDelegationContext({
      thread_excerpt: [
        { role: "user", text: `here's my token to test: ${jwt} — please proceed` },
      ],
    });
    const blob = JSON.stringify(bundle);
    expect(blob).not.toContain(jwt);
    expect(blob).toContain("[JWT]");
  });

  it("multiple PII types in one field → all redacted", () => {
    const bundle = buildDelegationContext({
      thread_excerpt: [
        {
          role: "assistant",
          text: "contact ravi@upcar.ai or +1-415-555-1234, card 4111-1111-1111-1111, ssn 123-45-6789",
        },
      ],
    });
    const blob = JSON.stringify(bundle);
    expect(blob).not.toMatch(/ravi@upcar\.ai/);
    expect(blob).toContain("[EMAIL]");
    expect(blob).toContain("[PHONE]");
    expect(blob).toContain("[CARD]");
    expect(blob).toContain("[SSN]");
  });

  it("title field is ALSO scrubbed (not just body)", () => {
    const bundle = buildDelegationContext({
      recall: [{ note_id: "note-2", title: "ping ravi@upcar.ai", body: "harmless" }],
    });
    const blob = JSON.stringify(bundle);
    expect(blob).not.toContain("ravi@upcar.ai");
    expect(blob).toContain("[EMAIL]");
  });
});

describe("buildDelegationContext — size cap (16KB)", () => {
  it("under cap → not truncated", () => {
    const bundle = buildDelegationContext({
      recent_findings: [{ tool_name: "memory__search", text: "small finding" }],
      recall: [{ note_id: "n1", title: "t1", body: "small body" }],
      thread_excerpt: [{ role: "user", text: "hi" }],
    });
    expect(bundle.truncated).toBe(false);
    expect(JSON.stringify(bundle).length).toBeLessThanOrEqual(DELEGATION_CONTEXT_MAX_BYTES);
  });

  it("one giant body field → clipped + truncation marker present", () => {
    const huge = "x".repeat(50_000);
    const bundle = buildDelegationContext({
      recall: [{ note_id: "n1", title: "t", body: huge }],
    });
    expect(bundle.truncated).toBe(true);
    const blob = JSON.stringify(bundle);
    expect(blob).toContain(TRUNCATION_MARKER);
    expect(blob.length).toBeLessThanOrEqual(DELEGATION_CONTEXT_MAX_BYTES);
  });

  it("100 huge findings + 100 huge recall hits → bundle stays ≤16KB", () => {
    const findings = Array.from({ length: 100 }, (_, i) => ({
      tool_name: "memory__search",
      text: `finding-${i} `.repeat(200),
    }));
    const recall = Array.from({ length: 100 }, (_, i) => ({
      note_id: `n${i}`,
      title: `title-${i}`,
      body: `body-${i} `.repeat(200),
    }));
    const bundle = buildDelegationContext({ recent_findings: findings, recall });
    expect(bundle.truncated).toBe(true);
    expect(JSON.stringify(bundle).length).toBeLessThanOrEqual(DELEGATION_CONTEXT_MAX_BYTES);
  });
});

describe("buildDelegationContext — include filter", () => {
  it("include: ['recall'] only → other slices absent", () => {
    const bundle = buildDelegationContext({
      include: ["recall"],
      recent_findings: [{ tool_name: "memory__search", text: "f1" }],
      recall: [{ note_id: "n1", title: "t1", body: "b1" }],
      thread_excerpt: [{ role: "user", text: "msg" }],
    });
    expect(bundle.recall?.length).toBe(1);
    expect(bundle.recent_findings).toBeUndefined();
    expect(bundle.thread_excerpt).toBeUndefined();
    expect(bundle.included).toEqual(["recall"]);
  });

  it("no include → all three slices included", () => {
    const bundle = buildDelegationContext({
      recent_findings: [{ tool_name: "memory__search", text: "f1" }],
      recall: [{ note_id: "n1", title: "t1", body: "b1" }],
      thread_excerpt: [{ role: "user", text: "msg" }],
    });
    expect(bundle.included.sort()).toEqual(
      ["recall", "recent_findings", "thread_excerpt"].sort(),
    );
  });

  it("empty inputs → still safe (no crash, mode=full, truncated=false)", () => {
    const bundle = buildDelegationContext({});
    expect(bundle.mode).toBe("full");
    expect(bundle.truncated).toBe(false);
  });
});

describe("buildDelegationContext — keep NEWEST entries on overflow", () => {
  it("9 findings (cap MAX_RECENT_FINDINGS=6) → newest 6 kept, oldest dropped, truncated true", () => {
    const findings = Array.from({ length: 9 }, (_, i) => ({
      tool_name: "memory__search",
      text: `finding-${i}`,
    }));
    const bundle = buildDelegationContext({ recent_findings: findings });
    expect(bundle.truncated).toBe(true);
    expect(bundle.recent_findings?.length).toBe(6);
    const blob = JSON.stringify(bundle);
    expect(blob).toContain("finding-8");
    expect(blob).not.toContain("finding-0");
  });
});
