import { describe, it, expect } from "vitest";
import { markdownToEmailHtml, markdownToEmailText, markdownToReplyHtml } from "../markdown-email";

const REPLY = [
  "Your CPA this week was about **$52.52 per booking** across Meta and Google.",
  "",
  "**By platform**",
  "- **Meta:** $1,572.92 for 35 purchases.",
  "- **Google:** $370.18 for 2 conversions.",
  "",
  "See [the report](https://www.zaviagent.com/workspace?tab=growth&x=1).",
].join("\n");

describe("markdownToEmailHtml", () => {
  it("renders bold, bullets and paragraphs, with no literal asterisks", () => {
    const h = markdownToEmailHtml(REPLY);
    expect(h).toContain("<strong>$52.52 per booking</strong>");
    expect(h).toContain("<strong>By platform</strong>");
    expect(h).toMatch(/<ul[^>]*>\s*<li><strong>Meta:<\/strong> \$1,572\.92/);
    expect(h).not.toContain("**");
  });

  it("makes https links clickable and leaves other schemes as text", () => {
    expect(markdownToEmailHtml(REPLY)).toContain(
      '<a href="https://www.zaviagent.com/workspace?tab=growth&amp;x=1"',
    );
    const js = markdownToEmailHtml("[x](javascript:alert(1))");
    expect(js).not.toContain("<a ");
  });

  it("escapes HTML before adding its own marks", () => {
    const h = markdownToEmailHtml('<script>x</script> **"b"** [t](https://a.com/"onmouseover=1)');
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toMatch(/href="[^"]*"onmouseover/);
  });

  it("turns # headings into bold lines", () => {
    expect(markdownToEmailHtml("### Caveats")).toContain("font-weight:600;\">Caveats</p>");
  });
});

describe("markdownToEmailText", () => {
  it("strips marks and uses bullet dots", () => {
    const t = markdownToEmailText(REPLY);
    expect(t).not.toContain("**");
    expect(t).toContain("By platform\n• Meta: $1,572.92 for 35 purchases.");
    expect(t).toContain("See the report (https://www.zaviagent.com/workspace?tab=growth&x=1).");
  });
});

describe("markdownToReplyHtml", () => {
  it("wraps the fragment in a plain, person-style container (no card or button)", () => {
    const h = markdownToReplyHtml(REPLY);
    expect(h.startsWith("<div style=\"font-family:")).toBe(true);
    expect(h).not.toMatch(/<table|button|Open in Zavi/i);
  });
});
