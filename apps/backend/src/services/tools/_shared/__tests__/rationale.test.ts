
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { fitRationale, rationaleBody, rationaleInput, rationaleOptional, RATIONALE_MAX } from "../rationale";
import { zodToJsonSchema } from "@/services/tools/registry";
import { googleProposeKeywordsTool } from "@/services/tools/google-ads/write/propose_keywords";

describe("fitRationale", () => {
  it("leaves a rationale within the limit exactly as written, whitespace included", () => {
    const s = "Two  spaces\nand a line.";
    expect(fitRationale(s)).toBe(s);
    const exact = "a".repeat(RATIONALE_MAX);
    expect(fitRationale(exact)).toBe(exact);
  });

  it("cuts an over-long rationale at a word, ending in an ellipsis, within the limit", () => {
    const long = "word ".repeat(200);
    const out = fitRationale(long) as string;
    expect(out.length).toBeLessThanOrEqual(RATIONALE_MAX);
    expect(out.endsWith("word…")).toBe(true);
  });

  it("passes non-strings through for the schema to judge", () => {
    expect(fitRationale(undefined)).toBeUndefined();
    expect(fitRationale(42)).toBe(42);
  });
});

describe("rationale schemas", () => {
  it("input: required, 501 chars parses (trimmed), empty still fails", () => {
    const s = rationaleInput();
    expect((s.parse("x ".repeat(300)) as string).length).toBeLessThanOrEqual(RATIONALE_MAX);
    expect(s.safeParse("").success).toBe(false);
    expect(s.safeParse(undefined).success).toBe(false);
  });

  it("body: defaults to empty, trims an over-long one", () => {
    const s = z.object({ rationale: rationaleBody() });
    expect(s.parse({}).rationale).toBe("");
    expect(s.parse({ rationale: "y ".repeat(400) }).rationale.length).toBeLessThanOrEqual(RATIONALE_MAX);
  });

  it("optional: absent stays absent", () => {
    const s = z.object({ rationale: rationaleOptional() });
    expect(s.parse({}).rationale).toBeUndefined();
  });

  it("is advertised to the model as a plain string; only the required one is required", () => {
    const js = zodToJsonSchema(z.object({ a: rationaleInput(), b: rationaleBody(), c: rationaleOptional() }));
    expect(js.properties).toMatchObject({ a: { type: "string" }, b: { type: "string", default: "" }, c: { type: "string" } });
    expect(js.required).toEqual(["a"]);
  });

  it("a real propose tool still advertises rationale as a required string", () => {
    const js = zodToJsonSchema(googleProposeKeywordsTool.input_schema);
    expect((js.properties as Record<string, unknown>).rationale).toMatchObject({ type: "string" });
    expect(js.required).toContain("rationale");
  });
});
