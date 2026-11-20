import { describe, it, expect } from "vitest";
import { renderBlogHtml, escapeHtml } from "../render-html";

describe("render-html: escaping (XSS)", () => {
  it("escapes HTML in the title", () => {
    const html = renderBlogHtml({
      title: `Hi <script>alert(1)</script> & "you"`,
      body: "hello",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("escapes HTML injected in the body", () => {
    const html = renderBlogHtml({
      title: "t",
      body: "a paragraph with <img src=x onerror=alert(1)> in it",
    });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img");
  });

  it("escapeHtml covers the five entities", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("render-html: markdown subset", () => {
  it("renders headings, bold, lists, and paragraphs", () => {
    const html = renderBlogHtml({
      title: "t",
      body: [
        "## Section one",
        "",
        "A **bold** word here.",
        "",
        "- first",
        "- second",
      ].join("\n"),
    });
    expect(html).toContain("<h2>Section one</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<ul><li>first</li><li>second</li></ul>");
    expect(html).toContain("<p>A <strong>bold</strong> word here.</p>");
  });

  it("renders safe links but drops javascript: URLs (keeping the text)", () => {
    const html = renderBlogHtml({
      title: "t",
      body: "[click](https://example.com) and [bad](javascript:alert(1))",
    });
    expect(html).toContain('<a href="https://example.com"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("bad");
  });
});

describe("render-html: hero gallery", () => {
  it("renders provided images and allows data: URIs", () => {
    const html = renderBlogHtml({
      title: "t",
      body: "b",
      heroImages: [
        { url: "https://cdn.example.com/a.png", alt: "hero a" },
        { url: "data:image/png;base64,AAAA", alt: "hero b" },
      ],
    });
    expect(html).toContain('src="https://cdn.example.com/a.png"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('alt="hero a"');
  });

  it("drops an image with an unsafe (non-http/data) src", () => {
    const html = renderBlogHtml({
      title: "t",
      body: "b",
      heroImages: [{ url: "javascript:alert(1)", alt: "x" }],
    });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
  });
});

describe("render-html: document + caps", () => {
  it("produces a full html document", () => {
    const html = renderBlogHtml({ title: "Title", body: "body" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Title</title>");
    expect(html).toContain("noindex");
  });

  it("rejects an oversized body", () => {
    const huge = "x".repeat(200 * 1024);
    expect(() => renderBlogHtml({ title: "t", body: huge })).toThrow();
  });

  it("shows read-time in the byline when provided", () => {
    const html = renderBlogHtml({ title: "t", body: "b", readTimeMinutes: 3 });
    expect(html).toContain("3 min read");
  });
});

describe("render-html: fenced code blocks", () => {
  const JSON_LD = [
    "## Structured data",
    "",
    "```json",
    "{",
    '  "@context": "https://schema.org",',
    '  "@type": "Service",',
    '  "name": "Car Rental Delivery"',
    "}",
    "```",
  ].join("\n");

  it("keeps a fenced block's own line breaks instead of collapsing it into a paragraph", () => {
    const html = renderBlogHtml({ title: "t", body: JSON_LD });
    expect(html).toContain('<pre><code class="language-json">');
    expect(html).toContain("&quot;@context&quot;: &quot;https://schema.org&quot;");
    expect(/<pre><code[^>]*>\{\n/.test(html)).toBe(true);
    expect(html).not.toContain("```");
  });

  it("never re-reads a fence's contents as markdown", () => {
    const html = renderBlogHtml({
      title: "t",
      body: ["```", "**not bold** and [not a link](https://x.test) and `not code`", "```"].join("\n"),
    });
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<a href");
    expect(html).toContain("**not bold**");
  });

  it("still escapes markup inside a fence", () => {
    const html = renderBlogHtml({
      title: "t",
      body: ["```html", "<script>alert(1)</script>", "```"].join("\n"),
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("runs an unterminated fence to the end rather than dropping the content", () => {
    const html = renderBlogHtml({ title: "t", body: ["```json", "{ }", "still mine"].join("\n") });
    expect(html).toContain("<pre><code");
    expect(html).toContain("still mine");
  });

  it("allowlists the language before it reaches a class attribute", () => {
    const html = renderBlogHtml({ title: "t", body: ['```js"onload=x', "a", "```"].join("\n") });
    expect(html).not.toContain('class="language-js"onload=x');
  });
});

describe("render-html: tables, rules, inline code", () => {
  it("renders a GFM pipe table with its alignments", () => {
    const html = renderBlogHtml({
      title: "t",
      body: [
        "| Source page | Anchor text |",
        "|---|---:|",
        "| upcar.ai | get it delivered |",
      ].join("\n"),
    });
    expect(html).toContain("<table>");
    expect(html).toContain("<th class=\"ta-l\">Source page</th>");
    expect(html).toContain("<th class=\"ta-r\">Anchor text</th>");
    expect(html).toContain("<td class=\"ta-l\">upcar.ai</td>");
    expect(html).toContain('<div class="table-wrap">');
  });

  it("leaves a line of pipes as prose when no divider row follows", () => {
    const html = renderBlogHtml({ title: "t", body: "a | b | c" });
    expect(html).not.toContain("<table>");
    expect(html).toContain("<p>a | b | c</p>");
  });

  it("renders --- as a rule, not as a paragraph of dashes", () => {
    const html = renderBlogHtml({ title: "t", body: ["one", "", "---", "", "two"].join("\n") });
    expect(html).toContain("<hr />");
    expect(html).not.toContain("<p>---</p>");
  });

  it("renders inline code and does not read markdown inside it", () => {
    const html = renderBlogHtml({ title: "t", body: "paste before `</body>` and `**keep**`" });
    expect(html).toContain("<code>&lt;/body&gt;</code>");
    expect(html).toContain("<code>**keep**</code>");
    expect(html).not.toContain("<strong>keep</strong>");
  });

  it("renders a blockquote", () => {
    const html = renderBlogHtml({ title: "t", body: "> a note worth pulling out" });
    expect(html).toContain("<blockquote>a note worth pulling out</blockquote>");
  });
});

describe("render-html: rule placement", () => {
  it("drops a rule that sits directly above a heading, since the heading draws its own", () => {
    const html = renderBlogHtml({
      title: "t",
      body: ["copy", "", "---", "", "## Next section", "", "more copy"].join("\n"),
    });
    expect(html).not.toContain("<hr />");
    expect(html).toContain("<h2>Next section</h2>");
  });

  it("keeps a rule that separates two blocks of prose", () => {
    const html = renderBlogHtml({ title: "t", body: ["one", "", "---", "", "two"].join("\n") });
    expect(html).toContain("<hr />");
  });
});

describe("render-html: where the images land", () => {
  const POST = [
    "Opening paragraph.",
    "",
    "## First section",
    "",
    "Body of the first section.",
    "",
    "## Second section",
    "",
    "Body of the second section.",
    "",
    "## Third section",
    "",
    "Body of the third section.",
  ].join("\n");

  const img = (n: number) => ({ url: `https://cdn.example/${n}.png`, alt: `alt ${n}` });

  it("keeps ONE image above the body and moves the rest into the sections", () => {
    const html = renderBlogHtml({
      title: "t",
      body: POST,
      heroImages: [img(1), img(2), img(3)],
    });
    expect(html.match(/<figure class="hero">/g)).toHaveLength(1);
    expect(html.match(/<figure class="inline">/g)).toHaveLength(2);
    const hero = html.indexOf('<figure class="hero">');
    const firstPara = html.indexOf("Opening paragraph.");
    const firstInline = html.indexOf('<figure class="inline">');
    expect(hero).toBeLessThan(firstPara);
    expect(firstInline).toBeGreaterThan(firstPara);
  });

  it("spreads them apart instead of clustering at the first heading", () => {
    const html = renderBlogHtml({
      title: "t",
      body: POST,
      heroImages: [img(1), img(2), img(3)],
    });
    const sections = ["First section", "Second section", "Third section"].map((h) =>
      html.indexOf(h),
    );
    const inlines = [...html.matchAll(/<figure class="inline">/g)].map((m) => m.index!);
    const bucket = (at: number) => sections.filter((s) => s < at).length;
    expect(new Set(inlines.map(bucket)).size).toBe(inlines.length);
  });

  it("a post with no headings keeps its images at the top rather than dropping them", () => {
    const html = renderBlogHtml({
      title: "t",
      body: "Just one paragraph, nothing to break up.",
      heroImages: [img(1), img(2)],
    });
    expect(html.match(/<figure class="hero">/g)).toHaveLength(2);
    expect(html).not.toContain('<figure class="inline">');
  });

  it("a single image is simply the hero", () => {
    const html = renderBlogHtml({ title: "t", body: POST, heroImages: [img(1)] });
    expect(html.match(/<figure class="hero">/g)).toHaveLength(1);
    expect(html).not.toContain('<figure class="inline">');
  });
});

describe("render-html: no image is generated, charged, and then dropped", () => {
  const img = (n: number) => ({ url: `https://cdn.example/${n}.png`, alt: `alt ${n}` });
  const count = (html: string) =>
    (html.match(/<figure class="(?:hero|inline)">/g) ?? []).length;

  it("places all three when the post has only ONE section heading", () => {
    const html = renderBlogHtml({
      title: "t",
      body: ["Intro.", "", "## Only section", "", "### A subsection", "", "Text."].join("\n"),
      heroImages: [img(1), img(2), img(3)],
    });
    expect(count(html)).toBe(3);
  });

  it("places every image for any heading count, 1 to 3 images", () => {
    for (let headings = 0; headings <= 4; headings++) {
      for (let images = 1; images <= 3; images++) {
        const body = ["Intro."]
          .concat(
            Array.from({ length: headings }, (_, h) => `\n## Section ${h}\n\nBody ${h}.`),
          )
          .join("\n");
        const html = renderBlogHtml({
          title: "t",
          body,
          heroImages: Array.from({ length: images }, (_, n) => img(n)),
        });
        expect(count(html), `${headings} headings, ${images} images`).toBe(images);
      }
    }
  });
});
