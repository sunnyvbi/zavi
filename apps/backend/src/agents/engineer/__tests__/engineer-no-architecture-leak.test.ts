
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_MD = readFileSync(join(__dirname, "..", "agent.md"), "utf-8");

describe("engineer agent — no-architecture-leak (qa-blind v2 T19, 2026-05-26)", () => {
  it("has the 'Internal machinery' section heading", () => {
    expect(AGENT_MD).toMatch(/^## Internal machinery — never explain how you work/m);
  });

  it("explicitly forbids pasting <plan> / <pr_proposal> envelopes", () => {
    expect(AGENT_MD).toMatch(/<pr_proposal>/);
    expect(AGENT_MD).toMatch(/<plan>/);
    expect(AGENT_MD).toMatch(/internal envelope tags/i);
  });

  it("forbids explaining Path A / Path B classification", () => {
    expect(AGENT_MD).toMatch(/Path A \/ Path B classification/);
  });

  it("provides the canonical one-sentence refusal text", () => {
    expect(AGENT_MD).toContain(
      "Those are internal — no effect on this conversation. What can I help with?",
    );
  });

  it("BAD example anchors on the verbatim T19 leak shape (Path A + literal plan JSON)", () => {
    expect(AGENT_MD).toMatch(/This is a Path A question — info ask/);
    expect(AGENT_MD).toMatch(/Wire SendGrid post-verification nudge/);
  });

  it("placement: section sits between '## Role' and '## Loop'", () => {
    const role = AGENT_MD.indexOf("## Role");
    const newSection = AGENT_MD.indexOf("## Internal machinery");
    const loop = AGENT_MD.indexOf("## Loop (Path B only)");
    expect(role).toBeGreaterThan(0);
    expect(newSection).toBeGreaterThan(role);
    expect(loop).toBeGreaterThan(newSection);
  });
});
