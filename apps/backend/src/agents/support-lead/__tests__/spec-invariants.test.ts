import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const agentMd = readFileSync(join(__dirname, "..", "agent.md"), "utf8");

function frontmatterEndLine(src: string): number {
  const lines = src.split("\n");
  let dashCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      dashCount++;
      if (dashCount === 2) return i;
    }
  }
  return -1;
}

function findLine(src: string, regex: RegExp): number {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) return i;
  }
  return -1;
}

describe("support-lead agent.md spec invariants", () => {
  it("(1A) inherits anti-hallucination-gates", () => {
    expect(agentMd).toMatch(/inherits:[\s\S]*-\s*anti-hallucination-gates/);
  });

  it("(Block B) OUTPUT CONTRACT heading is present within 60 lines after frontmatter", () => {
    const fmEnd = frontmatterEndLine(agentMd);
    expect(fmEnd).toBeGreaterThan(0);
    const contractLine = findLine(agentMd, /^## OUTPUT CONTRACT/i);
    expect(contractLine).toBeGreaterThan(fmEnd);
    expect(contractLine - fmEnd).toBeLessThan(60);
  });

  it("(Block B) the contract body names the card fields", () => {
    expect(agentMd).toMatch(/`cards\[\]`/);
    expect(agentMd).toContain("`signal_ref`");
    expect(agentMd).toContain("`specialist_slug`");
    expect(agentMd).toContain("`confidence`");
  });

  it("(1C) severity rubric is present (Impact × Urgency, not message-tone)", () => {
    expect(agentMd).toMatch(/P0 — blocks revenue/);
    expect(agentMd).toMatch(/Impact × Urgency/);
    expect(agentMd).toMatch(/NOT message-tone/i);
  });

  it("(1C) confidence gate forbids auto_resolve below 0.6", () => {
    expect(agentMd).toMatch(/confidence[\s\S]{0,40}below[\s\S]{0,20}0\.6[\s\S]{0,80}NOT[\s\S]{0,40}auto_resolve/i);
  });

  it("(1D) route_specialist (functional) and escalate_founder (authority) rules present", () => {
    expect(agentMd).toMatch(/`route_specialist` \(functional\)/);
    expect(agentMd).toMatch(/`escalate_founder` \(hierarchical\)/);
    expect(agentMd).toMatch(/refund, a ban\/freeze/);
    expect(agentMd).toMatch(/you do NOT call the specialist yourself/i);
  });

  it("(1E) support-specific recall checklist present", () => {
    expect(agentMd).toMatch(/serial-disputer/);
    expect(agentMd).toMatch(/3 disputes in 90d/);
    expect(agentMd).toMatch(/`memory__search` FIRST/);
  });

  it("(guardrail regression) read-only hard rules survive", () => {
    expect(agentMd).toMatch(/Never\*?\*?\s*propose refunds, bans/);
    expect(agentMd).toMatch(/Never\*?\*?\s*auto-respond/);
  });

  it("(redaction) no-PII/secret-verbatim rule covers ALL outputs, not just digest cards", () => {
    expect(agentMd).toMatch(/No PII or secret verbatim — in ANY output/);
    expect(agentMd).toMatch(/no prefix or any other\s+substring of the live value/);
    expect(agentMd).toMatch(/final 4\s+characters/);
    expect(agentMd).toMatch(/\[email redacted\]/);
    expect(agentMd).toMatch(/do NOT default to last-4 for PII/);
  });

  it("(time-window) clock-verification rule before asserting window status", () => {
    expect(agentMd).toMatch(/Verify the clock before asserting time-window status/);
    expect(agentMd).toMatch(/hours-until-event/);
    expect(agentMd).toMatch(/Relative words alone/);
  });

  it("(email front-door) declares the READ-ONLY email tools", () => {
    expect(agentMd).toMatch(/^\s*-\s*email__list_inbox\s*$/m);
    expect(agentMd).toMatch(/^\s*-\s*email__get_thread\s*$/m);
  });

  it("(email front-door) does NOT grant a write/send email tool (read-only stays intact)", () => {
    expect(agentMd).not.toMatch(/^\s*-\s*email__send\s*$/m);
  });

  it("(email front-door) the Email-turns section keeps the no-auto-send / approval gate", () => {
    expect(agentMd).toMatch(/## Email turns/);
    expect(agentMd).toMatch(/UNTRUSTED data/);
    expect(agentMd).toMatch(/never auto-respond|approval-gated|DEFERS the auto-send/);
    expect(agentMd).toMatch(/email__get_thread/);
  });
});
