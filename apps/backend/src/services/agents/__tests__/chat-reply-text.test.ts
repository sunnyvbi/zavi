import { describe, it, expect } from "vitest";
import {
  selectChatReplyText,
  selectTerminalChatEmit,
  CHAT_EMPTY_FALLBACK,
  type ChatReplyResultLike,
} from "../chat-reply-text";

function base(over: Partial<ChatReplyResultLike> = {}): ChatReplyResultLike {
  return {
    output_text: "hello world",
    parsed: null,
    parse_ok: true,
    ...over,
  };
}

describe("selectChatReplyText — branch coverage", () => {
  it("plain prose, parse_ok, no envelope → output_text verbatim, non-empty", () => {
    const r = selectChatReplyText({
      result: base({ output_text: "Stripe isn't connected, so I can't pull MRR." }),
      agentSlug: "operator",
    });
    expect(r.text).toBe("Stripe isn't connected, so I can't pull MRR.");
    expect(r.emptyFallbackUsed).toBe(false);
    expect(r.meta.empty).toBeUndefined();
  });

  it("EMPTY output → C12 fallback, emptyFallbackUsed, meta.empty (the silent-no-bubble fix)", () => {
    const r = selectChatReplyText({
      result: base({ output_text: "   " }),
      agentSlug: "support-lead",
    });
    expect(r.text).toBe(CHAT_EMPTY_FALLBACK);
    expect(r.emptyFallbackUsed).toBe(true);
    expect(r.meta.empty).toBe(true);
  });

  it("valid envelope + coercion_notes → meta.coercion_notes, NO customer-facing footer (no internal-field leak)", () => {
    const r = selectChatReplyText({
      result: base({
        output_text: "Here's the digest.",
        parsed: { rendered_markdown: "Here's the digest." },
        parse_ok: true,
        coercion_notes: ["dissent.why auto-shortened to 400 chars"],
      }),
      agentSlug: "chief-of-staff",
      envelopeName: "digest",
    });
    expect(r.text).toContain("Here's the digest.");
    expect(r.text).not.toContain("auto-shortened");
    expect(r.text).not.toContain("field limit");
    expect(r.meta.coercion_notes).toEqual([
      "dissent.why auto-shortened to 400 chars",
    ]);
  });

  it("valid envelope + salvaged parse_error → meta.parse_salvaged + path", () => {
    const r = selectChatReplyText({
      result: base({
        output_text: "recovered body",
        parsed: { rendered_markdown: "recovered body" },
        parse_ok: true,
        parse_error: "salvaged:repaired:bad control char",
      }),
      agentSlug: "pm",
      envelopeName: "product_pm_backlog",
    });
    expect(r.meta.parse_salvaged).toBe(true);
    expect(r.meta.parse_salvage_path).toBe("repaired");
  });

  it("schema_soft_failed → prose + neutral validation note + meta flags (no raw zod leak)", () => {
    const r = selectChatReplyText({
      result: base({
        output_text: "",
        parsed: { rendered_markdown: "The plan summary prose." },
        parse_ok: false,
        schema_soft_failed: true,
        parse_error: "schema_soft_fail: head_branch: invalid enum",
        raw_response_text: "<pr_proposal>{...}</pr_proposal>",
      }),
      agentSlug: "engineer",
      envelopeName: "pr_proposal",
    });
    expect(r.text).toBe("The plan summary prose.");
    expect(r.text).not.toContain("⚠");
    expect(r.text).not.toContain("schema_soft_fail");
    expect(r.text).not.toContain("head_branch: invalid enum");
    expect(r.meta.schema_soft_failed).toBe(true);
    expect(r.meta.parse_error).toBe("schema_soft_fail: head_branch: invalid enum");
    expect(r.meta.raw_output_preview).toBe("<pr_proposal>{...}</pr_proposal>");
  });

  it("schema_soft_failed advisor regression — no Zod field path / constraint text leaks (GAP E)", () => {
    const r = selectChatReplyText({
      result: base({
        output_text: "ship it",
        parsed: { rendered_markdown: "ship it" },
        parse_ok: false,
        schema_soft_failed: true,
        parse_error:
          "schema_soft_fail: recommendations.decide_today.0.rationale: String must contain at most 600 character(s)",
        raw_response_text: "<advice>...</advice>",
      }),
      agentSlug: "advisor",
      envelopeName: "advice",
    });
    expect(r.text).not.toContain("schema_soft_fail");
    expect(r.text).not.toContain("recommendations.decide_today");
    expect(r.text).not.toContain("String must contain at most");
    expect(r.text).toContain("ship it");
    expect(r.meta.parse_error).toContain("schema_soft_fail");
    expect(r.meta.parse_error).toContain("recommendations.decide_today");
  });

  it("schema_soft_failed empty prose → neutral fallback prose + warning footer (no Runs-tab name)", () => {
    const r = selectChatReplyText({
      result: base({
        output_text: "",
        parsed: { rendered_markdown: "" },
        parse_ok: false,
        schema_soft_failed: true,
        parse_error: "schema_soft_fail: x: required",
      }),
      agentSlug: "advisor",
      envelopeName: "advice",
    });
    expect(r.text).toContain("produced a response but one field didn't validate");
    expect(r.text).not.toContain("⚠");
    expect(r.text).not.toContain("Runs tab");
    expect(r.text).not.toContain("schema_soft_fail");
  });

  it("Case B — prose >50 chars, no envelope tag attempted → render prose, meta.envelope_omitted", () => {
    const prose =
      "The project is on track. Three things are in flight and none are blocked right now.";
    const r = selectChatReplyText({
      result: base({
        output_text: prose,
        parse_ok: false,
        parse_error: "no <product_pm_backlog>...</product_pm_backlog> block found",
      }),
      agentSlug: "pm",
      envelopeName: "product_pm_backlog",
    });
    expect(r.text).toBe(prose);
    expect(r.meta.envelope_omitted).toBe(true);
    expect(r.meta.envelope_omitted_reason).toContain("no <product_pm_backlog>");
  });

  it("Case A truncated (envelope tag present, stop_reason max_tokens) → truncation recovery msg", () => {
    const r = selectChatReplyText({
      result: base({
        output_text: "<digest>{ broken json ...",
        parse_ok: false,
        parse_error: "schema_or_json_fail",
        stop_reason: "max_tokens",
      }),
      agentSlug: "chief-of-staff",
      envelopeName: "digest",
    });
    expect(r.text).toContain("ran long and got cut off");
    expect(r.text).not.toContain("<digest>");
    expect(r.text).not.toContain("Runs");
    expect(r.meta.parse_failed).toBe(true);
  });

  it("Case A non-truncated (envelope tag present, end_turn) → validation recovery msg", () => {
    const r = selectChatReplyText({
      result: base({
        output_text: "<digest>{ complete but invalid }",
        parse_ok: false,
        parse_error: "schema_or_json_fail",
        stop_reason: "end_turn",
      }),
      agentSlug: "chief-of-staff",
      envelopeName: "digest",
    });
    expect(r.text).toContain("couldn't finish that one cleanly");
    expect(r.text).not.toContain("ran long and got cut off");
    expect(r.text).not.toContain("<digest>");
    expect(r.text).not.toContain("schema/JSON");
    expect(r.text).not.toContain("Runs");
    expect(r.meta.parse_failed).toBe(true);
  });

  it("plan-strip — operator leading <plan> block is stripped from the bubble", () => {
    const withPlan =
      "<plan>\n{ \"classify\": { \"tier\": \"tier1\" } }\n</plan>\nThe real answer to your question.";
    const r = selectChatReplyText({
      result: base({ output_text: withPlan }),
      agentSlug: "operator",
    });
    expect(r.text).not.toContain("<plan>");
    expect(r.text).toContain("The real answer to your question.");
  });

  it("plan-strip is a no-op for non-PLAN_EMIT slugs (literal <plan> survives)", () => {
    const txt = "Here is a <plan> example in prose for a digest agent.";
    const r = selectChatReplyText({
      result: base({ output_text: txt }),
      agentSlug: "support-lead",
    });
    expect(r.text).toBe(txt);
  });

  it("operator emits ONLY a leading <plan> block → strip empties it → C12 fallback (today's bug, now floored)", () => {
    const r = selectChatReplyText({
      result: base({
        output_text: "<plan>\n{ \"classify\": { \"tier\": \"tier1\" } }\n</plan>",
      }),
      agentSlug: "operator",
    });
    expect(r.text).toBe(CHAT_EMPTY_FALLBACK);
    expect(r.emptyFallbackUsed).toBe(true);
  });

  it("drafts-strip — qa <drafts> JSON block is stripped from the bubble, prose preserved", () => {
    const withDrafts =
      "I drafted 2 test cases for checkout:\n\n1. Guest checkout works\n2. Coupon applies\n\n" +
      'Reply with "add all" or "skip" to confirm.\n\n' +
      '<drafts>\n[{"index":1,"title":"Guest checkout works","role":"guest","nl_spec":{"steps":["Open checkout"],"expected_outcome":"Order placed"}}]\n</drafts>';
    const r = selectChatReplyText({
      result: base({
        output_text: withDrafts,
        parsed: { rendered_markdown: withDrafts },
        parse_ok: true,
      }),
      agentSlug: "qa",
      envelopeName: "digest",
    });
    expect(r.text).not.toContain("<drafts>");
    expect(r.text).not.toContain('"nl_spec"');
    expect(r.text).toContain("I drafted 2 test cases for checkout:");
    expect(r.text).toContain('Reply with "add all" or "skip" to confirm.');
  });

  it("drafts-strip is a no-op for non-qa slugs (literal <drafts> survives)", () => {
    const txt = "Here is a <drafts> example in prose for another agent.</drafts>";
    const r = selectChatReplyText({
      result: base({ output_text: txt }),
      agentSlug: "support-lead",
    });
    expect(r.text).toBe(txt);
  });

  it("qa emits ONLY a <drafts> block → strip empties it → C12 fallback (never a raw-JSON-only bubble)", () => {
    const r = selectChatReplyText({
      result: base({
        output_text: '<drafts>\n[{"index":1,"title":"Case","role":"guest","nl_spec":{"steps":["x"],"expected_outcome":"y"}}]\n</drafts>',
      }),
      agentSlug: "qa",
    });
    expect(r.text).toBe(CHAT_EMPTY_FALLBACK);
    expect(r.emptyFallbackUsed).toBe(true);
  });
});

describe("selectTerminalChatEmit — realtime emit decision (Slice 1 increment 2)", () => {
  it("chat + real text → emits; body matches the canonical selector (history parity)", () => {
    const result = base({ output_text: "Real readable answer." });
    const emit = selectTerminalChatEmit({ result, agentSlug: "operator", trigger: "chat" });
    const sel = selectChatReplyText({ result, agentSlug: "operator" });
    expect(emit.bodyText).toBe(sel.text);
    expect(emit.bodyText).toBe("Real readable answer.");
    expect(emit.empty).toBe(false);
    expect(emit.shouldEmit).toBe(true);
  });

  it("chat + empty output → ALWAYS emits the floor (user must see something)", () => {
    const emit = selectTerminalChatEmit({
      result: base({ output_text: "" }),
      agentSlug: "support-lead",
      trigger: "chat",
    });
    expect(emit.bodyText).toBe(CHAT_EMPTY_FALLBACK);
    expect(emit.empty).toBe(true);
    expect(emit.shouldEmit).toBe(true);
  });

  it("non-chat (cron) + real text → emits real content", () => {
    const emit = selectTerminalChatEmit({
      result: base({ output_text: "Daily digest body." }),
      agentSlug: "chief-of-staff",
      trigger: "cron",
    });
    expect(emit.shouldEmit).toBe(true);
    expect(emit.bodyText).toBe("Daily digest body.");
  });

  it("non-chat (cron) + empty output → SUPPRESSED (no tenant-wide 'no response' broadcast)", () => {
    const emit = selectTerminalChatEmit({
      result: base({ output_text: "" }),
      agentSlug: "chief-of-staff",
      trigger: "cron",
    });
    expect(emit.empty).toBe(true);
    expect(emit.shouldEmit).toBe(false);
  });

  it("parity: envelope agent whose parsed lacks rendered_markdown but output_text has rendered text → realtime no longer falsely empty (the divergence this fixes)", () => {
    const result = base({
      output_text: "• point one\n• point two",
      parsed: { summary: { bullets: ["point one", "point two"] } },
      parse_ok: true,
    });
    const emit = selectTerminalChatEmit({ result, agentSlug: "chief-of-staff", envelopeName: "digest", trigger: "chat" });
    expect(emit.empty).toBe(false);
    expect(emit.bodyText).toContain("point one");
  });
});
