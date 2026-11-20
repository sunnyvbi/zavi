import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const agentMd = readFileSync(join(__dirname, "..", "agent.md"), "utf8");

describe("qa agent.md spec invariants", () => {
  it("Mode A keeps the empty-brain bail instruction (no fabricated cases)", () => {
    expect(agentMd).toMatch(/empty\s*\/\s*insufficient context/i);
    expect(agentMd).toMatch(/Insufficient brain context — no test cases drafted/);
    expect(agentMd).toMatch(/DO NOT call `qa_engineer__add_test_case`/);
  });

  it("hard rule forbids inventing operator data", () => {
    expect(agentMd).toMatch(/NEVER\*?\*?\s*invent operator data/i);
  });

  it("Mode A caps the catalog at 25 (no unbounded seeding)", () => {
    expect(agentMd).toMatch(/15-25/);
    expect(agentMd).toMatch(/never exceed 25/i);
  });

  it("Mode C confirm spec defines all three terminal categories", () => {
    expect(agentMd).toContain("qa-chat-add-inserted");
    expect(agentMd).toContain("qa-chat-add-skipped");
    expect(agentMd).toContain("qa-chat-add-clarify");
  });

  it("Mode C draft turn requires the sibling <drafts> block with full nl_spec", () => {
    expect(agentMd).toContain("<drafts>");
    expect(agentMd).toMatch(/full `nl_spec`/);
  });

  it("digest count must be built last from the actual added count", () => {
    expect(agentMd).toMatch(/Build the digest LAST/);
  });

  it("frontmatter grants the count + list read tools (senior upgrade)", () => {
    expect(agentMd).toContain("qa_engineer__count_test_cases");
    expect(agentMd).toContain("qa_engineer__list_active_tests");
  });

  it("hard rule requires the count tool before any count/seeded claim", () => {
    expect(agentMd).toMatch(
      /without calling\s+`qa_engineer__count_test_cases`\s+THIS run/i,
    );
  });

  it("Mode A forbids the model typing the seeded count", () => {
    expect(agentMd).toMatch(/you do NOT type the seeded case count/i);
  });

  it("citation rule forbids unverified component/ticket/threshold", () => {
    expect(agentMd).toContain("PhoneVerificationGate");
    expect(agentMd).toContain("SCRUM-4854");
  });

  it("test-design discipline section is present (risk-first + negative cases)", () => {
    expect(agentMd).toMatch(/Rank by blast radius/);
    expect(agentMd).toMatch(/negative\/boundary case/);
  });

  it("requires a coverage-gap line derived from count_test_cases (P1-5 hygiene)", () => {
    expect(agentMd).toMatch(/coverage-gap line/i);
    expect(agentMd).toMatch(/by_role/);
    expect(agentMd).toMatch(/by_status/);
    expect(agentMd).toMatch(/0 host-side cases/i);
  });

  it("has NO dead /catalog CTA — the real surface is the Test catalog panel", () => {
    expect(agentMd).not.toContain("/catalog");
    expect(agentMd).toMatch(/Test catalog/);
  });

  it("Mode B is documented as SHIPPED (no stale Sub-plan 4 / browser-tool stub)", () => {
    expect(agentMd).not.toMatch(/Sub-plan 4 will wire Mode B/);
    expect(agentMd).not.toMatch(/re-add `browser_\*` tools/);
    expect(agentMd).toMatch(/Mode B is NOW SHIPPED/i);
  });
});
