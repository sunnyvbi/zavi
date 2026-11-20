
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  registerRuntimeEvalMocks,
  driveGolden,
  type Golden,
} from "./harness";

registerRuntimeEvalMocks();

let runGeneric: typeof import("../../generic-dispatcher").runGeneric;
beforeAll(async () => {
  ({ runGeneric } = await import("../../generic-dispatcher"));
}, 120_000);
beforeEach(() => {
  process.env.PRAXIS_FORCE_SDK_DISPATCH = "0";
});

const PAYLOAD = { task_description: "Do the thing for the test tenant." };

describe("runtime-eval — golden trajectories (model stubbed, zero spend)", () => {
  it("G01 no-envelope agent → prose passes through as output_text, parse_ok", async () => {
    const golden: Golden = {
      name: "no-envelope-prose",
      agentSlug: "rt-plain",
      metadata: {},
      modelTurns: [{ text: "Here is the answer to your question.", stopReason: "end_turn" }],
    };
    const { result, modelCalls } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(true);
    expect(result.output_text).toBe("Here is the answer to your question.");
    expect(result.envelope_rescue_kind).toBeNull();
    expect(modelCalls).toBe(1);
  });

  it("G02 valid envelope (unregistered slug) → parse_ok, rendered_markdown surfaces", async () => {
    const inner = { rendered_markdown: "## Result\n\nAll good.", items: [1, 2] };
    const golden: Golden = {
      name: "valid-envelope-no-schema",
      agentSlug: "rt-envelope",
      metadata: { output_envelope: "rt_env" },
      modelTurns: [
        { text: `Reasoning here.\n<rt_env>${JSON.stringify(inner)}</rt_env>`, stopReason: "end_turn" },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(true);
    expect(result.output_text).toBe("## Result\n\nAll good.");
    expect(result.parsed).toMatchObject({ items: [1, 2] });
  });

  it("G03 strict envelope agent emits prose without tags → parse_failed", async () => {
    const golden: Golden = {
      name: "missing-envelope-strict",
      agentSlug: "rt-strict",
      metadata: { output_envelope: "rt_env", prose_fallback: false },
      modelTurns: [
        { text: "I forgot to wrap this in the envelope tags.", stopReason: "end_turn" },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(false);
    expect(result.parse_error).toMatch(/no <rt_env>/);
  });

  it("G04 missing envelope + prose_fallback ON → rescued (parse_ok, refused:true)", async () => {
    const golden: Golden = {
      name: "missing-envelope-prose-fallback",
      agentSlug: "rt-prose-fb",
      metadata: { output_envelope: "rt_env", prose_fallback: true },
      modelTurns: [
        { text: "A coherent prose answer the user should still see.", stopReason: "end_turn" },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(true);
    expect(result.output_text).toBe("A coherent prose answer the user should still see.");
    expect(result.parsed).toMatchObject({
      refused: true,
      parse_fallback_kind: "no_envelope_block_prose_fallback",
    });
  });

  it("G05 digest envelope, prose without tags → digest_fallback (parse_ok)", async () => {
    const golden: Golden = {
      name: "digest-prose-fallback",
      agentSlug: "rt-digest",
      metadata: { output_envelope: "digest" },
      modelTurns: [
        { text: "Daily brief: nothing on fire today.", stopReason: "end_turn" },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(true);
    expect(result.parsed).toMatchObject({
      rendered_markdown: "Daily brief: nothing on fire today.",
    });
  });

  it("G06 chief-of-staff valid digest → schema passes, parse_ok", async () => {
    const digest = {
      tier1: [],
      tier2: [{ area: "supply", summary: "stable" }],
      tier3: [],
      tier4: [],
      rendered_markdown: "## Daily digest\n\nSupply stable.",
    };
    const golden: Golden = {
      name: "cos-valid-digest",
      agentSlug: "chief-of-staff",
      metadata: { output_envelope: "digest" },
      modelTurns: [
        { text: `<digest>${JSON.stringify(digest)}</digest>`, stopReason: "end_turn" },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(true);
    expect(result.schema_soft_failed).toBeFalsy();
    expect(result.output_text).toBe("## Daily digest\n\nSupply stable.");
    expect(result.parsed).toMatchObject({ tier2: [{ area: "supply" }] });
  });

  it("G07 digest schema soft-fail → parse_ok false, schema_soft_failed, prose kept", async () => {
    const bad = {
      tier2: [],
      tier3: [],
      tier4: [],
      rendered_markdown: "## Digest\n\nPartial but useful.",
    };
    const golden: Golden = {
      name: "cos-schema-soft-fail",
      agentSlug: "chief-of-staff",
      metadata: { output_envelope: "digest" },
      modelTurns: [
        { text: `<digest>${JSON.stringify(bad)}</digest>`, stopReason: "end_turn" },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(false);
    expect(result.schema_soft_failed).toBe(true);
    expect(result.output_text).toBe("## Digest\n\nPartial but useful.");
    expect(result.parse_error).toMatch(/schema_soft_fail/);
  });

  it("G08 meta-placeholder rendered_markdown → rescued from preceding prose", async () => {
    const inner = { rendered_markdown: "Asking 3 clarifying questions. No backlog items emitted." };
    const precedingProse =
      "Here is the real substantive analysis the operator needs to see, which is well over fifty characters long.";
    const golden: Golden = {
      name: "meta-placeholder-preceding-prose",
      agentSlug: "rt-meta",
      metadata: { output_envelope: "rt_env" },
      modelTurns: [
        {
          text: `${precedingProse}\n<rt_env>${JSON.stringify(inner)}</rt_env>`,
          stopReason: "end_turn",
        },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(true);
    expect(result.envelope_rescue_kind).toBe("preceding_prose");
    expect(result.output_text).toBe(precedingProse);
  });

  it("G09 pm meta-placeholder + structured questions → structured_questions rescue + clarify_envelope", async () => {
    const inner = {
      rendered_markdown: "Asking 2 clarifying questions. No backlog items emitted.",
      strategy: {
        reframe_options: [],
        clarifications_needed: {
          questions: ["What is the target launch date?", "Which market first?"],
        },
      },
    };
    const golden: Golden = {
      name: "pm-structured-questions",
      agentSlug: "pm",
      metadata: { output_envelope: "product_pm_backlog" },
      modelTurns: [
        { text: `<product_pm_backlog>${JSON.stringify(inner)}</product_pm_backlog>`, stopReason: "end_turn" },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.envelope_rescue_kind).toBe("structured_questions");
    expect(result.clarify_envelope).toBeTruthy();
    expect(result.clarify_envelope?.questions.length).toBe(2);
    expect(result.clarify_envelope?.questions[0]?.text).toMatch(/launch date/);
  });

  it("G10 native clarify envelope → clarify_envelope built, structured_questions", async () => {
    const clarify = {
      envelope_kind: "clarifying_questions",
      agent_slug: "rt-clarify",
      intro: "I need a couple details first.",
      questions: [
        {
          id: "q1",
          text: "Which channel should I post to?",
          header: "Channel",
          type: "single",
          options: [
            { id: "slack", label: "Slack" },
            { id: "email", label: "Email" },
          ],
          allow_other: true,
        },
      ],
    };
    const golden: Golden = {
      name: "native-clarify",
      agentSlug: "rt-clarify",
      metadata: { output_envelope: "rt_env" },
      modelTurns: [
        { text: `<rt_env>${JSON.stringify(clarify)}</rt_env>`, stopReason: "end_turn" },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.clarify_envelope).toBeTruthy();
    expect(result.clarify_envelope?.questions.length).toBe(1);
    expect(result.clarify_envelope?.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.envelope_rescue_kind).toBe("structured_questions");
  });

  it("G11 max_tokens truncated mid-envelope → auto-continue stitches chunks, parse_ok", async () => {
    const innerJson = JSON.stringify({ rendered_markdown: "## Long output\n\nFinished writing." });
    const cut = innerJson.indexOf("Finished");
    const golden: Golden = {
      name: "max-tokens-autocontinue",
      agentSlug: "rt-salvage",
      metadata: { output_envelope: "rt_env" },
      modelTurns: [
        { text: `<rt_env>${innerJson.slice(0, cut)}`, stopReason: "max_tokens" },
        { text: `${innerJson.slice(cut)}</rt_env>`, stopReason: "end_turn" },
      ],
    };
    const { result, modelCalls } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(modelCalls).toBe(2);
    expect(result.parse_ok).toBe(true);
    expect(result.output_text).toBe("## Long output\n\nFinished writing.");
  });

  it("G12 tool error then recover → run completes, parse_ok, error tool_call traced", async () => {
    const inner = { rendered_markdown: "Recovered and produced the answer." };
    const golden: Golden = {
      name: "tool-error-recovery",
      agentSlug: "rt-tool",
      metadata: { output_envelope: "rt_env" },
      declaredTools: ["web__search"],
      toolResults: {
        web__search: { is_error: true, content: JSON.stringify({ error: "upstream_500" }), ms: 5 },
      },
      modelTurns: [
        { toolUses: [{ id: "t1", name: "web__search", input: { q: "x" } }] },
        { text: `<rt_env>${JSON.stringify(inner)}</rt_env>`, stopReason: "end_turn" },
      ],
    };
    const { result, modelCalls } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(true);
    expect(result.output_text).toBe("Recovered and produced the answer.");
    expect(modelCalls).toBe(2);
    const errTrace = (result.tool_calls ?? []).find((t) => t.name === "web__search");
    expect(errTrace).toBeTruthy();
    expect(errTrace?.status).toBe("tool_error");
    expect(errTrace?.code).toBe("upstream_500");
  });

  it("G13 successful tool call then envelope → ok tool_call traced, parse_ok", async () => {
    const inner = { rendered_markdown: "Used the tool result to answer." };
    const golden: Golden = {
      name: "tool-success",
      agentSlug: "rt-tool-ok",
      metadata: { output_envelope: "rt_env" },
      declaredTools: ["web__search"],
      toolResults: {
        web__search: { is_error: false, content: JSON.stringify({ hits: 3 }), ms: 7 },
      },
      modelTurns: [
        { toolUses: [{ id: "t1", name: "web__search", input: { q: "y" } }] },
        { text: `<rt_env>${JSON.stringify(inner)}</rt_env>`, stopReason: "end_turn" },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(true);
    const okTrace = (result.tool_calls ?? []).find((t) => t.name === "web__search");
    expect(okTrace?.status).toBe("ok");
  });

  it("G14 hallucinated (unregistered) tool → tool_unknown traced, run recovers", async () => {
    const inner = { rendered_markdown: "OK, that tool doesn't exist — here's the answer anyway." };
    const golden: Golden = {
      name: "hallucinated-tool",
      agentSlug: "rt-hallucinate",
      metadata: { output_envelope: "rt_env" },
      declaredTools: [],
      modelTurns: [
        { toolUses: [{ id: "t1", name: "nonexistent__tool", input: {} }] },
        { text: `<rt_env>${JSON.stringify(inner)}</rt_env>`, stopReason: "end_turn" },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(true);
    const trace = (result.tool_calls ?? []).find((t) => t.name === "nonexistent__tool");
    expect(trace?.status).toBe("tool_error");
    expect(trace?.code).toBe("tool_unknown");
  });

  it("G15 unrepairable envelope JSON (no rendered_markdown) → parse_failed", async () => {
    const golden: Golden = {
      name: "unrepairable-json",
      agentSlug: "rt-broken",
      metadata: { output_envelope: "rt_env" },
      modelTurns: [
        { text: `<rt_env>{ "items": [1, 2, </rt_env>`, stopReason: "end_turn" },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(false);
    expect(result.parsed).toBeNull();
  });

  it("G16 envelope JSON with raw control chars → repaired, parse_ok with salvage note", async () => {
    const broken = `<rt_env>{"rendered_markdown":"Line one
Line two with a raw newline"}</rt_env>`;
    const golden: Golden = {
      name: "salvaged-repaired-json",
      agentSlug: "rt-repair",
      metadata: { output_envelope: "rt_env" },
      modelTurns: [{ text: broken, stopReason: "end_turn" }],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.parse_ok).toBe(true);
    expect(result.output_text).toContain("Line one");
    expect(result.output_text).toContain("Line two");
    expect(result.parse_error).toMatch(/salvaged:repaired/);
  });

  it("G17 tool_iter_cap reached → cap-summarize fires, run terminates with output", async () => {
    const inner = { rendered_markdown: "Forced summary after hitting the iteration cap." };
    const golden: Golden = {
      name: "iter-cap-summarize",
      agentSlug: "rt-capped",
      metadata: { output_envelope: "rt_env", tool_iter_cap: 10 },
      declaredTools: ["web__search"],
      toolResults: {
        web__search: { is_error: false, content: JSON.stringify({ ok: true }), ms: 1 },
      },
      modelTurns: [
        ...Array.from({ length: 10 }, (_, i) => ({
          toolUses: [{ id: `t${i}`, name: "web__search", input: { i } }],
        })),
        { text: `<rt_env>${JSON.stringify(inner)}</rt_env>`, stopReason: "end_turn" },
      ],
    };
    const { result, modelCalls } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(modelCalls).toBe(11);
    expect(result.parse_ok).toBe(true);
    expect(result.output_text).toBe("Forced summary after hitting the iteration cap.");
  });

  it("G18 token usage accumulates across turns (cost-capture guard)", async () => {
    const inner = { rendered_markdown: "done" };
    const golden: Golden = {
      name: "usage-accumulation",
      agentSlug: "rt-usage",
      metadata: { output_envelope: "rt_env" },
      declaredTools: ["web__search"],
      modelTurns: [
        {
          toolUses: [{ id: "t1", name: "web__search", input: {} }],
          usage: { input_tokens: 1000, output_tokens: 200 },
        },
        {
          text: `<rt_env>${JSON.stringify(inner)}</rt_env>`,
          stopReason: "end_turn",
          usage: { input_tokens: 1500, output_tokens: 300 },
        },
      ],
    };
    const { result } = await driveGolden(runGeneric, golden, PAYLOAD);
    expect(result.usage.input_tokens).toBe(2500);
    expect(result.usage.output_tokens).toBe(500);
  });
});
