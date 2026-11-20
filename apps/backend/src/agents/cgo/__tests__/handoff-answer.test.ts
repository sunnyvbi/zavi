import { describe, it, expect } from "vitest";
import { CGO_NO_USABLE_ANSWER, cgoHandoffReplyBody, isCgoHandoffAnswer } from "../handoff-answer";
import { composeHandoffBody } from "@/services/agents/handoff-result";

describe("isCgoHandoffAnswer", () => {
  it("is cgo on a handoff trigger, not a strategy job or a goal review", () => {
    expect(isCgoHandoffAnswer("cgo", "handoff", { operator_thread_id: "t" })).toBe(true);
    expect(isCgoHandoffAnswer("cgo", "handoff", { stage: "draft_strategy" })).toBe(false);
    expect(isCgoHandoffAnswer("cgo", "handoff", { stage: "own_goals" })).toBe(false);
    expect(isCgoHandoffAnswer("cgo", "chat", {})).toBe(false);
    expect(isCgoHandoffAnswer("meta_ads", "handoff", {})).toBe(false);
  });

  it("is also cgo as a surface handoff child (Slack, email, Teams, WhatsApp, ...)", () => {
    expect(isCgoHandoffAnswer("cgo", "slack", { slack_handoff_child: true })).toBe(true);
    expect(isCgoHandoffAnswer("cgo", "email", { handoff_child: true })).toBe(true);
    expect(isCgoHandoffAnswer("cgo", "teams", { handoff_child: true })).toBe(true);
    expect(isCgoHandoffAnswer("cgo", "whatsapp", { whatsapp_handoff_child: true })).toBe(true);
    expect(isCgoHandoffAnswer("cgo", "slack", { slack_handoff_child: true, stage: "draft_strategy" })).toBe(false);
    expect(isCgoHandoffAnswer("cgo", "email", { handoff_child: true, stage: "own_goals" })).toBe(false);
    expect(isCgoHandoffAnswer("cgo", "slack", { slack: { channel: "C1" } })).toBe(false);
    expect(isCgoHandoffAnswer("cgo", "email", {})).toBe(false);
    expect(isCgoHandoffAnswer("pm", "slack", { slack_handoff_child: true })).toBe(false);
  });
});

describe("cgoHandoffReplyBody", () => {
  it("drops only the paragraphs that carry internal vocabulary", () => {
    const text = "Your binding constraint is traffic.\n\nI checked mcp__growth__read_ads_perf first.\n\nStart with SEO.";
    expect(cgoHandoffReplyBody(text)).toBe("Your binding constraint is traffic.\n\nStart with SEO.");
    expect(cgoHandoffReplyBody("See the sandbox log.")).toBeNull();
    expect(cgoHandoffReplyBody("   ")).toBeNull();
  });
});

describe("composeHandoffBody for a cgo answer", () => {
  const base = {
    tenant_id: "t1",
    run_id: "r1",
    operator_thread_id: "th1",
    from_agent_slug: "cgo",
    payload: { operator_thread_id: "th1" },
  };

  it("posts the answer itself, never a bare status line", () => {
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: "Traffic is what holds you back.\n\nSpend the next $500 on search.",
      outcome: { side_effect: { kind: "refused" } } as never,
    });
    expect(body).toBe("Traffic is what holds you back.\n\nSpend the next $500 on search.");
    expect(body).not.toMatch(/^Done\.|No changes were made|didn't finish/);
  });

  it("a Slack or email handoff child's reply is the prose answer too", () => {
    for (const payload of [{ slack_handoff_child: true }, { handoff_child: true, source: "email" }]) {
      const body = composeHandoffBody({
        ...base,
        payload,
        status: "success",
        output_text: "Traffic is what holds you back.",
        outcome: { side_effect: { kind: "refused" } } as never,
      });
      expect(body).toBe("Traffic is what holds you back.");
    }
  });

  it("a parse_failed or failed run never posts its text as the answer", () => {
    const fragment = "Traffic is what holds you back, so I would";
    const parseFailed = composeHandoffBody({
      ...base,
      status: "failed",
      parse_failed: true,
      output_text: fragment,
      outcome: { deliverable: fragment } as never,
    });
    expect(parseFailed).not.toContain(fragment);
    expect(parseFailed).not.toBe(CGO_NO_USABLE_ANSWER);
    expect(parseFailed).toMatch(/didn't finish|couldn't/i);
    const failed = composeHandoffBody({ ...base, status: "failed", output_text: fragment, error: "boom" });
    expect(failed).not.toContain(fragment);
    expect(failed).not.toBe(CGO_NO_USABLE_ANSWER);
    const failedWithOutcome = composeHandoffBody({
      ...base,
      status: "failed",
      output_text: fragment,
      outcome: { deliverable: fragment, customer_summary: fragment, failure: { class: "none" } } as never,
    });
    expect(failedWithOutcome).not.toContain(fragment);
  });

  it("MCP and scheduled handoff children (conversation_answer) are answers, not strategy jobs", () => {
    expect(isCgoHandoffAnswer("cgo", "mcp", { source: "mcp", conversation_answer: true })).toBe(true);
    expect(isCgoHandoffAnswer("cgo", "a2a", { conversation_answer: true })).toBe(true);
    expect(isCgoHandoffAnswer("cgo", "a2a", { conversation_answer: true, stage: "own_goals" })).toBe(false);
    expect(isCgoHandoffAnswer("cgo", "mcp", { source: "mcp" })).toBe(false);
  });

  it("any other specialist's clean answer is the body too, with no status line", () => {
    const body = composeHandoffBody({ ...base, from_agent_slug: "pm", status: "success", output_text: "Here is the spec." });
    expect(body).toBe("Here is the spec.");
  });

  it("posts an honest line, not a bare status, when nothing clean is left", () => {
    const body = composeHandoffBody({ ...base, status: "success", output_text: "Check the sandbox envelope." });
    expect(body).toBe(CGO_NO_USABLE_ANSWER);
  });
});
