import { describe, it, expect } from "vitest";
import { parseCitations, CITATION_INSTRUCTION } from "../citation-parser";

describe("parseCitations — happy path", () => {
  it("returns empty citations + unchanged text when no cite tag present", () => {
    const input = "I evaluated the inquiry. No policy red flags.";
    const out = parseCitations(input);
    expect(out.text).toBe(input);
    expect(out.citations).toEqual([]);
  });

  it("extracts memory_doc citations from a single tag and strips it", () => {
    const input =
      'Policy check passed. <cite memory_docs="trust-safety,policies"/>';
    const out = parseCitations(input);
    expect(out.text).toBe("Policy check passed.");
    expect(out.citations).toEqual([
      { kind: "memory_doc", ref: "trust-safety", label: "trust-safety" },
      { kind: "memory_doc", ref: "policies", label: "policies" },
    ]);
  });

  it("extracts agent_run citations and short-hash labels them", () => {
    const input =
      'Prior run flagged this guest. <cite agent_runs="abcd1234-aaaa-bbbb-cccc-111122223333"/>';
    const out = parseCitations(input);
    expect(out.text).toBe("Prior run flagged this guest.");
    expect(out.citations).toEqual([
      {
        kind: "agent_run",
        ref: "abcd1234-aaaa-bbbb-cccc-111122223333",
        label: "run abcd1234",
      },
    ]);
  });

  it("merges memory_doc + agent_run citations from one tag", () => {
    const input =
      'Both sources align. <cite memory_docs="disputes" agent_runs="11111111-2222-3333-4444-555566667777"/>';
    const out = parseCitations(input);
    expect(out.citations).toHaveLength(2);
    expect(out.citations[0].kind).toBe("memory_doc");
    expect(out.citations[1].kind).toBe("agent_run");
    expect(out.text).toBe("Both sources align.");
  });

  it("dedupes citations across multiple tags in the same text", () => {
    const input = [
      'First. <cite memory_docs="trust-safety"/>',
      'Second. <cite memory_docs="trust-safety,policies"/>',
    ].join("\n");
    const out = parseCitations(input);
    const refs = out.citations.map((c) => c.ref);
    expect(refs).toEqual(["trust-safety", "policies"]);
  });
});

describe("parseCitations — edge cases", () => {
  it("handles empty string", () => {
    expect(parseCitations("")).toEqual({ text: "", citations: [] });
  });

  it("handles null gracefully", () => {
    // @ts-expect-error — we accept non-string at runtime for defensive callers
    const out = parseCitations(null);
    expect(out.citations).toEqual([]);
  });

  it("ignores unknown attributes (forward-compat)", () => {
    const input = 'Hello. <cite future_kind="x" memory_docs="ops"/>';
    const out = parseCitations(input);
    expect(out.citations).toEqual([
      { kind: "memory_doc", ref: "ops", label: "ops" },
    ]);
    expect(out.text).toBe("Hello.");
  });

  it("ignores empty attribute values", () => {
    const input = 'A. <cite memory_docs="" agent_runs=""/>';
    const out = parseCitations(input);
    expect(out.citations).toEqual([]);
    expect(out.text).toBe("A.");
  });

  it("filters out whitespace-only items after comma split", () => {
    const input = 'B. <cite memory_docs="ops,  ,policies"/>';
    const out = parseCitations(input);
    expect(out.citations.map((c) => c.ref)).toEqual(["ops", "policies"]);
  });

  it("preserves paragraph breaks (\\n\\n) when stripping a tag", () => {
    const out = parseCitations("# H\n\nbody\n\n## B");
    expect(out.text).toContain("\n\n");
  });

  it("does NOT strip a malformed tag (no closing /)", () => {
    const input = 'Hello <cite memory_docs="ops"> world.';
    const out = parseCitations(input);
    expect(out.text).toContain("<cite");
    expect(out.citations).toEqual([]);
  });

  it("strips multiple tags scattered across a long reasoning text", () => {
    const input = [
      "Step 1: Reviewed company memory.",
      '<cite memory_docs="company"/>',
      "Step 2: Cross-checked against ops.",
      'Conclusion: proceed. <cite memory_docs="ops,policies"/>',
    ].join("\n");
    const out = parseCitations(input);
    expect(out.text).not.toContain("<cite");
    expect(out.citations.map((c) => c.ref)).toEqual([
      "company",
      "ops",
      "policies",
    ]);
  });
});

describe("CITATION_INSTRUCTION — system prompt addendum", () => {
  it("describes the tag convention with a concrete example", () => {
    expect(CITATION_INSTRUCTION).toMatch(/## Citations/);
    expect(CITATION_INSTRUCTION).toMatch(
      /<cite memory_anchors="slug1,slug2" agent_runs="uuid1,uuid2"\/>/,
    );
    expect(CITATION_INSTRUCTION).toMatch(
      /removed from the visible output/i,
    );
  });

  it("accepts memory_anchors= as the new attribute name", () => {
    const out = parseCitations('Policy check. <cite memory_anchors="company,ops"/>');
    expect(out.text).toBe("Policy check.");
    expect(out.citations.map((c) => c.ref)).toEqual(["company", "ops"]);
  });

  it("still accepts legacy memory_docs= attribute (pre-0052 alias)", () => {
    const out = parseCitations('Legacy. <cite memory_docs="company"/>');
    expect(out.text).toBe("Legacy.");
    expect(out.citations[0].ref).toBe("company");
  });

  it("lists the 5 canonical memory_doc slugs by name", () => {
    for (const slug of [
      "company",
      "ops",
      "policies",
      "disputes",
      "support",
    ]) {
      expect(CITATION_INSTRUCTION).toMatch(new RegExp(slug));
    }
  });

  it("tells the model to omit the tag when no citations apply", () => {
    expect(CITATION_INSTRUCTION).toMatch(/omit the tag entirely/i);
  });
});
