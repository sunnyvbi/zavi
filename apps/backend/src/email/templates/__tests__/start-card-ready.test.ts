import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/web-base", () => ({ webBaseUrl: () => "https://www.example.test" }));

import { renderStartCardReadyEmail, ringSides, scoreHeadline } from "../start-card";

const STRATEGY = "https://www.example.test/workspace?tab=growth-strategy";
const score = { total: 21, out_of: 80, by_check: { google: 0, ai: 0, seo: null, design: 11, compare: 10 } };
const diagnosis = {
  constraint: { check_key: "google" as const, title: "Hard to find in search & AI answers.", why: "x" },
  action_this_week: { title: "Answer one key customer question.", why: "Create a useful guide, then check the results." },
};

describe("renderStartCardReadyEmail", () => {
  it("draws the finished card: score, each check, the problem and the next step", () => {
    const r = renderStartCardReadyEmail({ domain: "acme.com", strategyUrl: STRATEGY, card: { score, diagnosis, companyName: "Acme Co" } });
    expect(r.subject).toBe("Your growth scorecard for acme.com: 21/80");
    expect(r.html).toContain("Your growth scorecard is ready.");
    expect(r.html).toContain("Acme Co &middot; acme.com");
    expect(r.html).toContain(">21<");
    expect(r.html).toContain(">/80<");
    expect(r.html).toContain("A clear place to start");
    expect(r.html).toContain("4 of 5 checks measured.<br>One check could not be measured.");
    expect(r.html).toContain("Design &amp; UX");
    expect(r.html).toContain("11/20");
    expect(r.html).toContain("0/20");
    expect(r.html).toContain("Not measured");
    expect(r.html).toContain("What needs attention");
    expect(r.html).toContain("Hard to find in search &amp; AI answers.");
    expect(r.html).toContain("Answer one key customer question.");
    expect(r.html).toContain("Create a useful guide, then check the results.");
    expect(r.html).toContain("https://www.example.test/email/scorecard/zavi-mascot.png");
    expect(r.text).toContain("- SEO & site basics: not measured");
    expect(r.text).toContain(`Open Zavi: ${STRATEGY}`);
  });

  it("sends the button to the growth strategy, not the public card page", () => {
    const r = renderStartCardReadyEmail({ domain: "acme.com", strategyUrl: STRATEGY, card: { score, diagnosis } });
    expect(r.html).toContain(`href="${STRATEGY}"`);
    expect(r.html).toContain("Open Zavi &rarr;");
    expect(r.html).not.toContain("/r/");
    expect(r.html).not.toContain("View my growth strategy");
  });

  it("escapes a company name and drops it when it only repeats the domain", () => {
    const hostile = renderStartCardReadyEmail({ domain: "acme.com", strategyUrl: STRATEGY, card: { score, diagnosis, companyName: "<b>Acme</b>" } });
    expect(hostile.html).toContain("&lt;b&gt;Acme&lt;/b&gt; &middot; acme.com");
    expect(hostile.html).not.toContain("<b>Acme</b>");
    const same = renderStartCardReadyEmail({ domain: "acme.com", strategyUrl: STRATEGY, card: { score, diagnosis, companyName: "ACME.com" } });
    expect(same.html).not.toContain("&middot; acme.com");
  });

  it("keeps the required footer and the neutral variant", () => {
    const r = renderStartCardReadyEmail({ domain: "acme.com", strategyUrl: STRATEGY, card: { score, diagnosis } });
    expect(r.html).toContain("You received this email because you requested a growth scorecard from Zavi.");
    expect(r.html).toContain("mailto:support@zaviagent.com");
    expect(r.html).not.toContain("Your growth, run by Zavi.");
  });

  it("falls back to the plain message without a score", () => {
    const r = renderStartCardReadyEmail({ domain: "acme.com", strategyUrl: STRATEGY });
    expect(r.subject).toBe("Your growth scorecard for acme.com is ready");
    expect(r.html).toContain("Open Zavi");
    expect(r.html).not.toContain("zavi-mascot.png");
  });

  it("picks the headline by the share of the measured total", () => {
    expect(scoreHeadline({ ...score, total: 21 })).toBe("A clear place to start");
    expect(scoreHeadline({ ...score, total: 40 })).toBe("Good bones, clear gaps");
    expect(scoreHeadline({ ...score, total: 60 })).toBe("A strong base to build on");
  });

  it("fills the ring by quarters, with any score above zero showing one", () => {
    const filled = (total: number) => ringSides({ ...score, total }).filter((c) => c === "#3b82f6").length;
    expect(filled(0)).toBe(0);
    expect(filled(1)).toBe(1);
    expect(filled(21)).toBe(1);
    expect(filled(40)).toBe(2);
    expect(filled(80)).toBe(4);
  });
});
