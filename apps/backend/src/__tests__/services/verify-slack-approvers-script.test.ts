
import { describe, it, expect } from "vitest";
import {
  classifyRow,
  failReason,
  renderTable,
  summarize,
  UPCAR_ROSTER,
  type ApproverResult,
} from "../../../scripts/verify-slack-approvers";

const row = (
  name: string,
  active: boolean,
  slack: boolean,
  auth: boolean,
  note?: string,
): ApproverResult => ({
  name,
  checks: { activeTeamMember: active, slackIdentity: slack, tenantAuthMember: auth },
  note,
});

describe("classifyRow — PASS iff the full resolve_slack_approver chain holds", () => {
  it("all three links present → PASS", () => {
    expect(classifyRow(row("Jemis", true, true, true))).toBe("PASS");
  });

  it("missing active team_member → FAIL", () => {
    expect(classifyRow(row("Ghost", false, true, true))).toBe("FAIL");
  });
  it("missing slack identity → FAIL (a Slack click could never resolve them)", () => {
    expect(classifyRow(row("NoSlack", true, false, true))).toBe("FAIL");
  });
  it("missing tenant_users auth member → FAIL (the RPC step-b bridge fails)", () => {
    expect(classifyRow(row("NotAuthed", true, true, false))).toBe("FAIL");
  });
  it("only one link present → FAIL", () => {
    expect(classifyRow(row("OneOf3", true, false, false))).toBe("FAIL");
    expect(classifyRow(row("OneOf3", false, true, false))).toBe("FAIL");
    expect(classifyRow(row("OneOf3", false, false, true))).toBe("FAIL");
  });
  it("no links present → FAIL", () => {
    expect(classifyRow(row("Nobody", false, false, false))).toBe("FAIL");
  });
});

describe("failReason — names the FIRST broken link (short-circuit order)", () => {
  it("reports active-member gap first even if later links also missing", () => {
    expect(failReason(row("x", false, false, false))).toBe("no active team_member");
  });
  it("reports slack-identity gap when member exists but no slack id", () => {
    expect(failReason(row("x", true, false, false))).toBe("no slack identity");
  });
  it("reports auth-member gap when member + slack present but no auth bridge", () => {
    expect(failReason(row("x", true, true, false))).toBe("not a tenant_users auth member");
  });
  it("empty string for a passing row", () => {
    expect(failReason(row("x", true, true, true))).toBe("");
  });
});

describe("summarize — roster-level verdict", () => {
  it("allPass true only when every row passes", () => {
    const all = [row("a", true, true, true), row("b", true, true, true)];
    expect(summarize(all)).toEqual({ total: 2, passing: 2, failing: 0, allPass: true });
  });
  it("one failure flips allPass false and counts correctly", () => {
    const mixed = [row("a", true, true, true), row("b", true, false, true)];
    expect(summarize(mixed)).toEqual({ total: 2, passing: 1, failing: 1, allPass: false });
  });
  it("empty result set is NOT allPass (vacuous-true guard)", () => {
    expect(summarize([])).toEqual({ total: 0, passing: 0, failing: 0, allPass: false });
  });
});

describe("renderTable — deterministic monospace table", () => {
  const results = [
    row("Jemis", true, true, true),
    row("Mohit", true, true, false),
    row("Ghost", false, false, false),
  ];
  const out = renderTable(results);

  it("includes a header and separator row", () => {
    const lines = out.split("\n");
    expect(lines[0]).toContain("PERSON");
    expect(lines[0]).toContain("RESULT");
    expect(lines[1]).toMatch(/^-+\+/);
  });
  it("renders PASS/FAIL verdict per person", () => {
    expect(out).toContain("Jemis");
    const jemisLine = out.split("\n").find((l) => l.startsWith("Jemis"))!;
    expect(jemisLine).toContain("PASS");
    const mohitLine = out.split("\n").find((l) => l.startsWith("Mohit"))!;
    expect(mohitLine).toContain("FAIL");
    expect(mohitLine).toContain("not a tenant_users auth member");
  });
  it("FAIL row surfaces the first-broken-link reason", () => {
    const ghostLine = out.split("\n").find((l) => l.startsWith("Ghost"))!;
    expect(ghostLine).toContain("no active team_member");
  });
  it("one line per person plus header+separator", () => {
    expect(out.split("\n").length).toBe(results.length + 2);
  });
});

describe("roster constant", () => {
  it("contains the 8 named Upcar humans from the D0 task", () => {
    expect(UPCAR_ROSTER).toEqual([
      "Jemis",
      "Mohit",
      "Jignesh",
      "Jay",
      "Suresh",
      "Hemachandran",
      "Abhishek",
      "Ritesh",
    ]);
  });
});
