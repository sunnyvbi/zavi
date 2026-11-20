import { describe, it, expect } from "vitest";
import { buildPageOutline, OUTLINE_MAX_CHARS } from "../page-outline";

describe("buildPageOutline", () => {
  it("keeps title, headings, visible text and http(s) links; drops scripts, hidden text and non-http hrefs", () => {
    const html = `<html><head><title>Acme pricing</title><script>var secret=1</script></head>
      <body><h1>Plans</h1><p>Starter is $20.</p><div hidden>hidden words</div><style>.x{}</style>
      <a href="/pro">Pro plan</a><a href="javascript:alert(1)">bad</a><a href="mailto:a@b.c">mail</a>
      <h2 style="display:none">ghost</h2></body></html>`;
    const o = buildPageOutline(html, "https://acme.com/pricing");
    expect(o.title).toBe("Acme pricing");
    expect(o.headings).toEqual(["h1: Plans"]);
    expect(o.text).toContain("Starter is $20.");
    expect(o.text).not.toContain("secret");
    expect(o.text).not.toContain("hidden words");
    expect(o.text).not.toContain("ghost");
    expect(o.links).toEqual([{ text: "Pro plan", href: "https://acme.com/pro" }]);
  });

  it("caps the outline size on a huge hostile page", () => {
    const html = `<body>${"<p>word </p>".repeat(50_000)}${Array.from({ length: 500 }, (_, i) => `<a href="/l${i}">link ${i}</a>`).join("")}</body>`;
    const o = buildPageOutline(html, "https://x.com/", 999_999);
    expect(JSON.stringify(o).length).toBeLessThanOrEqual(OUTLINE_MAX_CHARS);
    expect(o.truncated).toBe(true);
    expect(o.links.length).toBeLessThanOrEqual(80);
  });
});
