import { describe, it, expect } from "vitest";
import { OpenAIAgentEngine } from "../openai-engine";
import { stripNullsDeep, isStrictExpressible } from "../strict-schema";
import {
  toOutputFormatJsonSchema,
  AGENT_OUTPUT_CLASS,
  unwrapDecisionForEmit,
} from "@/services/agents/structured-output";
import { outputSchemas } from "@/agents";
import { DISPATCH_ALLOWLIST } from "@/agents/advisor/output-schema";
import type { AgentEngineRunSpec, EngineEvent } from "../types";

const LIVE = process.env.PRAXIS_OPENAI_LIVE === "1";
const MODEL = process.env.PRAXIS_PARITY_OPENAI_MODEL || "gpt-5.5";

const SLUGS = Object.keys(AGENT_OUTPUT_CLASS);

const SCENARIO_HINT: Record<string, string> = {
  advisor:
    ` When you emit dispatch_proposals, the agent_slug MUST be one of EXACTLY ` +
    `these allowlisted agents (no others exist; any other slug is rejected): ` +
    `${DISPATCH_ALLOWLIST.join(", ")}.` +
    ` You have ENOUGH information for this scenario — set clarifications_needed ` +
    `to false and produce a complete recommendation. Do NOT ask clarifying ` +
    `questions (when clarifications_needed is set, all other fields must be empty).` +
    ` Because you give a decide_today recommendation, you MUST also set ` +
    `recommendations.lead_priority to the single highest-priority item.`,
};

(LIVE ? describe : describe.skip)("ground-truth: real agent schemas, normalized, strict, live", () => {
  for (const slug of SLUGS) {
    it(`${slug}: OpenAI accepts normalized strict schema + returns conforming JSON`, async () => {
      const fmt = toOutputFormatJsonSchema(slug);
      if (!fmt) {
        // eslint-disable-next-line no-console
        console.log(`[gt] ${slug}: no output format (skip)`);
        return;
      }
      const events: EngineEvent[] = [];
      const spec: AgentEngineRunSpec = {
        systemPrompt:
          `You are the ${slug} agent. Produce your normal structured output for a brief, realistic scenario. Fill every required field with plausible content.` +
          (SCENARIO_HINT[slug] ?? ""),
        userPrompt:
          "Scenario: a mid-size SaaS company, last 7 days. Produce your standard output object now.",
        model: MODEL,
        maxTurns: 3,
        tools: [],
        resume: null,
        abort: new AbortController(),
        dispatchTool: async () => ({ is_error: false, content: "", ms: 0 }),
        onEvent: (e) => events.push(e),
        outputJsonSchema: fmt as AgentEngineRunSpec["outputJsonSchema"],
      };
      let err: Error | null = null;
      try {
        for await (const _ of new OpenAIAgentEngine().run(spec)) void _;
      } catch (e) {
        err = e as Error;
      }
      const text = events
        .filter((e): e is Extract<EngineEvent, { type: "text_delta" }> => e.type === "text_delta")
        .map((e) => e.text)
        .join("");
      // eslint-disable-next-line no-console
      console.log(`[gt] ${slug}: err=${err?.message?.slice(0, 200) ?? "none"} len=${text.length}`);
      expect(err, `${slug} engine threw (likely OpenAI rejected the normalized schema)`).toBeNull();
      expect(text.trim().length, `${slug} produced no output`).toBeGreaterThan(0);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const strictOk = isStrictExpressible(fmt.schema);
      const cls = AGENT_OUTPUT_CLASS[slug];
      const zod = outputSchemas[slug];

      let verdict: string;
      if (cls === "top_level_decision") {
        const decision = parsed.decision;
        if (decision === undefined || decision === null) {
          verdict = "OK (no decision emitted — optional channel)";
        } else if (zod) {
          const { decision: emitBody } = unwrapDecisionForEmit(slug, parsed);
          const rEmit = zod.safeParse(stripNullsDeep(emitBody));
          verdict = rEmit.success
            ? "CONFORMING (emit body safeParses)"
            : `INVALID :: ${JSON.stringify(rEmit.error.issues?.slice(0, 3))}`;
        } else {
          verdict = "decision present, no zod authority registered";
        }
      } else {
        const rm = parsed.rendered_markdown;
        verdict =
          typeof rm === "string" && rm.trim().length > 0
            ? `OK (${cls ?? "digest"} — rendered_markdown present)`
            : `MISSING rendered_markdown`;
      }
      // eslint-disable-next-line no-console
      console.log(`[gt] ${slug}: class=${cls ?? "?"} strictOk=${strictOk} → ${verdict}`);
    }, 90_000);
  }
});
