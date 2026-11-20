
import { describe, it, expect } from "vitest";
import { renderDocHtml } from "../render-doc-html";
import { renderDocInputSchema } from "../doc-schema";

const base = {
  title: "Co-host earnings, end to end",
  eyebrow: "Upcar Rental · Money path",
  subtitle: "How a trip's money reaches a host, and where a co-host's share comes out of it.",
  sections: [
    {
      heading: "The pipeline today",
      body_markdown: "The guest's card is charged into **one** Stripe account.\n\n- Nothing is split at charge time\n- Payouts run on crons",
      steps: [
        { title: "Trip ends", body: "A cron sweeps completed trips.", meta: "calculateHostPayment · 6:17 AM" },
        { title: "One payout row is written", body: "Keyed to the car owner." },
      ],
    },
    {
      heading: "A $612 trip with a 20% co-host",
      ledger: [
        { label: "Guest total charged", value: "$612.00" },
        { label: "Upcar platform fee", value: "-$183.60", note: "Unchanged by the split", emphasis: "negative" as const },
        { label: "Host payout amount", value: "$420.00", emphasis: "total" as const },
      ],
      callout: { tone: "warn" as const, body: "Not built yet — this describes the design." },
    },
  ],
};

describe("renderDocHtml", () => {
  it("accepts the shape the tool advertises", () => {
    expect(renderDocInputSchema.safeParse(base).success).toBe(true);
  });

  it("renders the structure an explainer needs", () => {
    const html = renderDocHtml(base);
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toContain("Co-host earnings, end to end");
    expect(html).toContain("Upcar Rental · Money path");
    expect(html).toMatch(/class="pipeline"/);
    expect(html).toContain("calculateHostPayment · 6:17 AM");
    expect(html).toMatch(/class="ledger"/);
    expect(html).toContain("$612.00");
    expect(html).toMatch(/class="callout warn"/);
    expect(html).toMatch(/<strong>one<\/strong>/);
    expect(html).toMatch(/<li>Nothing is split at charge time<\/li>/);
  });

  it("escapes every model-supplied string — no path from output to markup", () => {
    const hostile = {
      title: '<script>alert(1)</script>',
      sections: [
        {
          heading: '"><img src=x onerror=alert(1)>',
          body_markdown: "<script>steal()</script> and <b>bold</b>",
          steps: [{ title: "<svg onload=alert(1)>", meta: "</style><script>x</script>" }],
          ledger: [{ label: "<iframe>", value: "</div><script>y</script>" }],
          table: { columns: ["<script>"], rows: [["</td><script>z</script>"]] },
          callout: { tone: "info" as const, body: "<script>c</script>" },
        },
      ],
    };
    const html = renderDocHtml(hostile);
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).not.toMatch(/<script>steal\(\)/);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<svg\b/i);
    expect(html).not.toMatch(/<iframe\b/i);
    expect(html).not.toMatch(/(?<!&lt;)<script>(alert|steal|x|y|z|c)\b/);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;svg onload=alert(1)&gt;");
  });

  it("escapes inside markdown bold and code too", () => {
    const html = renderDocHtml({
      title: "t",
      sections: [{ heading: "h", body_markdown: "**<script>a</script>** and `<script>b</script>`" }],
    });
    expect(html).not.toMatch(/<script>a<\/script>/);
    expect(html).toMatch(/<strong>&lt;script&gt;a&lt;\/script&gt;<\/strong>/);
    expect(html).toMatch(/<code>&lt;script&gt;b&lt;\/script&gt;<\/code>/);
  });

  it("carries the public-link disclosure when one is given, and omits it otherwise", () => {
    const withLink = renderDocHtml(base, "Anyone with this link can open this page.");
    expect(withLink).toContain("Anyone with this link can open this page.");
    expect(renderDocHtml(base)).not.toMatch(/Anyone with this link/);
  });

  it("asks not to be indexed — a shared page is not a published one", () => {
    expect(renderDocHtml(base)).toMatch(/name="robots" content="noindex/);
  });

  it("renders a table with matching cells", () => {
    const html = renderDocHtml({
      title: "t",
      sections: [{ heading: "h", table: { columns: ["A", "B"], rows: [["1", "2"]] } }],
    });
    expect(html).toMatch(/<th>A<\/th><th>B<\/th>/);
    expect(html).toMatch(/<td>1<\/td><td>2<\/td>/);
  });

  it("is a complete standalone page — nothing to fetch, nothing to block", () => {
    const html = renderDocHtml(base);
    expect(html).toMatch(/<style>/);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3)/);
  });
});
