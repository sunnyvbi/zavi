const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");
const { describe, it, expect } = require("./helpers/vitest-shim.cjs");

const M = loadTs(path.join(__dirname, "../src/lib/markdownBlocks.ts"));

describe("tables", () => {
  it("reads a GFM table between paragraphs", () => {
    const body = ["Top videos:", "", "| Platform | Views |", "| --- | ---: |", "| TikTok | 824.7K |", "| YouTube | 12K |", "", "Done."].join("\n");
    expect(M.parseMarkdown(body)).toEqual([
      { kind: "paragraph", text: "Top videos:" },
      { kind: "table", header: ["Platform", "Views"], rows: [["TikTok", "824.7K"], ["YouTube", "12K"]] },
      { kind: "paragraph", text: "Done." },
    ]);
  });

  it("works without outer pipes, pads short rows and keeps escaped pipes", () => {
    expect(M.parseMarkdown("a | b\n---|---\nfoo \\| bar | y\nafter")).toEqual([
      { kind: "table", header: ["a", "b"], rows: [["foo | bar", "y"]] },
      { kind: "paragraph", text: "after" },
    ]);
    expect(M.parseMarkdown("| a | b |\n|---|---|\n| only |")[0].rows).toEqual([["only", ""]]);
  });

  it("a pipe line with no separator under it stays a paragraph", () => {
    expect(M.parseMarkdown("a | b\nc | d")).toEqual([{ kind: "paragraph", text: "a | b\nc | d" }]);
  });

  it("a plain --- is still a rule", () => {
    expect(M.parseMarkdown("one\n\n---\n\ntwo").map((b) => b.kind)).toEqual(["paragraph", "rule", "paragraph"]);
  });
});

describe("columnWidth", () => {
  it("sizes to the longest cell within bounds, ignoring bold and link marks", () => {
    expect(M.columnWidth(["a"])).toBe(96);
    expect(M.columnWidth(["x".repeat(100)])).toBe(260);
    expect(M.columnWidth(["**Views**"])).toBe(M.columnWidth(["Views"]));
  });
});
