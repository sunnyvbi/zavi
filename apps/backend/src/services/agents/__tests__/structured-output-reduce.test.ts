import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { blob: {} }, error: null }),
        }),
      }),
    }),
  }),
}));

import { reduceStructuredOutput } from "../structured-output";
import { stripNullsDeep } from "../engine/strict-schema";
import { outputSchemas } from "@/agents/index";

function reduce(slug: string, structuredOutput: unknown) {
  return reduceStructuredOutput({
    slug,
    structuredOutput,
    serverSchema: outputSchemas[slug],
    rawTextFallback: "RAW_FALLBACK",
  });
}

describe("reduceStructuredOutput — FAIL-CLOSED emit + authoritative safeParse (money path)", () => {
  it("pm: valid decision → parsed=decision, parse_ok true, rendered_markdown is output", () => {
    const r = reduce("pm", {
      rendered_markdown: "PM summary",
      decision: {
        status: "no_signal",
        status_reason: "nothing actionable",
      },
    });
    expect(r.parseOk).toBe(true);
    expect(r.outputText).toBe("PM summary");
    expect((r.parsed as { status?: string }).status).toBe("no_signal");
    expect(r.parsed).not.toHaveProperty("decision");
  });

  it("pm: actionable build spec survives the structured-output empty strategy placeholder", () => {
    const r = reduce("pm", {
      rendered_markdown: "## Sole Rentals\n\nA shoe rental marketplace.",
      decision: {
        status: "actionable",
        strategy: {
          premise_check: "",
          reframe_options: [],
          research_findings: [],
          clarifications_needed: false,
        },
        summary: {
          bullets: ["Build the rental flow"],
          top_theme: "Shoe rentals",
        },
        backlog: [
          {
            item_id: "rental-flow",
            theme: "Rental flow",
            theme_normalized: "rental-flow",
            problem: "Customers need to reserve shoes for a date range.",
            proposed_fix:
              "Build browsing, availability, and reservation screens.",
            target: "frontend",
            code_reach: 0,
            code_confidence: 0,
            impact: "high",
            effort: "medium",
            rice_score: 0,
            reasoning: "This is the core customer journey.",
            evidence_sources: [],
          },
        ],
        dispatched_actions: [],
        recommended_actions_not_dispatched: [],
        sources_all: [],
        snapshot_run_id: "pending",
      },
    });

    expect(r.parseOk).toBe(true);
    expect(r.schemaSoftFailed).toBe(false);
    expect(r.parsed).not.toHaveProperty("strategy");
    expect(r.outputText).toContain("Sole Rentals");
  });

  it("pm: MISSING decision → parsed=null (NO emit) + action_missing LOUD", () => {
    const r = reduce("pm", { rendered_markdown: "I had nothing to dispatch." });
    expect(r.parsed).toBeNull();
    expect(r.parseOk).toBe(true);
    expect(r.actionMissing).toBe(true);
    expect(r.noActionReason).toBe("no_decision_emitted");
    expect(r.outputText).toBe("I had nothing to dispatch.");
  });

  it("pm: empty {} decision → parsed=null (degrade-to-no-action), action_missing", () => {
    const r = reduce("pm", { rendered_markdown: "x", decision: {} });
    expect(r.parsed).toBeNull();
    expect(r.actionMissing).toBe(true);
  });

  it("pm: decision that FAILS a server superRefine → schema_soft_fail, parse_ok FALSE (blocks emit)", () => {
    const r = reduce("pm", {
      rendered_markdown: "x",
      decision: { status: "actionable", backlog: [] },
    });
    expect(r.parseOk).toBe(false);
    expect(r.schemaSoftFailed).toBe(true);
    expect(r.parseError).toMatch(/schema_soft_fail/);
  });

  it("advisor: a dispatch_proposal to a NON-allowlisted agent → schema_soft_fail (refine enforced)", () => {
    const r = reduce("advisor", {
      rendered_markdown: "advice",
      decision: {
        diagnosis: { stage: "growth", goal_restated: "grow", key_signals: [] },
        clarifications_needed: false,
        dispatch_proposals: [
          { agent_slug: "engineer", brief: "ship a thing", why: "because" },
        ],
      },
    });
    expect(r.parseOk).toBe(false);
    expect(r.schemaSoftFailed).toBe(true);
  });

  it("engineer: valid model-output decision → parse_ok true, parsed has repo/title", () => {
    const r = reduce("engineer", {
      rendered_markdown: "Plan summary.",
      decision: {
        repo: "rravi149/praxis",
        base_branch: "main",
        head_branch: "engineer/fix-x",
        title: "Fix x",
        test_results: { passed: 1, failed: 0, output_tail: "" },
      },
    });
    expect(r.parseOk).toBe(true);
    expect((r.parsed as { repo?: string }).repo).toBe("rravi149/praxis");
  });

  it("engineer: an over-cap DISPLAY field (rendered_markdown 4,500 > 4,000) is coerced, not a soft-fail", () => {
    const long = "x".repeat(4500);
    const r = reduce("engineer", {
      rendered_markdown: "Plan summary.",
      decision: {
        repo: "rravi149/praxis",
        base_branch: "main",
        head_branch: "engineer/fix-x",
        title: "Fix x",
        rendered_markdown: long,
        test_results: { passed: 1, failed: 0, output_tail: "" },
      },
    });
    expect(r.parseOk).toBe(true);
    expect(r.schemaSoftFailed).toBe(false);
    expect(
      ((r.parsed as { rendered_markdown?: string }).rendered_markdown ?? "")
        .length,
    ).toBeLessThanOrEqual(4000);
  });

  it("engineer: a handler-driving field is NOT coerced and still soft-fails loudly", () => {
    const r = reduce("engineer", {
      rendered_markdown: "Plan summary.",
      decision: {
        repo: "rravi149/praxis",
        base_branch: "main",
        head_branch: "engineer/fix-x",
        title: "Fix x",
        risk_class: "not-a-real-class",
        test_results: { passed: 1, failed: 0, output_tail: "" },
      },
    });
    expect(r.parseOk).toBe(false);
    expect(r.schemaSoftFailed).toBe(true);
  });

  it("engineer: a no_change decision parses as a refusal answer, not a soft-fail", () => {
    const r = reduce("engineer", {
      rendered_markdown: "Checked every table: all have RLS enabled.",
      decision: {
        reason_code: "no_change",
        customer_summary: "Row-level security is already on for every table, so there is nothing to fix.",
      },
    });
    expect(r.parseOk).toBe(true);
    expect(r.schemaSoftFailed).toBe(false);
    expect(r.parseError).toBeUndefined();
    expect(r.outputText).toBe("Checked every table: all have RLS enabled.");
    expect(r.parsed).toEqual({
      rendered_markdown: "Checked every table: all have RLS enabled.",
      refused: true,
      parse_fallback_kind: "model_refusal",
      reason_code: "no_change",
      customer_summary: "Row-level security is already on for every table, so there is nothing to fix.",
    });
  });

  it("engineer: a decision missing repo/base_branch/title WITHOUT reason_code still soft-fails (run 8c28ce8a shape)", () => {
    const r = reduce("engineer", {
      rendered_markdown: "Nothing to change.",
      decision: { customer_summary: "Nothing to change." },
    });
    expect(r.parseOk).toBe(false);
    expect(r.schemaSoftFailed).toBe(true);
    expect(r.parseError).toMatch(/^schema_soft_fail\(structured\): /);
    expect(r.parseError).toMatch(/repo: /);
    expect(r.parseError).toMatch(/base_branch: /);
    expect(r.parseError).toMatch(/title: /);
  });

  it("engineer: no_change with an empty summary still soft-fails", () => {
    const r = reduce("engineer", {
      rendered_markdown: "x",
      decision: { reason_code: "no_change", customer_summary: "" },
    });
    expect(r.parseOk).toBe(false);
    expect(r.schemaSoftFailed).toBe(true);
  });

  it("engineer: no decision → action_missing (LOUD no-op on an action-intent agent)", () => {
    const r = reduce("engineer", {
      rendered_markdown: "Looked, nothing to ship.",
    });
    expect(r.parsed).toBeNull();
    expect(r.actionMissing).toBe(true);
  });

  it("qa (digest_only): parsed ALWAYS null, parse_ok on rendered_markdown presence", () => {
    const r = reduce("qa", {
      rendered_markdown: "QA digest",
      tier1: [],
      tier2: [],
      tier3: [],
      tier4: [],
    });
    expect(r.parseOk).toBe(true);
    expect(r.outputText).toBe("QA digest");
    expect(r.parsed).toBeNull();
    expect(r.schemaSoftFailed).toBe(false);
  });

  it("qa: rendered_markdown-only → parse_ok true, parsed null (no schema run against wrapper)", () => {
    const r = reduce("qa", { rendered_markdown: "just prose" });
    expect(r.parseOk).toBe(true);
    expect(r.parsed).toBeNull();
    expect(r.schemaSoftFailed).toBe(false);
    expect(r.outputText).toBe("just prose");
  });

  it("content-design (markdown_derived side-channel): parsed carries recommendations, parse_ok true", () => {
    const recs = [{ change_type: "new_page", slug: "x", title: "T" }];
    const r = reduce("content-design", {
      rendered_markdown: "here is this week's pick",
      recommendations: recs,
    });
    expect(r.parseOk).toBe(true);
    expect(r.parsed).not.toBeNull();
    expect((r.parsed as { recommendations?: unknown }).recommendations).toEqual(
      recs,
    );
  });

  it("content-design: rendered_markdown only (no recommendations) → parsed non-null, recommendations undefined", () => {
    const r = reduce("content-design", {
      rendered_markdown: "nothing to publish this week",
    });
    expect(r.parseOk).toBe(true);
    expect(
      (r.parsed as { recommendations?: unknown }).recommendations,
    ).toBeUndefined();
  });

  it("growth-lead (markdown_derived side-channel): parsed carries machine_digest, parse_ok true", () => {
    const r = reduce("growth-lead", {
      rendered_markdown: "this week's growth answer",
      machine_digest: "## Tier 1\nBet: do X",
    });
    expect(r.parseOk).toBe(true);
    expect(r.parsed).not.toBeNull();
    expect((r.parsed as { machine_digest?: unknown }).machine_digest).toBe(
      "## Tier 1\nBet: do X",
    );
  });

  it("non-allowlisted markdown_derived (performance-marketer): parsed STAYS null (fail-closed default intact)", () => {
    const r = reduce("performance-marketer", {
      rendered_markdown: "ads digest",
    });
    expect(r.parseOk).toBe(true);
    expect(r.parsed).toBeNull();
  });

  it("dispute-response: prose draft, NO evidence_packet → parsed=null (NO emit), action_missing LOUD", () => {
    const r = reduce("dispute-response", {
      rendered_markdown: "draft evidence, operator pastes manually",
    });
    expect(r.parseOk).toBe(true);
    expect(r.parsed).toBeNull();
    expect(r.actionMissing).toBe(true);
    expect(r.outputText).toBe("draft evidence, operator pastes manually");
  });

  it("dispute-response: empty rendered_markdown + no packet → parsed null (still NO emit)", () => {
    const r = reduce("dispute-response", { rendered_markdown: "" });
    expect(r.parsed).toBeNull();
    expect(r.actionMissing).toBe(true);
  });

  it("dispute-response: blank rendered_markdown but VALID packet → schema_soft_fail, parse_ok FALSE (blocks emit)", () => {
    const r = reduce("dispute-response", {
      rendered_markdown: "",
      decision: {
        evidence_packet: {
          dispute_id: "dp_x",
          evidence_fields: { uncategorized_text: "the rebuttal argument" },
          recommendation: "fight",
          win_band: "High",
        },
      },
    });
    expect(r.parseOk).toBe(false);
    expect(r.schemaSoftFailed).toBe(true);
  });

  it("dispute-response: good draft + valid packet → EMITS (parse_ok true, parsed carries packet)", () => {
    const r = reduce("dispute-response", {
      rendered_markdown: "## Dispute rebuttal\n\nWe are fighting dp_x.",
      decision: {
        evidence_packet: {
          dispute_id: "dp_x",
          evidence_fields: { uncategorized_text: "the rebuttal argument" },
          recommendation: "fight",
          win_band: "High",
        },
      },
    });
    expect(r.parseOk).toBe(true);
    expect(r.parsed).not.toBeNull();
    expect(r.parsed).not.toHaveProperty("decision");
    expect(
      (r.parsed as { evidence_packet?: { dispute_id?: string } })
        .evidence_packet?.dispute_id,
    ).toBe("dp_x");
  });

  it("research (discriminated-union schema): parse_ok true on rendered_markdown, parsed null, NO soft-fail", () => {
    const r = reduce("research", {
      rendered_markdown: "# Research report\n\nfindings...",
    });
    expect(r.parseOk).toBe(true);
    expect(r.parsed).toBeNull();
    expect(r.schemaSoftFailed).toBe(false);
    expect(r.outputText).toMatch(/Research report/);
  });

  it("top_level_decision (pm): unwraps the decision + full-zod-validates, parsed=decision", () => {
    const r = reduce("pm", {
      rendered_markdown: "summary",
      decision: { status: "no_signal" },
    });
    expect(r.parseOk).toBe(true);
    expect(r.parsed).not.toBeNull();
    expect((r.parsed as { status?: string }).status).toBe("no_signal");
    expect(r.parsed).not.toHaveProperty("decision");
  });

  it("falls back to rawTextFallback when the wrapper lacks rendered_markdown", () => {
    const r = reduce("pm", { decision: { status: "no_signal" } });
    expect(r.outputText).toBe("RAW_FALLBACK");
  });
});

describe("OpenAI null-strip chokepoint (provider-gated stripNullsDeep before authoritative safeParse)", () => {
  function buildSdkStructuredOutput(
    finalAssistantText: string,
    provider: "openai" | "anthropic",
  ): unknown {
    const parsed: unknown = JSON.parse(finalAssistantText.trim());
    if (parsed === null || typeof parsed !== "object") return parsed;
    return provider === "openai" ? stripNullsDeep(parsed) : parsed;
  }

  const openAiWrapperJson = JSON.stringify({
    rendered_markdown: "PM summary: no actionable signal this cycle.",
    decision: {
      status: "no_signal",
      status_reason: "nothing actionable",
      strategy: null,
      snapshot_run_id: null,
      artifact_label: null,
    },
  });

  it("(a) provider=openai: nulls are stripped → outputSchemas['pm'].safeParse SUCCEEDS → parse_ok, parsed=decision", () => {
    const sdkStructuredOutput = buildSdkStructuredOutput(
      openAiWrapperJson,
      "openai",
    );
    const r = reduceStructuredOutput({
      slug: "pm",
      structuredOutput: sdkStructuredOutput,
      serverSchema: outputSchemas["pm"],
      rawTextFallback: "RAW_FALLBACK",
    });
    expect(r.parseOk).toBe(true);
    expect(r.schemaSoftFailed).toBe(false);
    expect(r.parsed).not.toBeNull();
    expect((r.parsed as { status?: string }).status).toBe("no_signal");
    expect(r.parsed).not.toHaveProperty("strategy");
    expect(r.parsed).not.toHaveProperty("snapshot_run_id");
    expect(r.parsed).not.toHaveProperty("artifact_label");
    expect(r.parsed).not.toHaveProperty("decision");
    expect(r.outputText).toBe("PM summary: no actionable signal this cycle.");
  });

  it("(a') direct proof: outputSchemas['pm'].safeParse SUCCEEDS on stripNullsDeep(decision) but FAILS on the raw null-bearing decision", () => {
    const rawDecision = {
      status: "no_signal",
      status_reason: "nothing actionable",
      strategy: null,
      snapshot_run_id: null,
      artifact_label: null,
    };
    const rawResult = outputSchemas["pm"].safeParse(rawDecision);
    expect(rawResult.success).toBe(false);
    const strippedResult = outputSchemas["pm"].safeParse(
      stripNullsDeep(rawDecision),
    );
    expect(strippedResult.success).toBe(true);
  });

  it("(b) provider=anthropic: behavior UNCHANGED (no strip) → the null-bearing decision schema_soft_fails (proves the gate)", () => {
    const sdkStructuredOutput = buildSdkStructuredOutput(
      openAiWrapperJson,
      "anthropic",
    );
    const r = reduceStructuredOutput({
      slug: "pm",
      structuredOutput: sdkStructuredOutput,
      serverSchema: outputSchemas["pm"],
      rawTextFallback: "RAW_FALLBACK",
    });
    expect(r.parseOk).toBe(false);
    expect(r.schemaSoftFailed).toBe(true);
    expect(r.parseError).toMatch(/schema_soft_fail/);
  });

  it("(b') control: anthropic path with NO null-valued optionals parses identically with or without a strip (strip is a no-op on absent optionals)", () => {
    const cleanWrapper = {
      rendered_markdown: "summary",
      decision: { status: "no_signal", status_reason: "ok" },
    };
    const anthropic = reduceStructuredOutput({
      slug: "pm",
      structuredOutput: cleanWrapper,
      serverSchema: outputSchemas["pm"],
      rawTextFallback: "RAW_FALLBACK",
    });
    const openaiOnSameClean = reduceStructuredOutput({
      slug: "pm",
      structuredOutput: stripNullsDeep(cleanWrapper),
      serverSchema: outputSchemas["pm"],
      rawTextFallback: "RAW_FALLBACK",
    });
    expect(anthropic.parseOk).toBe(true);
    expect(openaiOnSameClean.parseOk).toBe(true);
    expect(anthropic.parsed).toEqual(openaiOnSameClean.parsed);
  });

  it("(c) FAIL-SAFE: non-parseable JSON leaves sdkStructuredOutput logic to degrade (parse throws, caught by caller)", () => {
    expect(() =>
      buildSdkStructuredOutput("not json at all", "openai"),
    ).toThrow();
  });
});
