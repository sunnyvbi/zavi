import { describe, it, expect } from "vitest";
import { extractJsonObject } from "../extract-json";

describe("extractJsonObject", () => {
  it("parses a bare JSON object directly", () => {
    expect(extractJsonObject('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it("parses a JSON object with surrounding whitespace", () => {
    expect(extractJsonObject('  \n{"a":1}\n  ')).toEqual({ a: 1 });
  });

  it("parses an Anthropic prefill-completion (missing leading brace)", () => {
    const returned = '"atoms":[{"atom_type":"blocker","title":"x"}]}';
    expect(extractJsonObject(returned)).toEqual({
      atoms: [{ atom_type: "blocker", title: "x" }],
    });
  });

  it("parses a ```json fenced block", () => {
    const raw =
      '```json\n{"atoms":[{"atom_type":"policy","title":"20%"}]}\n```';
    expect(extractJsonObject(raw)).toEqual({
      atoms: [{ atom_type: "policy", title: "20%" }],
    });
  });

  it("parses a bare ``` fenced block (no language tag)", () => {
    const raw = '```\n{"a":1}\n```';
    expect(extractJsonObject(raw)).toEqual({ a: 1 });
  });

  it("extracts JSON from a prose preamble (the reported 4965-char failure shape)", () => {
    const raw =
      'Here are the atoms I extracted from the transcript:\n\n{"atoms":[{"atom_type":"blocker","title":"card loading"}]}\n\nLet me know if you need anything else.';
    expect(extractJsonObject(raw)).toEqual({
      atoms: [{ atom_type: "blocker", title: "card loading" }],
    });
  });

  it("returns null when the text contains NO JSON at all (preserves 'distill failure' verdict)", () => {
    expect(
      extractJsonObject("I could not produce JSON, sorry!"),
    ).toBeNull();
  });

  it("returns null on empty / whitespace input", () => {
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("   \n  ")).toBeNull();
  });

  it("returns null on genuinely malformed JSON", () => {
    expect(extractJsonObject("{not: valid, at: all")).toBeNull();
  });

  it("returns null on non-string input (defensive)", () => {
    expect(extractJsonObject(undefined as unknown as string)).toBeNull();
    expect(extractJsonObject(null as unknown as string)).toBeNull();
  });

  it("does not double-brace a valid response that already starts with '{'", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("extracts a large JSON object embedded in long prose", () => {
    const bigObj = JSON.stringify({
      atoms: Array.from({ length: 10 }, (_, i) => ({ atom_type: "blocker", i })),
    });
    const raw = `Some preamble paragraph.\n\n${bigObj}\n\nSome trailing prose.`;
    const parsed = extractJsonObject(raw) as { atoms: unknown[] };
    expect(parsed.atoms).toHaveLength(10);
  });
});
