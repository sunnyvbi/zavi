import { describe, it, expect } from "vitest";
import { stripLegacyCriticNotes } from "../legacy-critic-notes";
import { appendTestingSection } from "../ship-gate";

const BASE = "## Problem\nOwner emails leaked the room id.\n\n## Fix\nTreat inquiry like general.";

describe("stripLegacyCriticNotes", () => {
  it("removes the critic block and its findings, keeping the other notes", () => {
    const body = appendTestingSection(BASE, [
      "Tests: no test run completed in the sandbox — please run the suite before merge.",
      "Code review flagged a blocking issue — review before merge:\n  - [P1] a.ts, fn: wrong\n  - [P2] b.ts: also wrong",
      "Committed dist: source changed in `apps/backend` but its committed `dist/` was NOT regenerated in this diff.",
    ]);
    const out = stripLegacyCriticNotes(body);
    expect(out).not.toContain("Code review flagged");
    expect(out).not.toContain("[P1] a.ts");
    expect(out).not.toContain("[P2] b.ts");
    expect(out).toContain("- Tests: no test run completed");
    expect(out).toContain("- Committed dist:");
    expect(out).toContain("## Testing & verification");
    expect(out.startsWith(BASE)).toBe(true);
  });

  it("removes a finding whose text held line breaks", () => {
    const body = appendTestingSection(BASE, [
      "Code review flagged a blocking issue — review before merge:\n  - [P1] a.ts: first line\nsecond line of the same finding\nthird line",
      "Tests: the sandbox could not run the test suite — nothing was verified. Review before merge.",
    ]);
    const out = stripLegacyCriticNotes(body);
    expect(out).not.toContain("second line of the same finding");
    expect(out).not.toContain("third line");
    expect(out).toContain("- Tests: the sandbox could not run");
  });

  it("removes a finding whose text held '- ' and '## ' lines", () => {
    const body = appendTestingSection(BASE, [
      "Code review flagged a blocking issue — review before merge:\n  - [P1] a.ts: the fix\n- drops the guard\n- Impact: unauthorized access is possible.\n## and this looks like a heading",
      "Committed dist: source changed in `apps/backend` but its committed `dist/` was NOT regenerated in this diff.",
    ]);
    const out = stripLegacyCriticNotes(body);
    expect(out).not.toContain("drops the guard");
    expect(out).not.toContain("Impact: unauthorized");
    expect(out).not.toContain("looks like a heading");
    expect(out).toContain("- Committed dist:");
  });

  it("cleans a body with CRLF line endings and keeps them", () => {
    const body = appendTestingSection(BASE, [
      "Tests: no test run completed in the sandbox — please run the suite before merge.",
      "Adversarial code review could not run this time — please review the diff.",
    ]).replace(/\n/g, "\r\n");
    const out = stripLegacyCriticNotes(body);
    expect(out).not.toContain("Adversarial code review");
    expect(out).toContain("- Tests: no test run completed");
    expect(out.includes("\r\n")).toBe(true);
    expect(out.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("drops the whole section when the critic notes were the only notes", () => {
    const body = appendTestingSection(BASE, [
      "Adversarial code review could not run this time — please review the diff.",
      "The change may not fully match the request — please confirm it does what you asked.",
    ]);
    expect(stripLegacyCriticNotes(body)).toBe(BASE);
  });

  it("leaves a body with no critic notes byte-identical", () => {
    const body = appendTestingSection(BASE, ["Tests: the sandbox could not run the test suite — nothing was verified. Review before merge."]);
    expect(stripLegacyCriticNotes(body)).toBe(body);
    expect(stripLegacyCriticNotes(BASE)).toBe(BASE);
  });

  it("never touches matching words outside the generated section", () => {
    const prose =
      "## Notes\n- Code review flagged a blocking issue in the old flow; this PR fixes it.\n  - [P1] kept as context\n\n```\n- The change may not fully match the request\n```";
    expect(stripLegacyCriticNotes(prose)).toBe(prose);
    const withSection =
      prose + "\n\n" + appendTestingSection("", ["Adversarial code review could not run this time — please review the diff."]);
    expect(stripLegacyCriticNotes(withSection)).toBe(prose);
  });

  it("cleans only the generated section when the model wrote its own section with the same heading", () => {
    const modelSection = "## Testing & verification\nRan the suite locally.\n- Code review flagged a blocking issue earlier, now fixed";
    const body =
      modelSection +
      "\n\n" +
      appendTestingSection("", [
        "Code review flagged a blocking issue — review before merge:\n  - [P1] x.ts: y",
        "Tests: no test run completed in the sandbox — please run the suite before merge.",
      ]);
    const out = stripLegacyCriticNotes(body);
    expect(out.startsWith(modelSection)).toBe(true);
    expect(out).not.toContain("[P1] x.ts");
    expect(out).toContain("- Tests: no test run completed");
  });
});
