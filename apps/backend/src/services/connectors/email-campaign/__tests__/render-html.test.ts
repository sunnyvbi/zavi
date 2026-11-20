import { describe, expect, it } from "vitest";
import { renderEmailHtml } from "../render-html";

describe("renderEmailHtml", () => {
  it("paragraphs and line breaks", () => {
    expect(renderEmailHtml("Hi\n\nLine one\nLine two")).toBe("<!doctype html><html><body><p>Hi</p><p>Line one<br>Line two</p></body></html>");
  });

  it("a web address in the text becomes a link to exactly that address, without the sentence's full stop", () => {
    const html = renderEmailHtml("See https://example.com/a?b=1. Thanks");
    expect(html).toContain('<a href="https://example.com/a?b=1">https://example.com/a?b=1</a>. Thanks');
  });

  it("the link text always equals the link target: no label can hide where it goes", () => {
    const html = renderEmailHtml("Go to https://safe.example/x and http://other.example");
    for (const m of html.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)) expect(m[1]).toBe(m[2]);
    expect([...html.matchAll(/<a /g)]).toHaveLength(2);
  });

  it("markup in the text is escaped, so it cannot add a link, an image or a script", () => {
    const html = renderEmailHtml('<a href="https://evil.example">win</a> <img src=x onerror=1> <script>1</script> "q" & \'s\'');
    expect(html).not.toMatch(/<a href="https:\/\/evil\.example">win|<img|<script/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;q&quot; &amp; &#39;s&#39;");
  });

  it("a quote cannot break out of the link's href", () => {
    const html = renderEmailHtml('https://example.com/"onmouseover="x');
    expect(html).toContain('<a href="https://example.com/">https://example.com/</a>&quot;onmouseover=&quot;x');
  });

  it("only http and https addresses become links", () => {
    expect(renderEmailHtml("javascript:alert(1) mailto:a@b.co data:text/html,x")).not.toContain("<a ");
  });

  it("the same text always gives the same HTML", () => {
    const t = "A\r\n\r\nB https://example.com";
    expect(renderEmailHtml(t)).toBe(renderEmailHtml(t));
    expect(renderEmailHtml(t)).toBe(renderEmailHtml("A\n\nB https://example.com"));
  });
});
