
import { describe, it, expect } from "vitest";
import { renderReportPage, reportMarker } from "../report-page";

const ART = "44444444-4444-4444-8444-444444444444";

describe("renderReportPage", () => {
  it("keeps a long generated title inside shared_pages' 120 chars", () => {
    const long = "A very long measure name that goes on and on for quite a while";
    const page = renderReportPage({
      block: { kind: "table", title: `Month · ${long} · ${long}`, columns: ["Month", long, long + " 2"], rows: [["July", "1", "2"]] },
      summary: "",
      sources: null,
      createdAt: "2026-09-25T00:00:00Z",
      artifactId: ART,
    })!;
    expect(page.title.length).toBeLessThanOrEqual(120);
    expect(page.html).toContain(reportMarker(ART));
  });

  it("escapes every model string and carries no script", () => {
    const page = renderReportPage({
      block: { kind: "table", title: "<img src=x onerror=alert(1)>", columns: ["Month", "N"], rows: [["<script>x</script>", "5"]], note: "*<b>n</b>" },
      summary: "**Bold** <i>hi</i>",
      sources: null,
      createdAt: "2026-09-25T00:00:00Z",
      artifactId: ART,
    })!;
    expect(page.html).not.toMatch(/<script|<img|<i>|<b>/);
    expect(page.html).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(page.html).toContain("<strong>Bold</strong>");
  });

  it("shows a rate's formula on a per-channel page, like the pane", () => {
    const page = renderReportPage({
      block: { kind: "table", title: "t", columns: ["Channel", "Sign-ups", "Booked", "Rate"], rows: [["Meta", "1,000", "100", "10.0%"], ["Google", "500", "25", "5.0%"]] },
      summary: "",
      sources: null,
      createdAt: "2026-09-25T00:00:00Z",
      artifactId: ART,
    })!;
    expect(page.html).toContain("= Booked ÷ Sign-ups");
  });
});

describe("shared report: the public copy (2026-10-29)", () => {
  const base = { sources: null, createdAt: "2026-10-29T00:00:00Z", artifactId: ART };

  it("renders a GFM table in the reply and escapes every cell", () => {
    const page = renderReportPage({
      ...base,
      block: { kind: "table", title: "t", columns: ["Month", "N"], rows: [["July", "1"]] },
      summary: "**Gaps**\n| Priority | Gap |\n| --- | --- |\n| High | <img src=x onerror=alert(1)> **bold** |\n| Low | a \\| b |",
    })!;
    expect(page.html).not.toContain("| Priority");
    expect(page.html).toMatch(/<table class="md"><thead><tr><th>Priority<\/th><th>Gap<\/th>/);
    expect(page.html).toContain("<td>&lt;img src=x onerror=alert(1)&gt; <strong>bold</strong></td>");
    expect(page.html).toContain("<td>a | b</td>");
    expect(page.html).not.toMatch(/<img/);
  });

  it("strips in-app links, call labels and ids from the reply and the sources", () => {
    const id = "c8bb5cd5-4567-4ba1-9d67-13268819bf39";
    const page = renderReportPage({
      ...base,
      block: { kind: "table", title: "t", columns: ["Month", "N"], rows: [["July", "1"]] },
      summary: `See [the brain](/workspace?tab=brain&access=${id}#data-access) and [docs](https://example.com/x).`,
      sources: `**Where these numbers came from.** 1 of 1.\n1. Your database: a query (call 1) on trips, 1 row. [See query](/workspace?tab=brain&access=${id}#data-access)\n2. PostHog (call 8) returned 1,092`,
    })!;
    expect(page.html).not.toContain(id);
    expect(page.html).not.toContain("/workspace");
    expect(page.html).not.toContain("See query");
    expect(page.html).not.toMatch(/\(call \d+\)|\]\(/);
    expect(page.html).toContain("Your database: a query on trips, 1 row.");
    expect(page.html).toContain("PostHog returned 1,092");
    expect(page.html).toContain("and docs.");
  });

  it("drops lines addressed to the founder and a leading Yes./No.", () => {
    const page = renderReportPage({
      ...base,
      block: { kind: "table", title: "t", columns: ["Month", "N"], rows: [["July", "1"]] },
      summary:
        "**Yes. The core path is tracked.** More here.\n\nBody stays.\n\n**Recommended next action:** Reply \"spec\" and I'll write it.\n\nRecommended next action: reply yes and I'll have the engineer do it.\n\n- If you reply go and I'll launch it",
    })!;
    expect(page.html).toContain("<strong>The core path is tracked.</strong>");
    expect(page.html).not.toMatch(/Yes\./);
    expect(page.html).toContain("Body stays.");
    expect(page.html).not.toMatch(/Recommended next action|I&#39;ll|I'll/);
  });

  it("names the company in the top line, escaped, and carries an escaped description", () => {
    const page = renderReportPage({
      ...base,
      block: { kind: "table", title: "t", columns: ["Month", "N"], rows: [["July", "1"]] },
      summary: 'Signups "fell" <b>a lot</b> this month.',
      company: 'Acme <script>"x"</script>',
    })!;
    expect(page.html).toContain('<p class="eyebrow">Shared by Acme &lt;script&gt;&quot;x&quot;&lt;/script&gt;');
    expect(page.html).toContain('<meta name="description" content="Signups &quot;fell&quot; &lt;b&gt;a lot&lt;/b&gt; this month.">');
    expect(page.html).not.toMatch(/<script|<b>/);
    expect(page.html).not.toContain("Made with Zavi");
  });

  it("drops the chart when the text gives a different count for the same step", () => {
    const block = {
      kind: "table" as const,
      title: "Guests by booking step",
      columns: ["Step", "Guests"],
      rows: [["Started booking", "4639"], ["Booking created", "600"]],
    };
    const bad = renderReportPage({ ...base, block, summary: "The booking-created count (1,092) lines up with the database." })!;
    expect(bad.html).not.toContain("<svg");
    expect(bad.html).toContain("don&#39;t match the text");
    const ok = renderReportPage({ ...base, block, summary: "Booking created was 600 this month." })!;
    expect(ok.html).toContain("<svg");
    expect(ok.html).not.toContain("match the text");
    expect(ok.html).toContain(">4,639<");
  });

  it("drops the chart when a charted value came only from a code search", () => {
    const page = renderReportPage({
      ...base,
      block: { kind: "table", title: "Funnel", columns: ["Step", "Guests"], rows: [["Viewed", "4639"], ["Booked", "600"]] },
      summary: "",
      sources: "**Where these numbers came from.** x\n1. PostHog (call 1) returned 4,639\n2. GitHub: code search (call 2) returned 600",
    })!;
    expect(page.html).not.toContain("<svg");
  });

  it("notes that steps aren't a strict sequence when a later step is larger", () => {
    const block = { kind: "table" as const, title: "t", columns: ["Step", "Web"], rows: [["Started", "100"], ["ID check", "120"], ["Done", "50"]] };
    expect(renderReportPage({ ...base, block, summary: "" })!.html).toContain("aren&#39;t a strict sequence");
    const shrinking = { ...block, rows: [["Started", "100"], ["Done", "50"]] };
    expect(renderReportPage({ ...base, block: shrinking, summary: "" })!.html).not.toContain("strict sequence");
    const said = renderReportPage({ ...base, block, summary: "Counts aren't a strict sequence, by the way." })!.html;
    expect(said.split("<body>")[1].match(/strict sequence/g)).toHaveLength(1);
  });

  it("keeps real content the founder-line and link rules would otherwise eat", () => {
    const page = renderReportPage({
      ...base,
      block: { kind: "table", title: "t", columns: ["Month", "N"], rows: [["July", "1"]] },
      summary:
        "No. 1 source of sign-ups is search.\n\nNext action taken: checkout.\n\nThe CTA says \"Reply YES and I'll send it\" today.\n\nRead [the guide](<https://example.com/a b>) or [x](/w?q=(1)).",
    })!;
    expect(page.html).toContain("No. 1 source");
    expect(page.html).toContain("Next action taken: checkout.");
    expect(page.html).toContain("The CTA says &quot;Reply YES");
    expect(page.html).toContain("Read the guide or.");
    expect(page.html).not.toContain("/w?q");
  });

  it("renders a GFM table without outer pipes", () => {
    const html = renderReportPage({
      ...base,
      block: { kind: "table", title: "t", columns: ["Month", "N"], rows: [["July", "1"]] },
      summary: "Priority | Gap\n--- | ---\nHigh | Checkout",
    })!.html;
    expect(html).toContain("<td>High</td><td>Checkout</td>");
  });

  it("does not flag a chart on a word inside another word, a duration, or a split total", () => {
    const block = { kind: "table" as const, title: "Users by step", columns: ["Step", "Web", "iOS"], rows: [["Signed up", "900", "300"], ["Paid", "600", "492"]] };
    for (const summary of ["Unpaid users: 500.", "Paid over 30 days was strong.", "Paid came to 1,092 across both."]) {
      expect(renderReportPage({ ...base, block, summary })!.html).toContain("<svg");
    }
  });

  it("does not repeat the title as the table header of a chart block", () => {
    const page = renderReportPage({
      ...base,
      block: { kind: "chart", variant: "bar", title: "Guests by step", series: [{ label: "Viewed", value: 15673 }, { label: "Booked", value: 600 }] },
      summary: "",
    } as Parameters<typeof renderReportPage>[0])!;
    expect(page.html).not.toMatch(/<th[^>]*>Guests by step<\/th>/);
    expect(page.html).toContain(">15,673<");
  });
});
