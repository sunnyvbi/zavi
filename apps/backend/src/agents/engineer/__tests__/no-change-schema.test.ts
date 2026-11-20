import { describe, it, expect } from "vitest";
import { prProposalModelOutputSchema, prProposalSchema } from "../output-schema";
import { evaluateCtoShipGate, isNoDiffReason } from "../ship-gate";
import {
  normalizeNoChangeDecision,
  readCustomerFacingFields,
} from "@/services/agents/model-refusal-envelope";
import { suppressAnsweredNoAction } from "@/agents/lib/suppress-policy";

const fullProposal = {
  repo: "rravi149/praxis",
  base_branch: "main",
  head_branch: "engineer/fix-x",
  title: "Fix x",
  body: "body",
  rendered_markdown: "## Plan",
  risk_class: "low",
  test_results: { passed: 1, failed: 0, output_tail: "" },
};

const noChange = {
  reason_code: "no_change",
  customer_summary: "Row-level security is already on for every table, so there is nothing to fix.",
  rendered_markdown: "Checked every table: all have RLS enabled.",
};

describe("engineer model-output schema: no_change answer", () => {
  it("a complete PR proposal still parses exactly as before", () => {
    const r = prProposalModelOutputSchema.safeParse(fullProposal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.repo).toBe("rravi149/praxis");
      expect(r.data.reason_code).toBeUndefined();
    }
  });

  it("a proposal missing repo/base_branch/title without reason_code still fails (the 8c28ce8a error)", () => {
    const r = prProposalModelOutputSchema.safeParse({
      customer_summary: "Nothing to change.",
      rendered_markdown: "x",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths).toEqual(expect.arrayContaining(["repo", "base_branch", "title"]));
    }
  });

  it("a proposal missing only title still fails", () => {
    const { title: _t, ...noTitle } = fullProposal;
    const r = prProposalModelOutputSchema.safeParse(noTitle);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join("."))).toEqual(["title"]);
  });

  it("field checks still apply to a proposal (bad repo shape fails)", () => {
    expect(prProposalModelOutputSchema.safeParse({ ...fullProposal, repo: "not a repo" }).success).toBe(false);
  });

  it("reason_code no_change + customer_summary parses with no PR fields", () => {
    const r = prProposalModelOutputSchema.safeParse(noChange);
    expect(r.success).toBe(true);
  });

  it("reason_code no_change with an empty or blank summary fails", () => {
    expect(prProposalModelOutputSchema.safeParse({ reason_code: "no_change" }).success).toBe(false);
    const r = prProposalModelOutputSchema.safeParse({ reason_code: "no_change", customer_summary: "   " });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(["customer_summary"]);
  });

  it("an unknown reason_code is rejected", () => {
    expect(
      prProposalModelOutputSchema.safeParse({ reason_code: "wrong_repo", customer_summary: "x" }).success,
    ).toBe(false);
  });

  it("the dispatch schema still requires a full proposal (a no_change body can never open a PR)", () => {
    expect(prProposalSchema.safeParse(noChange).success).toBe(false);
  });
});

describe("no_change flows through the refusal plumbing", () => {
  it("normalizes into the refusal shape, dropping stray proposal fields", () => {
    const parsed = prProposalModelOutputSchema.parse({ ...noChange, repo: "rravi149/praxis", title: "t" });
    const n = normalizeNoChangeDecision(parsed) as Record<string, unknown>;
    expect(n).toEqual({
      rendered_markdown: noChange.rendered_markdown,
      refused: true,
      parse_fallback_kind: "model_refusal",
      reason_code: "no_change",
      customer_summary: noChange.customer_summary,
    });
    expect(n).not.toHaveProperty("repo");
    expect(n).not.toHaveProperty("title");
  });

  it("falls back to the summary as the prose when rendered_markdown is absent", () => {
    const n = normalizeNoChangeDecision({ reason_code: "no_change", customer_summary: "Already done." }) as Record<
      string,
      unknown
    >;
    expect(n.rendered_markdown).toBe("Already done.");
  });

  it("leaves a real proposal and a declared refusal untouched", () => {
    const parsed = prProposalModelOutputSchema.parse(fullProposal);
    expect(normalizeNoChangeDecision(parsed)).toBe(parsed);
    const refused = { refused: true, reason_code: "no_change", customer_summary: "x" };
    expect(normalizeNoChangeDecision(refused)).toBe(refused);
    expect(normalizeNoChangeDecision(null)).toBeNull();
  });

  it("ship-gate blocks it as a no-diff refusal, and the suppress persists as an answer", () => {
    const n = normalizeNoChangeDecision(prProposalModelOutputSchema.parse(noChange));
    const gate = evaluateCtoShipGate(n);
    expect(gate.shippable).toBe(false);
    if (!gate.shippable) {
      expect(gate.reason).toBe("refused_envelope");
      expect(isNoDiffReason(gate.reason)).toBe(true);
      expect(suppressAnsweredNoAction(gate.reason, noChange.rendered_markdown)).toBe(true);
    }
    expect(readCustomerFacingFields(n)).toEqual({
      customer_summary: noChange.customer_summary,
      reason_code: "no_change",
    });
  });
});

describe("direct web chat stamps the no_change outcome (review F1)", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "..", "index.ts"),
    "utf8",
  ) as string;
  const fn = src.slice(src.indexOf("const ctoEngineerChatPostProcess"));
  const suppress = fn.slice(fn.indexOf('if (outcome.kind === "suppress")'));
  it("a refused_envelope suppress copies the customer summary and stamps a refused side effect", () => {
    expect(suppress).toMatch(/outcome\.reason === "refused_envelope"/);
    expect(suppress).toMatch(/readCustomerFacingFields\(result\.parsed\)/);
    expect(suppress).toMatch(/result\.side_effect = \{\s*kind: "refused"/);
  });
});
