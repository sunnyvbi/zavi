import { describe, it, expect } from "vitest";
import {
  detectClarifyInPlannerText,
  hasSideEffectingToolUse,
  decideClarifyGate,
} from "../clarify-gate";

describe("detectClarifyInPlannerText", () => {
  it("populated clarifications_needed.questions[] → detected", () => {
    const text =
      '...<envelope>{"strategy":{"clarifications_needed":{"questions":["Which repo?","Which branch?"]}}}</envelope>...';
    expect(detectClarifyInPlannerText(text)).toBe(true);
  });

  it("populated clarifications_needed at top level → detected", () => {
    const text = '{"clarifications_needed":{"questions":["What deadline?"]}}';
    expect(detectClarifyInPlannerText(text)).toBe(true);
  });

  it("EMPTY clarifications_needed.questions[] → NOT detected (no question to ask)", () => {
    const text = '{"clarifications_needed":{"questions":[]}}';
    expect(detectClarifyInPlannerText(text)).toBe(false);
  });

  it("clarifications_needed === false (boolean) → NOT detected", () => {
    const text = '{"strategy":{"clarifications_needed":false}}';
    expect(detectClarifyInPlannerText(text)).toBe(false);
  });

  it("prose mentioning the words 'clarifications' / 'questions' without the JSON shape → NOT detected", () => {
    const text =
      "I have some clarifications about your questions. Let me look into the catalog first.";
    expect(detectClarifyInPlannerText(text)).toBe(false);
  });

  it("native P0a clarify envelope (envelope_kind: clarifying_questions) → detected", () => {
    const text =
      '<envelope>{"envelope_kind":"clarifying_questions","schema_version":1,"agent_slug":"pm","questions":[{"id":"q1","text":"Which goal?"}]}</envelope>';
    expect(detectClarifyInPlannerText(text)).toBe(true);
  });

  it("null / empty / non-string → false (no crash)", () => {
    expect(detectClarifyInPlannerText("")).toBe(false);
    expect(detectClarifyInPlannerText(null)).toBe(false);
    expect(detectClarifyInPlannerText(undefined)).toBe(false);
  });
});

describe("hasSideEffectingToolUse", () => {
  it("github__create_pr / github__open_pr → side-effecting", () => {
    expect(hasSideEffectingToolUse(["github__create_pr"])).toBe(true);
    expect(hasSideEffectingToolUse(["github__open_pr"])).toBe(true);
  });

  it("gmail__send / slack__post_message → side-effecting", () => {
    expect(hasSideEffectingToolUse(["gmail__send"])).toBe(true);
    expect(hasSideEffectingToolUse(["slack__post_message"])).toBe(true);
  });

  it("praxis__handoff / praxis__action → side-effecting (route writes)", () => {
    expect(hasSideEffectingToolUse(["praxis__handoff"])).toBe(true);
    expect(hasSideEffectingToolUse(["praxis__action"])).toBe(true);
  });

  it("pure reads (memory__search / web_fetch / operator_db__query) → NOT side-effecting", () => {
    expect(
      hasSideEffectingToolUse([
        "memory__search",
        "web_fetch__get",
        "operator_db__query_user",
        "github__list_prs",
      ]),
    ).toBe(false);
  });

  it("mixed with at least one side-effecting → true", () => {
    expect(
      hasSideEffectingToolUse(["memory__search", "github__create_pr", "web_fetch__get"]),
    ).toBe(true);
  });

  it("empty / nullish → false", () => {
    expect(hasSideEffectingToolUse([])).toBe(false);
    expect(hasSideEffectingToolUse([null, undefined, ""])).toBe(false);
  });
});

describe("decideClarifyGate (ordering: clarify-up-front)", () => {
  it("ORDER BUG (the case this slice fixes): clarify signal + side-effecting tool queued → short_circuit BEFORE side effect", () => {
    const planner_text =
      '<envelope>{"strategy":{"clarifications_needed":{"questions":["Which repo?"]}}}</envelope>';
    const decision = decideClarifyGate({
      planner_text,
      pending_tool_names: ["github__create_pr"],
    });
    expect(decision.short_circuit).toBe(true);
    if (decision.short_circuit) {
      expect(decision.reason).toBe("clarify_before_side_effect");
    }
  });

  it("clarify signal + only reads queued → DO NOT short-circuit (reads can inform)", () => {
    const planner_text = '{"clarifications_needed":{"questions":["What date?"]}}';
    const decision = decideClarifyGate({
      planner_text,
      pending_tool_names: ["memory__search", "operator_db__query_user"],
    });
    expect(decision.short_circuit).toBe(false);
  });

  it("clarify signal + no tools queued (about to terminate) → short_circuit (clean)", () => {
    const planner_text = '{"clarifications_needed":{"questions":["Which repo?"]}}';
    const decision = decideClarifyGate({ planner_text, pending_tool_names: [] });
    expect(decision.short_circuit).toBe(true);
    if (decision.short_circuit) {
      expect(decision.reason).toBe("clarify_before_chain");
    }
  });

  it("NO clarify signal → never short-circuits, regardless of tools", () => {
    const decision = decideClarifyGate({
      planner_text: "Just thinking out loud — I'll check the catalog.",
      pending_tool_names: ["github__create_pr", "slack__post_message"],
    });
    expect(decision.short_circuit).toBe(false);
  });

  it("empty clarifications array → no short-circuit (no question to ask)", () => {
    const decision = decideClarifyGate({
      planner_text: '{"clarifications_needed":{"questions":[]}}',
      pending_tool_names: ["github__create_pr"],
    });
    expect(decision.short_circuit).toBe(false);
  });
});
