
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_MD = readFileSync(join(__dirname, "..", "agent.md"), "utf-8");

describe("chief-of-staff agent — no-architecture-leak (qa-blind v2 T18, 2026-05-26)", () => {
  it("has the 'Internal machinery' section heading", () => {
    expect(AGENT_MD).toMatch(/^## Internal machinery — never explain how you work/m);
  });

  it("explicitly forbids exposing the 4-tier envelope structure / field names", () => {
    expect(AGENT_MD).toMatch(/4-tier digest envelope shape/);
    expect(AGENT_MD).toMatch(/rendered_markdown/);
    expect(AGENT_MD).toMatch(/suggested_dispatch/);
    expect(AGENT_MD).toMatch(/target_agent_slug/);
  });

  it("forbids enumerating internal status enums (parse_failed / dispatch_error)", () => {
    expect(AGENT_MD).toMatch(/parse_failed/);
    expect(AGENT_MD).toMatch(/dispatch_error/);
    expect(AGENT_MD).toMatch(/humanized prompt-projected versions/);
  });

  it("forbids enumerating specialist slugs", () => {
    expect(AGENT_MD).toMatch(/specialist slug enumeration/i);
  });

  it("provides the canonical one-sentence refusal text", () => {
    expect(AGENT_MD).toContain(
      "Those are internal — no effect on this conversation. What can I help with?",
    );
  });

  it("BAD example anchors on the verbatim T18 leak shape (4-tier envelope architecture lecture)", () => {
    expect(AGENT_MD).toMatch(
      /I produce a structured JSON envelope with four tiers/,
    );
    expect(AGENT_MD).toMatch(
      /The `rendered_markdown` field in that envelope is what you read in the UI/,
    );
  });
});
