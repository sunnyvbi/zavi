
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HumanJobsIsland } from "./HumanJobsIsland";
import { HumanJobDetailIsland, PaymentReturn } from "./HumanJobDetailIsland";
import { BookingTerms, CreatorBookingIsland, PRODUCT_NEEDED_LINE } from "./CreatorBookingIsland";
import type { CreatorBookingQuote } from "./creatorJobTypes";
import { CreatorMoneyLines, formatCents } from "./creatorMoney";

describe("the surfaces render", () => {
  it("the jobs list starts busy, not empty", () => {
    const html = renderToString(<HumanJobsIsland />);
    expect(html).toContain("Jobs");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("No jobs yet");
  });

  it("the jobs list links to the section's other tabs as real URLs", () => {
    const html = renderToString(<HumanJobsIsland />);
    expect(html).toContain('href="/humans/jobs"');
    expect(html).toContain('href="/humans/library"');
  });

  it("the job detail renders and deep-links back to Jobs", () => {
    const html = renderToString(
      <HumanJobDetailIsland orderId="22222222-2222-4222-8222-222222222222" />,
    );
    expect(html).toContain('href="/humans/jobs"');
  });

  it("survives a URL-hostile id and shows it in the breadcrumb", () => {
    const html = renderToString(<HumanJobDetailIsland orderId="a b/c" />);
    expect(html).toContain("a b/c");
    expect(html).toContain('aria-busy="true"');
  });

  it("the return-from-Stripe notice says charged for an offer or applicant, held for a booking", () => {
    const paid = (source: "offer" | "applicant" | "booking") =>
      renderToString(
        <PaymentReturn
          orderId="o-1"
          status="in_progress"
          source={source}
          onSettled={() => {}}
          result={{ state: "already_done", order_id: "o-1", status: "in_progress" }}
        />,
      );
    for (const s of ["offer", "applicant"] as const) {
      expect(paid(s)).toContain("charged and the job is in progress");
      expect(paid(s)).not.toContain("held, not charged");
    }
    expect(paid("booking")).toContain("held, not charged");
    expect(paid("booking")).toContain("72 hours to accept");
    const cancelled = renderToString(
      <PaymentReturn
        orderId="o-1"
        status="checkout_pending"
        source="offer"
        onSettled={() => {}}
        result={{ state: "already_done", order_id: "o-1", status: "cancelled" }}
      />,
    );
    expect(cancelled).toContain("not charged");
    expect(cancelled).not.toContain("has been charged");
  });

  it("encodes the order id into every API path it builds", () => {
    const src = readFileSync(join(DIR, "HumanJobDetailIsland.tsx"), "utf8");
    const built = src.match(/\/api\/humans\/orders\/\$\{[^}]+\}/g) ?? [];
    expect(built.length).toBeGreaterThanOrEqual(3);
    for (const m of built) {
      expect(m).toContain("encodeURIComponent");
    }
  });

  it("sends a rebook to the existing checkout door, with the id encoded", () => {
    const src = readFileSync(join(DIR, "HumanJobDetailIsland.tsx"), "utf8");
    const link = src.match(/\/humans\/book\?package_id=\$\{[^}]+\}/);
    expect(link, "the rebook link must exist").not.toBeNull();
    expect(link?.[0]).toContain("encodeURIComponent");
  });

  it("the booking screen renders before it has a quote", () => {
    const html = renderToString(
      <CreatorBookingIsland target={{ package_id: "44444444-4444-4444-4444-444444444444" }} />,
    );
    expect(html).toContain("Book a creator");
    expect(html).toContain("Back to Find creators");
    expect(html).toContain('href="/humans/creators"');
    expect(html).not.toContain("$0.00");
  });
});

describe("the pay screen's date and charge sentences", () => {
  const base = {
    creator: { display_name: "Nia" },
    accept_window: null,
    due_at: null,
    due_deadline: null,
    product_needed: true,
  } as unknown as CreatorBookingQuote;
  const html = (q: Partial<CreatorBookingQuote>) =>
    renderToString(<BookingTerms quote={{ ...base, ...q } as CreatorBookingQuote} dueAt="" onDueChange={() => {}} />);

  it("a product-needed quote (no due date) renders the product sentence and no date field", () => {
    const out = html({ charge_now_text: "Paying charges your card now and starts the job." });
    expect(out).toContain(PRODUCT_NEEDED_LINE.slice(0, 40));
    expect(out).not.toContain('id="due-at"');
  });

  it("a null accept window shows the quote's own charge sentence verbatim", () => {
    const offer = html({ charge_now_text: "OFFER SENTENCE" });
    expect(offer).toContain("OFFER SENTENCE");
    expect(offer).not.toContain("Hiring an applicant");
  });

  it("a blocked quote shows no charge sentence at all", () => {
    const out = html({
      charge_now_text: "OFFER SENTENCE",
      blocked: { code: "offer_not_agreed", message: "not yet" } as CreatorBookingQuote["blocked"],
    });
    expect(out).not.toContain("OFFER SENTENCE");
    expect(html({ charge_now_text: null })).not.toContain("charges your card");
  });

  it("a dated booking keeps the date field and the 72h hold sentence", () => {
    const out = html({
      due_at: "2026-10-01T12:00:00.000Z",
      due_deadline: { line: "DUE LINE" } as CreatorBookingQuote["due_deadline"],
      accept_window: { hours: 72, consequence_text: "If not, the hold is released." },
    });
    expect(out).toContain('id="due-at"');
    expect(out).toContain("DUE LINE");
    expect(out).toContain("held, not charged");
  });
});

describe("the money block shows price, fee and total, always all three", () => {
  const money = {
    currency: "usd",
    price_cents: 15_000,
    business_fee_cents: 1_500,
    business_total_cents: 16_500,
    business_fee_label: "10%",
  };

  it("prints exactly the numbers it is handed", () => {
    const html = renderToString(<CreatorMoneyLines money={money} creatorName="Maya" />);
    expect(html).toContain("$150.00");
    expect(html).toContain("$15.00");
    expect(html).toContain("$165.00");
    expect(html).toContain("Zavi fee (10%)");
    expect(html).toContain("Total charged to your card");
  });

  it("formats cents without ever doing fee arithmetic", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(1)).toBe("$0.01");
    expect(formatCents(99)).toBe("$0.99");
    expect(formatCents(100)).toBe("$1.00");
    expect(formatCents(16_500)).toBe("$165.00");
    expect(formatCents(1_234_567)).toBe("$12,345.67");
    expect(formatCents(-500)).toBe("-$5.00");
    expect(formatCents(16_500, "eur")).toBe("EUR 165.00");
  });
});

const DIR = __dirname;
const CREATOR_FILES = readdirSync(DIR).filter(
  (f) =>
    (f.startsWith("Creator") || f.startsWith("HumanJob") || f === "creatorMoney.tsx") &&
    (f.endsWith(".tsx") || f.endsWith(".ts")) &&
    !f.includes(".test."),
);

const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

describe("invariant 8: no fee arithmetic anywhere in the creator screens", () => {
  it("finds the files it is meant to be guarding", () => {
    expect(CREATOR_FILES.length).toBeGreaterThanOrEqual(4);
  });

  it("never multiplies or divides by a fee rate", () => {
    for (const f of CREATOR_FILES) {
      const src = stripComments(readFileSync(join(DIR, f), "utf8"));
      expect(src, `${f} must not carry a fee rate`).not.toMatch(
        /\*\s*0?\.1\b|\*\s*0?\.15\b|\b1000\s*\/\s*10000|\b1500\s*\/\s*10000/,
      );
      expect(src, `${f} must not carry a fee bps constant`).not.toMatch(
        /BUSINESS_FEE_BPS|CREATOR_FEE_BPS/,
      );
    }
  });

  it("divides by 100 in exactly one place, the formatter", () => {
    for (const f of CREATOR_FILES) {
      const src = stripComments(readFileSync(join(DIR, f), "utf8"));
      const divides = /\/\s*100\b/.test(src);
      if (divides) {
        expect(f, "only creatorMoney.tsx may turn cents into dollars").toBe(
          "creatorMoney.tsx",
        );
      }
    }
  });
});

describe("invariant 5: the screens never write their own deadline sentence", () => {
  it("renders deadline.line verbatim and never rebuilds the consequence", () => {
    for (const f of CREATOR_FILES) {
      const src = stripComments(readFileSync(join(DIR, f), "utf8"));
      for (const phrase of [
        "accepted automatically",
        "missed deadline mark",
        "the hold on the card is released",
        "10 day buffer",
      ]) {
        expect(src.toLowerCase(), `${f} must not restate: ${phrase}`).not.toContain(
          phrase.toLowerCase(),
        );
      }
      expect(src, `${f} must not format a deadline with toLocale*`).not.toMatch(
        /deadline[\s\S]{0,40}toLocale(Date|Time|)String/,
      );
    }
  });
});

describe("copy rule: no em dashes, en dashes or double hyphens on screen", () => {
  it("holds for every creator screen", () => {
    for (const f of CREATOR_FILES) {
      const raw = readFileSync(join(DIR, f), "utf8");
      expect(raw, `${f} contains an em or en dash`).not.toMatch(/[–—]/);
      expect(stripComments(raw), `${f} contains a double hyphen`).not.toContain("--");
    }
  });
});
