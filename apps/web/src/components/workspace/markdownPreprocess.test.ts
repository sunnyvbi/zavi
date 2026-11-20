import { describe, it, expect } from "vitest";
import { rewriteHtmlBreaks, stripModelControlXml } from "./markdownPreprocess";

describe("rewriteHtmlBreaks — model <br> never glues words together", () => {
  it("turns <br> variants into line breaks in prose", () => {
    expect(rewriteHtmlBreaks("a<br>b")).toBe("a\nb");
    expect(rewriteHtmlBreaks("a<br/>b<BR />c")).toBe("a\nb\nc");
  });

  it("drops a trailing <br> instead of adding a blank line", () => {
    expect(rewriteHtmlBreaks("line one<br>\nline two")).toBe("line one\nline two");
  });

  it("uses a space inside a table row so the table doesn't split", () => {
    const table = "| a | b |\n|---|---|\n| x<br>y | z |";
    expect(rewriteHtmlBreaks(table)).toBe("| a | b |\n|---|---|\n| x y | z |");
  });

  it("leaves inline code alone", () => {
    expect(rewriteHtmlBreaks("use `<br/>` then<br>next")).toBe("use `<br/>` then\nnext");
    expect(rewriteHtmlBreaks("``a <br> `b` ``<br>c")).toBe("``a <br> `b` ``\nc");
  });

  it("leaves backtick and tilde fences alone", () => {
    const fenced = "```html\n<p>a<br>b</p>\n```\nafter<br>x";
    expect(rewriteHtmlBreaks(fenced)).toBe("```html\n<p>a<br>b</p>\n```\nafter\nx");
    const tilde = "~~~~\n<br>\n~~~\nstill code<br>\n~~~~\nout<br>y";
    expect(rewriteHtmlBreaks(tilde)).toBe("~~~~\n<br>\n~~~\nstill code<br>\n~~~~\nout\ny");
  });

  it("leaves 4-space / tab indented code lines alone", () => {
    expect(rewriteHtmlBreaks("    code<br>here\n\tmore<br>code")).toBe(
      "    code<br>here\n\tmore<br>code",
    );
  });

  it("handles CRLF input like LF", () => {
    expect(rewriteHtmlBreaks("a<br>\r\nb")).toBe("a\nb");
  });

  it("a pipe in prose or inline code doesn't make the line a table row", () => {
    expect(rewriteHtmlBreaks("run `a | b`<br>next")).toBe("run `a | b`\nnext");
    expect(rewriteHtmlBreaks("Cost | CAC<br>Spend | ROAS")).toBe("Cost | CAC\nSpend | ROAS");
  });

  it("treats pipe-less and blockquoted GFM tables as tables", () => {
    expect(rewriteHtmlBreaks("a | b\n--- | ---\nx<br>y | z")).toBe("a | b\n--- | ---\nx y | z");
    expect(rewriteHtmlBreaks("> | a | b |\n> |:--|--:|\n> | x<br>y | z |")).toBe(
      "> | a | b |\n> |:--|--:|\n> | x y | z |",
    );
  });

  it("a `---` rule under a pipe line is not a table", () => {
    expect(rewriteHtmlBreaks("Cost | CAC<br>Spend\n---")).toBe("Cost | CAC\nSpend\n---");
  });

  it("a table ends at a blank line", () => {
    expect(rewriteHtmlBreaks("| a |\n|---|\n| x<br>y |\n\nafter | text<br>more")).toBe(
      "| a |\n|---|\n| x y |\n\nafter | text\nmore",
    );
  });

  it("is a no-op without <br>", () => {
    const s = "no breaks | here\n```\nx\n```";
    expect(rewriteHtmlBreaks(s)).toBe(s);
  });

  it("runs as part of stripModelControlXml", () => {
    expect(stripModelControlXml("Spend: $1,054<br>CAC: $4")).toBe("Spend: $1,054\nCAC: $4");
  });
});

describe("stripModelControlXml orphan numeric-period (qa-blind 2026-05-27 R1)", () => {
  it("escapes the period when entire body is a bare number + period", () => {
    expect(stripModelControlXml("20.")).toBe("20\\.");
    expect(stripModelControlXml("12.")).toBe("12\\.");
    expect(stripModelControlXml("8.")).toBe("8\\.");
    expect(stripModelControlXml("  15.  ")).toBe("15\\.");
  });

  it("leaves real ordered lists alone", () => {
    expect(stripModelControlXml("1. first\n2. second")).toBe(
      "1. first\n2. second",
    );
    expect(stripModelControlXml("20. answer")).toBe("20. answer");
  });

  it("leaves non-numeric short replies alone", () => {
    expect(stripModelControlXml("Blue.")).toBe("Blue.");
    expect(stripModelControlXml("Paris.")).toBe("Paris.");
  });

  it("strips XML tool-control tags (preserves existing behavior)", () => {
    const src = "hello world";
    expect(stripModelControlXml(src)).toBe("hello world");
  });
});

describe("stripModelControlXml hides reply cards (<zavi-ui>)", () => {
  it("removes a finished card block, the server draws it as a card", () => {
    expect(stripModelControlXml('Not yet.\n\n<zavi-ui>{"kind":"kpi","title":"Spend","items":[]}</zavi-ui>\n\nRe-check Oct 17.')).toBe(
      "Not yet.\n\nRe-check Oct 17.",
    );
  });
  it("hides a half-streamed block so its JSON never flashes", () => {
    expect(stripModelControlXml('Not yet.\n\n<zavi-ui>{"kind":"table","title":"Atl')).toBe("Not yet.");
  });
  it("drops the empty fence a stored reply kept after its card was pulled out (prod 2026-10-16)", () => {
    expect(stripModelControlXml("Atlanta was flat.\n\n```zavi-ui\n\n```\n\n- **Last week:** both cancelled.")).toBe(
      "Atlanta was flat.\n\n- **Last week:** both cancelled.",
    );
  });
  it("drops the fence around a card still in the text", () => {
    expect(stripModelControlXml('Flat.\n\n```json\n<zavi-ui>{"kind":"kpi","title":"x","items":[]}</zavi-ui>\n```\n\nDone.')).toBe(
      "Flat.\n\nDone.",
    );
  });
  it("keeps an indented-code example of an empty fence", () => {
    expect(stripModelControlXml("Example:\n\n    ```json\n\n    ```")).toContain("    ```json");
  });
  it("keeps a real code block", () => {
    expect(stripModelControlXml("Run:\n\n```sql\nselect 1;\n```")).toBe("Run:\n\n```sql\nselect 1;\n```");
  });
  it("leaves ordinary text alone", () => {
    expect(stripModelControlXml("Meta spent $41 on 986 clicks.")).toBe("Meta spent $41 on 986 clicks.");
  });
});
