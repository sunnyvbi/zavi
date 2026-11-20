import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogMarkdown, isExternal } from "./BlogMarkdown";

const html = (md: string) => renderToStaticMarkup(<BlogMarkdown>{md}</BlogMarkdown>);

describe("BlogMarkdown", () => {
  it("drops raw HTML, images and javascript: links", () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![pic](https://e.com/a.png)\n\n[click](javascript:alert(1))');
    expect(out).not.toMatch(/<script|<img|onerror|javascript:/i);
  });
  it("opens only real off-site links in a new tab", () => {
    expect(html("[a](https://example.com)")).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html("[a](/start)")).not.toContain("_blank");
    expect(html("[a](https://www.zaviagent.com/pricing)")).not.toContain("_blank");
  });
  it("isExternal compares the parsed host, not a prefix", () => {
    expect(isExternal("https://www.zaviagent.com.evil.example/x")).toBe(true);
    expect(isExternal("//evil.example/x")).toBe(true);
    expect(isExternal("//www.zaviagent.com/blog")).toBe(false);
    expect(isExternal("https://zaviagent.com/blog")).toBe(false);
    expect(isExternal("/blog")).toBe(false);
  });
});
