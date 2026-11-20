
import { describe, it, expect } from "vitest";
import { applyAutonomousGrounding } from "../autonomous-grounding";
import { runGroundingChecks } from "../eval/grounding-checks";
import { OPERATOR_DB_DOMAIN_AGENTS, PAYMENT_DOMAIN_AGENTS } from "../guard-domains";

const memoryHit = (body: string) => ({
  name: "mcp__server__memory__search",
  status: "ok",
  input_preview: '{"query":"company metrics GMV"}',
  output_preview: body,
});

const dbReadLite = (body: string) => ({
  name: "mcp__server__operator_db__query",
  status: "ok",
  output: body,
});

describe("C8 corpus — memory is a CLAIM about live state, not a MEASUREMENT of it", () => {
  it("does NOT treat a figure recalled from memory__search as grounded", () => {
    const res = runGroundingChecks({
      agent_output: "Your GMV run-rate is $23K/week.",
      input: "how are we doing as a company?",
      agentSlug: "operator",
      checkUnsupportedQuant: true,
      evidence: [
        {
          name: "mcp__server__memory__search",
          status: "ok",
          output: '{"hits":[{"body":"gross GMV is approximately $23K/week"}]}',
        },
      ],
    });
    const flags = res.flags.map((f) => f.pattern);
    expect(flags).toContain("unsupported_quant_claim");
  });

  it("DOES treat the same figure as grounded when a live operator_db read returned it", () => {
    const res = runGroundingChecks({
      agent_output: "Your GMV run-rate is $23K/week.",
      input: "how are we doing as a company?",
      agentSlug: "operator",
      checkUnsupportedQuant: true,
      evidence: [dbReadLite('{"rows":[{"gmv_per_week":"$23K/week"}]}')],
    });
    expect(res.flags.map((f) => f.pattern)).not.toContain("unsupported_quant_claim");
  });
});

describe("C8/C9 surface parity — the autonomous path arms what chat arms", () => {
  it("fires C8 for an operator run on the AUTONOMOUS path (slack/cron/email)", () => {
    const out = applyAutonomousGrounding({
      text: "Your blended take rate is 39% and net revenue run-rate is $470K ARR.",
      agentSlug: "operator",
      inboundContext: "how are we doing as a company?",
      toolCalls: [memoryHit('{"hits":[{"body":"take-rate 14.1%, benchmark 25%"}]}')] as never,
    });
    expect(out.deterministic_patterns).toContain("unsupported_quant_claim");
    expect(out.annotated).toBe(true);
    expect(out.text).toContain("39%");
  });

  it("stays SILENT for a non-domain agent saying an ordinary number", () => {
    const out = applyAutonomousGrounding({
      text: "I found 3 options and it should take about 5 minutes.",
      agentSlug: "research",
      inboundContext: "what are my options?",
      toolCalls: [] as never,
    });
    expect(out.deterministic_patterns).not.toContain("unsupported_quant_claim");
  });

  it("leaves C8 OFF when no agentSlug is supplied (explicit, not accidental)", () => {
    const out = applyAutonomousGrounding({
      text: "Your GMV run-rate is $23K/week.",
      inboundContext: "status?",
      toolCalls: [] as never,
    });
    expect(out.deterministic_patterns).not.toContain("unsupported_quant_claim");
  });
});

describe("the invariant that keeps this gap closed", () => {
  it("both surfaces arm C8/C9 from the SAME shared sets", () => {
    expect(OPERATOR_DB_DOMAIN_AGENTS.has("operator")).toBe(true);
    expect(OPERATOR_DB_DOMAIN_AGENTS.has("support-lead")).toBe(true);
    expect(PAYMENT_DOMAIN_AGENTS.has("dispute-response")).toBe(true);
    expect(OPERATOR_DB_DOMAIN_AGENTS.has("research")).toBe(false);
  });
});
