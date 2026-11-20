import { describe, it, expect } from "vitest";
import { stripLeakedJson } from "../clean-prose";

describe("stripLeakedJson — fenced blobs (existing behavior)", () => {
  it("strips a ```json fenced block", () => {
    const out = stripLeakedJson('before\n\n```json\n{"a":1}\n```\n\nafter');
    expect(out).not.toContain("```json");
    expect(out).not.toContain('"a":1');
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("strips a fenced object with no language tag", () => {
    const out = stripLeakedJson('text\n\n```\n{"x":true}\n```\n\nend');
    expect(out).not.toContain('"x":true');
    expect(out).toContain("text");
    expect(out).toContain("end");
  });

  it("leaves a non-JSON code fence (```bash) untouched", () => {
    const src = "run this:\n\n```bash\nnpm test\n```";
    expect(stripLeakedJson(src)).toContain("npm test");
  });
});

describe("stripLeakedJson — unfenced serialized dump (2026-07-30 Landscape fix)", () => {
  it("strips a bare stat_tiles: [{…}] dump line", () => {
    const src = 'stat_tiles: [{"value":"$65.3B","label":"US market"}]';
    expect(stripLeakedJson(src)).toBe("");
  });

  it("strips a bare rows: [{…}] dump line", () => {
    const src = 'rows: [{"brand":"Turo","positioning":"P","gap":"G"}]';
    expect(stripLeakedJson(src)).toBe("");
  });

  it("strips a MULTI-LINE rows: [ {…} ] dump (not just the first line)", () => {
    const src = 'rows: [\n  {"brand":"Turo"},\n  {"brand":"Kyte"}\n]';
    expect(stripLeakedJson(src)).toBe("");
  });

  it("strips both stat_tiles and rows dump lines together (the reported shape)", () => {
    const src =
      'stat_tiles: [{"value":"$65.3B","label":"m"}]\nrows: [{"brand":"Turo","positioning":"p","gap":"g"}]';
    expect(stripLeakedJson(src)).toBe("");
  });

  it("strips a `- **rows:** [{…}]` bulleted/bold dump line", () => {
    const src = '- **rows:** [{"brand":"Turo"}]';
    expect(stripLeakedJson(src)).toBe("");
  });

  it("keeps a legit citations: [1, 2] line (array of numbers, not objects)", () => {
    const src = "See citations: [1, 2, 3] for the sources.";
    expect(stripLeakedJson(src)).toBe("See citations: [1, 2, 3] for the sources.");
  });

  it("drops a body that is entirely a bare JSON array", () => {
    const src = '[{"brand":"Turo"},{"brand":"Getaround"}]';
    expect(stripLeakedJson(src)).toBe("");
  });

  it("keeps normal prose that merely mentions rows in a sentence", () => {
    const src = "The competitive_table rows list every brand we track.";
    expect(stripLeakedJson(src)).toBe(src);
  });

  it("strips the dump line but preserves surrounding prose", () => {
    const src =
      'Here is the landscape:\nstat_tiles: [{"value":"$1"}]\nThat is the summary.';
    const out = stripLeakedJson(src);
    expect(out).toContain("Here is the landscape:");
    expect(out).toContain("That is the summary.");
    expect(out).not.toContain('"value":"$1"');
  });
});
