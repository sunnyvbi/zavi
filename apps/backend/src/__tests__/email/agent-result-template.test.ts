
import { describe, it, expect } from "vitest";

import { renderAgentResultEmail } from "@/email/templates/agent-result";

const base = {
  agentSlug: "operator",
  runUrl: "https://www.zaviagent.com/workspace",
};

describe("renderAgentResultEmail", () => {
  it("escapes HTML in the agent body — a script tag never reaches the inbox as markup", () => {
    const { html } = renderAgentResultEmail({
      ...base,
      body: "<script>alert(1)</script> and <img src=x onerror=alert(2)>",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an attribute-breaking quote", () => {
    const { html } = renderAgentResultEmail({
      ...base,
      body: 'say "hello" now',
    });
    expect(html).toContain("&quot;hello&quot;");
  });

  it("renders bullets and bold, which the agents actually emit", () => {
    const { html } = renderAgentResultEmail({
      ...base,
      body: "- first **bold** item\n- second item",
    });
    expect(html).toContain("<li>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("leads the subject with the body's first line of substance", () => {
    const { subject } = renderAgentResultEmail({
      ...base,
      body: "## Heading\n\n47 stalled approvals need a decision",
    });
    expect(subject).toBe("Zavi: Heading");
  });

  it("falls back to a generic subject on an empty body", () => {
    const { subject } = renderAgentResultEmail({ ...base, body: "" });
    expect(subject).toBe("Zavi: scheduled run");
  });

  it("truncates a long first line rather than shipping a 400-char subject", () => {
    const { subject } = renderAgentResultEmail({
      ...base,
      body: "x".repeat(400),
    });
    expect(subject.length).toBeLessThan(80);
    expect(subject).toContain("…");
  });

  it("puts the raw body in the text part (no markup, no escaping)", () => {
    const { text } = renderAgentResultEmail({
      ...base,
      body: "47 stalled approvals",
    });
    expect(text).toContain("47 stalled approvals");
    expect(text).toContain(base.runUrl);
  });
});

describe("renderAgentResultEmail ready (custom agent scheduled result)", () => {
  const ready = { agentSlug: "Daily Trending UGC Videos", runUrl: "https://www.zaviagent.com/workspace?tab=agent-builder", body: "## TikTok\n\n| # | Video |\n|---|---|\n| 1 | S550 |", ctaText: "See it in Zavi", ready: true };

  it("uses the locked subject, opener and button", () => {
    const { subject, html, text } = renderAgentResultEmail(ready);
    expect(subject).toBe("Daily Trending UGC Videos is ready");
    expect(html).toContain("Your agent finished today's run. Here's what it found.");
    expect(html).toContain("See it in Zavi");
    expect(text.split("\n").slice(0, 3)).toEqual([
      "Daily Trending UGC Videos is ready",
      "",
      "Your agent finished today's run. Here's what it found.",
    ]);
  });

  it("escapes the agent name in the HTML title", () => {
    const { html } = renderAgentResultEmail({ ...ready, agentSlug: "<b>x</b>" });
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("without ready, the standing-order email is unchanged (no opener, the old subject)", () => {
    const out = renderAgentResultEmail({ ...base, body: "Shipped 3 PRs." });
    expect(out.subject).toBe("Zavi: Shipped 3 PRs.");
    expect(out.html).not.toContain("finished today");
    expect(out.html).toContain("<em>ran</em>");
    expect(out.text.startsWith("Zavi: scheduled run\n\nShipped 3 PRs.")).toBe(true);
  });

  it("shows the product's own name for a built-in agent, and a channel's name for a channel", () => {
    const ads = renderAgentResultEmail({ ...base, agentSlug: "performance-marketer", body: "x" });
    expect(ads.html).toContain("Ads Manager <em>ran</em>");
    expect(ads.html).not.toContain("performance-marketer");
    expect(ads.subject).toBe("Ads Manager: x");
    const seo = renderAgentResultEmail({ ...base, agentSlug: "seo-geo", body: "x" });
    expect(seo.html).toContain("SEO &amp; AI Search <em>ran</em>");
  });

  it("never rewrites a name a person typed, even one that equals a built-in id", () => {
    for (const typed of ["price-watcher", "Competitor price watcher", "content-seo", "funnel-analysis", "operator", "toString"]) {
      for (const ready of [true, false]) {
        const out = renderAgentResultEmail({ ...base, agentSlug: typed, agentNameIsTyped: true, body: "x", ...(ready ? { ready } : {}) });
        expect(out.subject).toBe(ready ? `${typed} is ready` : `${typed}: x`);
        expect(out.html).toContain(`${typed} <em>${ready ? "is ready" : "ran"}</em>`);
      }
    }
  });

  it("without the typed flag, an unknown id is shown as given", () => {
    const out = renderAgentResultEmail({ ...base, agentSlug: "some-new-agent", body: "x" });
    expect(out.subject).toBe("some-new-agent: x");
  });
});
