import { describe, it, expect } from "vitest";
import { scrubAgentEgress, PII_SCRUB_AGENT_SLUGS } from "../scrub-agent-egress";

describe("scrubAgentEgress PII pass (scrubPii opt-in)", () => {
  it("scrubPii ON → redacts a raw email leaked from operator_db", () => {
    const r = scrubAgentEgress(
      "Top churn cohort includes jane.doe@example.com — file a retention fix.",
      { surface: "persist", scrubPii: true },
    );
    expect(r.text).not.toContain("jane.doe@example.com");
    expect(r.families).toContain("pii");
    expect(r.hits).toBeGreaterThan(0);
  });

  it("scrubPii ON → redacts SSN, card, and phone", () => {
    const r = scrubAgentEgress(
      "Flagged: SSN 123-45-6789, card 4111 1111 1111 1111, phone +1 (415) 555-0142.",
      { surface: "persist", scrubPii: true },
    );
    expect(r.text).not.toMatch(/123-45-6789/);
    expect(r.text).not.toMatch(/4111 1111 1111 1111/);
    expect(r.text).not.toMatch(/415\)?\s?555-0142/);
    expect(r.families).toContain("pii");
  });

  it("scrubPii OFF (default) → email is left intact (existing callers unchanged)", () => {
    const r = scrubAgentEgress("Contact jane.doe@example.com", { surface: "persist" });
    expect(r.text).toContain("jane.doe@example.com");
    expect(r.families).not.toContain("pii");
    expect(r.hits).toBe(0);
  });

  it("scrubPii ON → counts/segments survive (no false positive on aggregate language)", () => {
    const txt = "412 guests in the DTLA cohort dropped at checkout; 18% week-over-week.";
    const r = scrubAgentEgress(txt, { surface: "persist", scrubPii: true });
    expect(r.text).toBe(txt);
    expect(r.hits).toBe(0);
  });
});

describe("PII_SCRUB_AGENT_SLUGS membership policy", () => {
  it("includes every operator_db-reading triage/digest agent", () => {
    for (const slug of [
      "pm",
      "chief-of-staff",
      "support-lead",
      "dispute-response",
      "growth-lead",
      "performance-marketer",
    ]) {
      expect(PII_SCRUB_AGENT_SLUGS.has(slug)).toBe(true);
    }
  });

  it("EXCLUDES engineer + non-operator_db agents (scrubbing engineer would mangle the customer's own code/emails)", () => {
    for (const slug of [
      "engineer",
      "qa",
      "research",
      "content-seo",
      "browser-operator",
      "company-founder",
    ]) {
      expect(PII_SCRUB_AGENT_SLUGS.has(slug)).toBe(false);
    }
  });

  it("scrubPii ON → redacts an address written with character references", () => {
    for (const enc of [
      "ana&#64;example&#46;com",
      "ana&commat;example&period;com",
      "ana&#x40;example.com",
      "ana&nbsp;[at]&nbsp;example&nbsp;[dot]&nbsp;com",
      "ana&#91;at&#93;example&#91;dot&#93;com",
      "ana (search rate-limited)&#64;example.com",
      "ana&ensp;[at]&ensp;example&ensp;[dot]&ensp;com",
      "ana&hyphen;b&commat;example&period;com",
      "ana&#8203;&#64;example.com",
      "ana&thinsp;[at]&emsp;example&ThinSpace;[dot]&hairsp;com",
    ]) {
      const r = scrubAgentEgress(`Host owed: ${enc}`, { surface: "persist", scrubPii: true });
      expect(r.text).not.toMatch(/ana/);
      expect(r.families).toContain("pii");
    }
  });

  it("scrubPii ON → leaves R&D and escaped markup exactly as written", () => {
    for (const t of ["R&D spend rose 12%.", "Use &lt;b&gt; for bold &amp; &quot;quotes&quot;.", "&#45;&#45;&#45; divider", "Pra&#120;is note"]) {
      expect(scrubAgentEgress(t, { surface: "persist", scrubPii: true }).text).toBe(t);
    }
  });

  it("scrubPii ON → redacts an SSN written with encoded unusual dashes", () => {
    const r = scrubAgentEgress("SSN: 123&#xFE63;45&#xFF0D;6789", { surface: "persist", scrubPii: true });
    expect(r.text).not.toMatch(/6789/);
  });
});
