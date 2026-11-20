import { describe, it, expect } from "vitest";
import { scrubAgentEgress } from "../scrub-agent-egress";

const opts = { surface: "chat" as const };

describe("egress marker leak — the redaction placeholder must not reach the customer", () => {
  it("performance-marketer run 31796f8b: drops the attribution parenthetical, keeps the scoreboard", () => {
    const raw =
      "**Scoreboard (from `mcp__server__meta_ads__list_campaigns` this run):** New Conversions budget up 12% week over week.";
    const r = scrubAgentEgress(raw, opts);

    expect(r.text).not.toContain("meta_ads__list_campaigns");
    expect(r.hits).toBeGreaterThan(0);
    expect(r.text).not.toContain("a tool");
    expect(r.text).toBe(
      "**Scoreboard:** New Conversions budget up 12% week over week.",
    );
  });

  it("operator run c3444022: drops the trailing '(via <tool>(DEL-735) + <tool> ...)' citation", () => {
    const raw =
      "Here's the full breakdown of DEL-735 and what to test. (via `jira__get_issue(DEL-735)` + `github__list_pull_requests` on both PRs)";
    const r = scrubAgentEgress(raw, opts);

    expect(r.text).not.toContain("jira__get_issue");
    expect(r.text).not.toContain("github__list_pull_requests");
    expect(r.hits).toBeGreaterThan(0);
    expect(r.text).not.toContain("a tool");
    expect(r.text).toBe(
      "Here's the full breakdown of DEL-735 and what to test.",
    );
  });

  it("a marker left inside backticks loses them (stops reading as a real identifier)", () => {
    const r = scrubAgentEgress("I checked `slack__post_message` for you.", opts);
    expect(r.text).not.toContain("slack__post_message");
    expect(r.text).not.toContain("`a tool`");
  });

  it("PRESERVE — a parenthetical carrying real content is NOT eaten", () => {
    const r = scrubAgentEgress(
      "Spend is up (revenue up 12%, per meta_ads__get_insights).",
      opts,
    );
    expect(r.text).not.toContain("meta_ads__get_insights");
    expect(r.text).toContain("revenue up 12%");
  });

  it("PRESERVE — an attribution citation carrying real figures keeps the figures", () => {
    const r = scrubAgentEgress(
      "Budget pacing (from meta_ads__get_insights: 47 conversions, CPA $18.40) is healthy.",
      opts,
    );
    expect(r.text).not.toContain("meta_ads__get_insights");
    expect(r.text).toContain("47 conversions");
    expect(r.text).toContain("CPA $18.40");
  });

  it("PRESERVE — an attribution citation carrying a date range keeps the range", () => {
    const r = scrubAgentEgress(
      "Spend is up 12% (based on meta_ads__get_insights, which covers Jan 1 - Mar 30).",
      opts,
    );
    expect(r.text).not.toContain("meta_ads__get_insights");
    expect(r.text).toContain("Jan 1 - Mar 30");
  });

  it("PRESERVE — 'a toolkit' is not the marker, so its parenthetical survives", () => {
    const r = scrubAgentEgress(
      "I pulled the numbers (from a toolkit estimate: 47 conversions) for you via slack__post_message.",
      opts,
    );
    expect(r.text).not.toContain("slack__post_message");
    expect(r.text).toContain("47 conversions");
    expect(r.text).toContain("a toolkit estimate");
  });

  it("PRESERVE — customer prose with no redaction is byte-for-byte unchanged", () => {
    const clean =
      "Scoreboard (from your Meta Ads account this run): conversions up 12%.";
    const r = scrubAgentEgress(clean, opts);
    expect(r.hits).toBe(0);
    expect(r.text).toBe(clean);
  });
});
