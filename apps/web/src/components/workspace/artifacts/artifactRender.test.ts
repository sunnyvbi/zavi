import { describe, expect, it } from "vitest";
import { artifactRenderMode, isTextRenderMode, isUrlRenderMode, PAGE_MIME, parseCsv } from "./artifactRender";

describe("artifactRenderMode", () => {
  it("routes each delivered format to the element that can draw it", () => {
    expect(artifactRenderMode("text/html", "draft.html")).toBe("html");
    expect(artifactRenderMode("text/markdown", "brief.md")).toBe("markdown");
    expect(artifactRenderMode("text/csv", "cohorts.csv")).toBe("csv");
    expect(artifactRenderMode("application/pdf", "report.pdf")).toBe("pdf");
    expect(artifactRenderMode("image/png", "chart.png")).toBe("image");
    expect(artifactRenderMode("video/mp4", "launch.mp4")).toBe("video");
    expect(artifactRenderMode("application/vnd.zavi.ui+json", "block.json")).toBe("ui-block");
  });

  it("splits a charset off the mime before matching", () => {
    expect(artifactRenderMode("text/html; charset=utf-8", "page.html")).toBe("html");
  });

  it("falls back to the filename when storage reports a generic mime", () => {
    expect(artifactRenderMode("application/octet-stream", "post.md")).toBe("markdown");
    expect(artifactRenderMode("", "PAGE.HTML")).toBe("html");
  });

  it("leaves binary office formats to the download path", () => {
    expect(artifactRenderMode("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x.xlsx")).toBe("unsupported");
    expect(isTextRenderMode("unsupported")).toBe(false);
    expect(isUrlRenderMode("unsupported")).toBe(false);
  });

  it("routes a shared page to its own mode, which neither fetches a body nor mints a URL", () => {
    expect(PAGE_MIME).toBe("application/vnd.zavi.page");
    const mode = artifactRenderMode(PAGE_MIME, "");
    expect(mode).toBe("page");
    expect(artifactRenderMode(`${PAGE_MIME}; charset=utf-8`, "index.html")).toBe("page");
    expect(isTextRenderMode(mode)).toBe(false);
    expect(isUrlRenderMode(mode)).toBe(false);
  });

  it("keeps the ui-block mime ahead of the plain-json rule", () => {
    expect(artifactRenderMode("application/vnd.zavi.ui+json", "b.json")).not.toBe("text");
  });
});

describe("parseCsv", () => {
  it("keeps commas, newlines and doubled quotes inside a quoted field", () => {
    const rows = parseCsv('a,b\n"x,1","line\nbreak"\n"say ""hi""",2\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x,1", "line\nbreak"],
      ['say "hi"', "2"],
    ]);
  });

  it("drops the empty row a trailing newline would otherwise produce", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("stops at the row cap so a huge file cannot build an unbounded array", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `${i},x`).join("\n");
    expect(parseCsv(text, 10)).toHaveLength(10);
  });
});
