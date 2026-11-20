
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  canUseNativeStructuredOutput,
  toOutputFormatJsonSchema,
  AGENT_OUTPUT_CLASS,
} from "@/services/agents/structured-output";
import { isStrictExpressible } from "@/services/agents/engine/strict-schema";

describe("gate 1 — canUseNativeStructuredOutput", () => {
  it("allows top_level_decision agents (their reduction yields a usable `parsed`)", () => {
    expect(canUseNativeStructuredOutput("engineer")).toBe(true);
    expect(canUseNativeStructuredOutput("pm")).toBe(true);
    expect(canUseNativeStructuredOutput("advisor")).toBe(true);
  });

  it("REFUSES digest agents — their bespoke dispatcher reads `parsed`, which the structured path sets to null", () => {
    expect(AGENT_OUTPUT_CLASS.research).toBe("digest_only");
    expect(canUseNativeStructuredOutput("research")).toBe(false);
    expect(canUseNativeStructuredOutput("qa")).toBe(false);
  });

  it("allows the two structured side-channel slugs", () => {
    expect(canUseNativeStructuredOutput("content-design")).toBe(true);
    expect(canUseNativeStructuredOutput("growth-lead")).toBe(true);
  });

  it("refuses an unclassified slug instead of throwing", () => {
    expect(canUseNativeStructuredOutput("operator")).toBe(false);
    expect(canUseNativeStructuredOutput("nope-not-an-agent")).toBe(false);
  });
});

describe("gate 1 on the Claude path", () => {
  it("the Claude SDK branch checks it too, so the global flag cannot send research down the null-`parsed` path", () => {
    const src = readFileSync(join(__dirname, "../generic-dispatcher.ts"), "utf8");
    const gate = src.slice(src.indexOf("const structuredOutputEnabled ="), src.indexOf("let structuredOutputFormat"));
    expect(gate).toContain("canUseNativeStructuredOutput(ctx.agent.slug)");
  });
});

describe("gate 2 — isStrictExpressible on the REAL envelopes", () => {
  it("catches chief-of-staff, whose z.record() becomes `propertyNames` and 400s the API", () => {
    const schema = toOutputFormatJsonSchema("chief-of-staff").schema;
    expect(JSON.stringify(schema)).toContain("propertyNames");
    expect(isStrictExpressible(schema)).toBe(false);
  });

  it("every agent that passes BOTH gates has a schema the API will actually accept", () => {
    const eligible = Object.keys(AGENT_OUTPUT_CLASS).filter(canUseNativeStructuredOutput);
    expect(eligible.length).toBeGreaterThan(0);
    const rejected: string[] = [];
    for (const slug of eligible) {
      if (!isStrictExpressible(toOutputFormatJsonSchema(slug).schema)) rejected.push(slug);
    }
    expect(rejected.sort()).toEqual(["chief-of-staff", "dispute-response"]);
  });
});
