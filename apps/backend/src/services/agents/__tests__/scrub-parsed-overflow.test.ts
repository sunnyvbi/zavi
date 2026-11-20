import { describe, it, expect } from "vitest";
import { scrubParsedOverflow, PII_SCRUB_AGENT_SLUGS } from "../scrub-agent-egress";

const PII_OPTS = {
  surface: "slack" as const,
  agentSlug: "support-lead",
  scrubPii: true,
};

describe("scrubParsedOverflow — collapsed-reply overflow body", () => {
  it("REGRESSION: redacts PII in the overflow body that Slack posts verbatim", () => {
    const parsed = {
      metadata: {
        report_lead_collapsed: true,
        full_reply_markdown:
          "Guest jane.doe@example.com paid with card 4111 1111 1111 1111, phone +1 (415) 555-0142.",
      },
    };

    const out = scrubParsedOverflow(parsed, PII_OPTS) as typeof parsed;
    const full = out.metadata.full_reply_markdown;

    expect(full).not.toContain("jane.doe@example.com");
    expect(full).not.toContain("4111 1111 1111 1111");
    expect(full).not.toMatch(/415\)?\s?555-0142/);
  });

  it("preserves the sibling metadata the slack worker gates on", () => {
    const parsed = {
      metadata: {
        report_lead_collapsed: true,
        full_reply_markdown: "Reach me at jane.doe@example.com.",
        some_other_key: "kept",
      },
      top_level: "kept",
    };

    const out = scrubParsedOverflow(parsed, PII_OPTS) as typeof parsed;

    expect(out.metadata.report_lead_collapsed).toBe(true);
    expect(out.metadata.some_other_key).toBe("kept");
    expect(out.top_level).toBe("kept");
    expect(out.metadata.full_reply_markdown).not.toContain("jane.doe@example.com");
  });

  it("scrubPii OFF (non-PII agent) → body is not PII-redacted, matching output_text", () => {
    expect(PII_SCRUB_AGENT_SLUGS.has("engineer")).toBe(false);

    const parsed = {
      metadata: { full_reply_markdown: "Contact jane.doe@example.com about the deploy." },
    };
    const out = scrubParsedOverflow(parsed, {
      surface: "slack",
      agentSlug: "engineer",
      scrubPii: false,
    }) as typeof parsed;

    expect(out.metadata.full_reply_markdown).toContain("jane.doe@example.com");
  });

  it("no overflow present → returns the value untouched (non-collapsed runs unchanged)", () => {
    const noMeta = { foo: "bar" };
    expect(scrubParsedOverflow(noMeta, PII_OPTS)).toBe(noMeta);

    const emptyOverflow = { metadata: { full_reply_markdown: "" } };
    expect(scrubParsedOverflow(emptyOverflow, PII_OPTS)).toBe(emptyOverflow);

    const noOverflow = { metadata: { report_lead_collapsed: false } };
    expect(scrubParsedOverflow(noOverflow, PII_OPTS)).toBe(noOverflow);
  });

  it("null / non-object parsed → total, never throws", () => {
    expect(scrubParsedOverflow(null, PII_OPTS)).toBeNull();
    expect(scrubParsedOverflow(undefined, PII_OPTS)).toBeUndefined();
    expect(scrubParsedOverflow("a string", PII_OPTS)).toBe("a string");
    const arr = [1, 2];
    expect(scrubParsedOverflow(arr, PII_OPTS)).toBe(arr);
  });

  it("support-lead is on the PII scrub list — the agent the brevity plan would have added", () => {
    expect(PII_SCRUB_AGENT_SLUGS.has("support-lead")).toBe(true);
  });
});
