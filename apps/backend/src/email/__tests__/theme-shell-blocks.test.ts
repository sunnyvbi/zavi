
import { describe, expect, it } from "vitest";
import { renderEmail, ZAVI_POSTAL_ADDRESS } from "../theme";

const base = { title: "Hello", body: "", footerVariant: "neutral" as const };

describe("the message bubble", () => {
  it("escapes the sender and the message, and keeps line breaks", () => {
    const html = renderEmail({
      ...base,
      quote: { from: "<b>Nia</b> & co", text: 'first <script>x</script>\nsecond "line"' },
    });
    expect(html).not.toContain("<b>Nia</b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;Nia&lt;/b&gt; &amp; co");
    expect(html).toContain("first &lt;script&gt;x&lt;/script&gt;<br>second &quot;line&quot;");
  });

  it("badges the first letter of the name, and falls back to Z for a name with no letter", () => {
    expect(renderEmail({ ...base, quote: { from: "nia", text: "hi" } })).toContain(">N</div>");
    expect(renderEmail({ ...base, quote: { from: "<>", text: "hi" } })).toContain(">Z</div>");
  });
});

describe("the details box", () => {
  it("escapes every label and value", () => {
    const html = renderEmail({ ...base, details: [{ label: "Job <i>", value: "A&B <b>video</b>" }] });
    expect(html).toContain("Job &lt;i&gt;");
    expect(html).toContain("A&amp;B &lt;b&gt;video&lt;/b&gt;");
    expect(html).not.toContain("<b>video</b>");
  });

  it("is absent when no rows are passed", () => {
    expect(renderEmail(base)).not.toContain("border-bottom:1px solid #ececec;font-family");
  });
});

describe("the button", () => {
  it("is square-cornered and black", () => {
    const html = renderEmail({ ...base, ctaText: "Open", ctaUrl: "https://x.test/a" });
    expect(html).toContain('bgcolor="#0e0f11" style="background-color:#0e0f11;border-radius:6px;"');
    expect(html).not.toContain("border-radius:999px;\"><a");
  });

  it("prints the link under the button only when asked", () => {
    const withLink = renderEmail({ ...base, ctaText: "Open", ctaUrl: "https://x.test/a", linkFallback: true });
    expect(withLink).toContain("Button not working? Paste this link in your browser:");
    expect(withLink.match(/https:\/\/x\.test\/a/g)).toHaveLength(2);
    const without = renderEmail({ ...base, ctaText: "Open", ctaUrl: "https://x.test/a" });
    expect(without).not.toContain("Button not working?");
    expect(without.match(/https:\/\/x\.test\/a/g)).toHaveLength(1);
  });

  it("needs both a label and a link", () => {
    expect(renderEmail({ ...base, ctaText: "Open" })).not.toContain(">Open</a>");
    expect(renderEmail({ ...base, ctaUrl: "https://x.test/a", linkFallback: true })).not.toContain("https://x.test/a");
  });
});

describe("the masthead label", () => {
  it("is dropped when it only repeats the wordmark", () => {
    expect(renderEmail({ ...base, kicker: "Zavi" })).not.toContain("letter-spacing:0.16em");
    expect(renderEmail({ ...base, kicker: " zavi " })).not.toContain("letter-spacing:0.16em");
    expect(renderEmail({ ...base, kicker: "Sign in" })).toContain(">Sign in</td>");
  });
});

describe("the headline", () => {
  it("keeps the key phrase as plain headline text: no italic, no highlight", () => {
    const html = renderEmail({ ...base, title: "Reset your <em>password</em>" });
    expect(html).toContain(".u-title em { font-style: normal; }");
    expect(html).not.toMatch(/<em[^>]*background/);
    expect(html).toContain("<title>Reset your password</title>");
  });
});

describe("the footer", () => {
  it("sits under the card and links the mailing address to a map, in the footer's own colour", () => {
    const html = renderEmail(base);
    const card = html.indexOf('class="email-container email-card"');
    const address = html.indexOf(ZAVI_POSTAL_ADDRESS);
    expect(card).toBeGreaterThan(-1);
    expect(address).toBeGreaterThan(html.indexOf("</table>", card));
    expect(html).toContain(
      `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ZAVI_POSTAL_ADDRESS)}" style="color:#6b6b6b;text-decoration:none;">${ZAVI_POSTAL_ADDRESS}</a>`,
    );
  });

  it("has no card body when an email is only a headline", () => {
    const html = renderEmail(base);
    expect(html).not.toContain('class="email-body"');
  });
});
