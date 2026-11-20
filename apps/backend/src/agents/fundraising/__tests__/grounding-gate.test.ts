import { describe, it, expect } from "vitest";
import { __test__ } from "../post-run";
import type { FundraisingInvestor } from "../output-schema";

const {
  groundAndDedupInvestors,
  canonicalFirm,
  dedupKey,
  buildCsv,
  renderTieredMarkdown,
  firmDistinctiveness,
  passesFirmContextGuard,
} = __test__;

function inv(over: Partial<FundraisingInvestor>): FundraisingInvestor {
  return {
    firm: "Firm",
    name: "",
    tier: 1,
    focus: "",
    stage_focus: "",
    check_size: "",
    fit_rationale: "fits",
    contact_hint: "",
    suggested_message: "",
    source: "investor_db",
    source_url: "",
    evidence_text: "",
    source_kind: "investor_directory",
    evidence_span: "",
    ...over,
  };
}

const PAGE_BY_URL: Record<string, string> = {
  "https://northwind.vc/portfolio":
    "<untrusted_web_content>\nNorthwind Capital led the $1.5M seed round in MobilityCo, an adjacent marketplace. Our portfolio focuses on seed-stage mobility startups.\n</untrusted_web_content>",
  "https://acme.vc/portfolio":
    "<untrusted_web_content>\nAcme Ventures backs seed-stage marketplaces and led a recent round in an adjacent company. Acme invests at seed.\n</untrusted_web_content>",
  "https://technews.example/funding-roundup":
    "<untrusted_web_content>\nIn other venture news this week, Brightwater Partners closed a new seed fund and plans to invest in early-stage mobility companies across the region.\n</untrusted_web_content>",
  "https://citygov.example/news":
    "<untrusted_web_content>\nThe city council approved a new park near Foundation Capital Park downtown. Residents welcomed the green space and improved walkways.\n</untrusted_web_content>",
  "https://angellist.example/jane-smith":
    "<untrusted_web_content>\nJane Smith is an active angel investor who has backed several seed-stage marketplaces.\n</untrusted_web_content>",
  "https://genericfinance.example/news":
    "<untrusted_web_content>\nThe company closed an oversubscribed seed round this quarter from several funds.\n</untrusted_web_content>",
  "https://acme.vc/team":
    "<untrusted_web_content>\nAcme Ventures backs seed-stage marketplaces. Partner Janet leads the firm; it invests at seed and leads rounds.\n</untrusted_web_content>",
  "https://blognews.example/profile":
    "<untrusted_web_content>\nFounders Fund hosted a community dinner downtown last night where neighbors discussed local park renovations and the new library hours.\n</untrusted_web_content>",
  "https://townpaper.example/notice":
    "<untrusted_web_content>\nCapital opened a new bakery on Main Street this weekend and residents lined up for fresh bread and pastries.\n</untrusted_web_content>",
  "https://riverstone.vc/team":
    "<untrusted_web_content>\nRiverstone Capital backs seed-stage marketplaces. Partner Dana Lee leads the firm's mobility investments at seed.\n</untrusted_web_content>",
};
const getText = (url: string): string | null => PAGE_BY_URL[url] ?? null;

describe("fundraising grounding gate — web FIRM rows (web-yield relaxation 2026-06-08)", () => {
  it("KEEPS a firm on its OWN domain with PARAPHRASED evidence (counts evidence_paraphrased)", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Northwind Capital",
          name: "",
          source: "web",
          source_url: "https://northwind.vc/portfolio",
          evidence_text: "Northwind backs seed-stage mobility companies",
          evidence_span: "Northwind Capital led the $1.5M seed round in MobilityCo, an adjacent marketplace.",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
    expect(r.evidenceParaphrased).toBe(1);
  });

  it("KEEPS a distinctive firm grounded by LOCAL_CONTEXT on a non-official page", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Brightwater Partners",
          name: "",
          source: "web",
          source_url: "https://technews.example/funding-roundup",
          evidence_text: "Brightwater closed a new seed fund to invest in mobility",
          evidence_span: "Brightwater Partners closed a new seed fund and plans to invest in early-stage mobility companies",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("DROPS a GENERIC firm ('Foundation Capital') matched incidentally on a non-investor page", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Foundation Capital",
          name: "",
          source: "web",
          source_url: "https://citygov.example/news",
          evidence_text: "approved a new park near Foundation Capital Park downtown",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
    expect(r.webVerified).toBe(0);
  });

  it("DROPS a fabricated firm not present on the fetched page", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Fabricated Partners",
          name: "",
          source: "web",
          source_url: "https://acme.vc/portfolio",
          evidence_text: "backs seed-stage marketplaces and led a recent round",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("KEEPS a firm row whose firm is on the page even when the claimed partner is NOT", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Acme Ventures",
          name: "Nonexistent Partner",
          source: "web",
          source_url: "https://acme.vc/portfolio",
          evidence_text: "Acme Ventures backs seed-stage marketplaces",
          evidence_span: "Acme Ventures backs seed-stage marketplaces and led a recent round in an adjacent company.",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("does NOT count evidence_paraphrased when evidence_text is verbatim on the page", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Acme Ventures",
          name: "",
          source: "web",
          source_url: "https://acme.vc/portfolio",
          evidence_text: "Acme Ventures backs seed-stage marketplaces",
          evidence_span: "Acme Ventures backs seed-stage marketplaces and led a recent round in an adjacent company.",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.evidenceParaphrased).toBe(0);
  });

  it("DROPS a firm row that cites a page the run never fetched", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Northwind Capital",
          source: "web",
          source_url: "https://never-fetched.example/page",
          evidence_text: "Northwind Capital invests in marketplaces",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("DROPS a firm row with too-short / missing evidence_text", () => {
    const tooShort = groundAndDedupInvestors(
      [
        inv({
          firm: "Northwind Capital",
          source: "web",
          source_url: "https://northwind.vc/portfolio",
          evidence_text: "led",
        }),
      ],
      getText,
    );
    expect(tooShort.kept).toHaveLength(0);
    expect(tooShort.webDropped).toBe(1);

    const missingUrl = groundAndDedupInvestors(
      [
        inv({
          firm: "Northwind Capital",
          source: "web",
          source_url: "",
          evidence_text: "Northwind Capital led the $1.5M seed round",
        }),
      ],
      getText,
    );
    expect(missingUrl.kept).toHaveLength(0);
    expect(missingUrl.webDropped).toBe(1);
  });

  it("evidenceSoftMatch returns no-match when evidence shares nothing with the page", () => {
    const { evidenceSoftMatch } = __test__;
    const page = "northwind capital led the seed round in a mobility company";
    const r = evidenceSoftMatch(
      "quarterly bakery revenue grew overseas",
      page,
      "absentfirm",
      "absentfirm",
    );
    expect(r.matched).toBe(false);
  });
});

describe("fundraising grounding gate — firm-name self-context exclusion (FIX 1/2)", () => {
  it("DROPS a distinctive firm whose ONLY investor-term text is its own name ('Founders Fund')", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Founders Fund",
          name: "",
          source: "web",
          source_url: "https://blognews.example/profile",
          evidence_text: "Founders Fund hosted a community dinner downtown",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
    expect(r.webVerified).toBe(0);
  });

  it("firmHasLocalInvestorContext is FALSE when the only investor term is inside the firm name", () => {
    const { passesFirmContextGuard } = __test__;
    const normPage =
      "founders fund hosted a community dinner downtown last night where neighbors discussed local park renovations and the new library hours.";
    expect(
      passesFirmContextGuard(
        "Founders Fund",
        canonicalFirm("Founders Fund"),
        "https://blognews.example/profile",
        normPage,
      ),
    ).toBe(false);
  });

  it("DROPS a GENERIC firm ('Capital') whose only 'capital' text is its own name", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Capital",
          name: "",
          source: "web",
          source_url: "https://townpaper.example/notice",
          evidence_text: "Capital opened a new bakery on Main Street",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
    expect(r.webVerified).toBe(0);
  });

  it("passesFirmContextGuard FALSE for generic 'Capital' self-context only", () => {
    const { passesFirmContextGuard } = __test__;
    const normPage =
      "capital opened a new bakery on main street this weekend and residents lined up for fresh bread and pastries.";
    expect(
      passesFirmContextGuard(
        "Capital",
        canonicalFirm("Capital"),
        "https://townpaper.example/notice",
        normPage,
      ),
    ).toBe(false);
  });
});

describe("fundraising grounding gate — punctuation-robust firm-token blanking (2026-06-08 residual)", () => {
  const { passesFirmContextGuard } = __test__;

  it("DROPS punctuation-separated 'Founders-Fund' whose only investor terms are its own name", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Founders-Fund",
          name: "",
          source: "web",
          source_url: "https://blognews.example/profile",
          evidence_text: "Founders Fund hosted a community dinner downtown",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
    expect(r.webVerified).toBe(0);
  });

  it("passesFirmContextGuard FALSE for hyphenated 'Founders-Fund' with name-only investor text", () => {
    const normPage =
      "founders fund hosted a community dinner downtown last night where neighbors discussed local park renovations and the new library hours.";
    expect(
      passesFirmContextGuard(
        "Founders-Fund",
        canonicalFirm("Founders-Fund"),
        "https://blognews.example/profile",
        normPage,
      ),
    ).toBe(false);
  });

  it("KEEPS 'Sequoia Capital' on its own domain with real investor context outside the name", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Sequoia Capital",
          name: "",
          source: "web",
          source_url: "https://sequoiacap.com/portfolio",
          evidence_text: "Sequoia Capital backs seed-stage marketplaces",
          evidence_span: "Sequoia Capital backs seed-stage marketplaces and led recent rounds.",
        }),
      ],
      (url: string) =>
        url === "https://sequoiacap.com/portfolio"
          ? "<untrusted_web_content>\nSequoia Capital backs seed-stage marketplaces and led recent rounds.\n</untrusted_web_content>"
          : getText(url),
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("KEEPS a distinctive firm on a 3rd-party page with investor terms outside the name (LOCAL_CONTEXT)", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Brightwater Partners",
          name: "",
          source: "web",
          source_url: "https://technews.example/funding-roundup",
          evidence_text: "Brightwater closed a new seed fund to invest in mobility",
          evidence_span: "Brightwater Partners closed a new seed fund and plans to invest in early-stage mobility companies",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });
});

describe("distinctiveTokenInHost bounded host-segment match (FIX 3)", () => {
  const { passesFirmContextGuard } = __test__;
  const nonInvestorPage = "sequoia trees grow tall in the national forest preserve.";

  it("OFFICIAL_DOMAIN FALSE when token is an interior substring ('notsequoia.com')", () => {
    expect(
      passesFirmContextGuard(
        "Sequoia",
        canonicalFirm("Sequoia"),
        "https://notsequoia.com/page",
        nonInvestorPage,
      ),
    ).toBe(false);
  });

  it("OFFICIAL_DOMAIN TRUE when a host segment STARTS WITH the token ('sequoiacap.com')", () => {
    expect(
      passesFirmContextGuard(
        "Sequoia",
        canonicalFirm("Sequoia"),
        "https://sequoiacap.com/team",
        nonInvestorPage,
      ),
    ).toBe(true);
  });

  it("OFFICIAL_DOMAIN TRUE when a host segment EQUALS the token ('sequoia.com')", () => {
    expect(
      passesFirmContextGuard(
        "Sequoia",
        canonicalFirm("Sequoia"),
        "https://sequoia.com/portfolio",
        nonInvestorPage,
      ),
    ).toBe(true);
  });
});

describe("fundraising grounding gate — unverified partner name blanking (FIX 4)", () => {
  it("KEEPS a verified firm but BLANKS the partner name when the partner is NOT on the page", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Riverstone Capital",
          name: "Ghostly McNotreal",
          source: "web",
          source_url: "https://riverstone.vc/team",
          evidence_text: "Riverstone Capital backs seed-stage marketplaces",
          evidence_span: "Riverstone Capital backs seed-stage marketplaces. Partner Dana Lee leads the firm's mobility investments at seed.",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
    expect(r.kept[0].name).toBe("");
  });

  it("RETAINS the partner name when it DOES appear bounded on the page", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Riverstone Capital",
          name: "Dana Lee",
          source: "web",
          source_url: "https://riverstone.vc/team",
          evidence_text: "Riverstone Capital backs seed-stage marketplaces",
          evidence_span: "Riverstone Capital backs seed-stage marketplaces. Partner Dana Lee leads the firm's mobility investments at seed.",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.kept[0].name).toBe("Dana Lee");
  });
});

describe("fundraising grounding gate — pre-blank dedup key (P1-3)", () => {
  it("KEEPS two distinct unverified partners at the same firm (both blanked, not collapsed)", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Riverstone Capital",
          name: "Ghostly McNotreal",
          source: "web",
          source_url: "https://riverstone.vc/team",
          evidence_text: "Riverstone Capital backs seed-stage marketplaces",
          evidence_span:
            "Riverstone Capital backs seed-stage marketplaces. Partner Dana Lee leads the firm's mobility investments at seed.",
        }),
        inv({
          firm: "Riverstone Capital",
          name: "Phantom Nobody",
          source: "web",
          source_url: "https://riverstone.vc/team",
          evidence_text: "Riverstone Capital backs seed-stage marketplaces",
          evidence_span:
            "Riverstone Capital backs seed-stage marketplaces. Partner Dana Lee leads the firm's mobility investments at seed.",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(2);
    expect(r.merged).toBe(0);
    expect(r.kept.every((k) => k.name === "")).toBe(true);
  });

  it("still dedupes two truly-identical no-name rows for the same firm", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Riverstone Capital",
          name: "",
          source: "web",
          source_url: "https://riverstone.vc/team",
          evidence_text: "Riverstone Capital backs seed-stage marketplaces",
          evidence_span:
            "Riverstone Capital backs seed-stage marketplaces. Partner Dana Lee leads the firm's mobility investments at seed.",
        }),
        inv({
          firm: "Riverstone Capital",
          name: "",
          source: "web",
          source_url: "https://riverstone.vc/team",
          evidence_text: "Riverstone Capital backs seed-stage marketplaces",
          evidence_span:
            "Riverstone Capital backs seed-stage marketplaces. Partner Dana Lee leads the firm's mobility investments at seed.",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.merged).toBe(1);
  });
});

describe("fundraising role predicate — bare 'by' removed (P1-2)", () => {
  const { spanReadsLikeInvestorEntry } = __test__;

  it("REJECTS a 'founded by <Firm>' span (firm is the founder, not the investor)", () => {
    expect(
      spanReadsLikeInvestorEntry(
        "the startup mobilityco was founded by northwind in 2021 and builds marketplaces",
        "northwind",
      ),
    ).toBe(false);
  });

  it("KEEPS a 'led by <Firm>' span (firm led the round = investor)", () => {
    expect(
      spanReadsLikeInvestorEntry(
        "the seed round was led by northwind capital this spring",
        "northwind",
      ),
    ).toBe(true);
  });

  it("KEEPS a 'lead investor <Firm>' span (bare 'investor' cue preserved)", () => {
    expect(
      spanReadsLikeInvestorEntry(
        "northwind is the lead investor in mobilityco and backs seed startups",
        "northwind",
      ),
    ).toBe(true);
  });
});

describe("firmDistinctiveness", () => {
  it("computes the longest remaining token after suffix-strip", () => {
    expect(firmDistinctiveness("Northwind Capital").token).toBe("northwind");
    expect(firmDistinctiveness("Acme Ventures").token).toBe("acme");
    expect(firmDistinctiveness("Brightwater Partners").token).toBe("brightwater");
  });

  it("flags GENERIC firms (distinctive token < 5, a suffix/common word, or none)", () => {
    expect(firmDistinctiveness("Foundation Capital").generic).toBe(true);
    expect(firmDistinctiveness("Capital").generic).toBe(true);
    expect(firmDistinctiveness("First Round").generic).toBe(true);
    expect(firmDistinctiveness("VC").generic).toBe(true);
    expect(firmDistinctiveness("Signal").generic).toBe(true);
  });

  it("flags DISTINCTIVE firms", () => {
    expect(firmDistinctiveness("Northwind Capital").generic).toBe(false);
    expect(firmDistinctiveness("Brightwater Partners").generic).toBe(false);
    expect(firmDistinctiveness("Sequoia").generic).toBe(false);
  });
});

describe("passesFirmContextGuard", () => {
  it("GENERIC firm needs BOTH official-domain AND local-context", () => {
    const normPage =
      "the city council approved a new park near foundation capital park downtown.";
    expect(
      passesFirmContextGuard(
        "Foundation Capital",
        canonicalFirm("Foundation Capital"),
        "https://citygov.example/news",
        normPage,
      ),
    ).toBe(false);
  });

  it("DISTINCTIVE firm passes on local-context ALONE (no official domain)", () => {
    const normPage =
      "in other venture news this week, brightwater partners closed a new seed fund and plans to invest in mobility.";
    expect(
      passesFirmContextGuard(
        "Brightwater Partners",
        canonicalFirm("Brightwater Partners"),
        "https://technews.example/funding-roundup",
        normPage,
      ),
    ).toBe(true);
  });

  it("DISTINCTIVE firm passes on official-domain ALONE (no investor terms nearby)", () => {
    const normPage = "northwind builds bridges and roads for the county.";
    expect(
      passesFirmContextGuard(
        "Northwind Capital",
        canonicalFirm("Northwind Capital"),
        "https://northwind.vc/portfolio",
        normPage,
      ),
    ).toBe(true);
  });
});

describe("fundraising DB provenance gate (FIX 1)", () => {
  it("a LEDGER-VERIFIED DB row passes (no source_url / evidence needed)", () => {
    const isDbVerified = (firm: string) => canonicalFirm(firm) === "acme";
    const r = groundAndDedupInvestors(
      [inv({ firm: "Acme Ventures", name: "Jane" })],
      getText,
      isDbVerified,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.dbCount).toBe(1);
    expect(r.webVerified).toBe(0);
  });

  it("missing/default source is treated as a DB row (and trusted when ledger-verified)", () => {
    const legacy = {
      ...inv({ firm: "Legacy" }),
      source: undefined,
    } as unknown as FundraisingInvestor;
    const isDbVerified = (firm: string) => canonicalFirm(firm) === "legacy";
    const r = groundAndDedupInvestors([legacy], getText, isDbVerified);
    expect(r.kept).toHaveLength(1);
    expect(r.dbCount).toBe(1);
  });

  it("DROPS an investor_db-labeled row NOT in the DB ledger with no evidence", () => {
    const isDbVerified = (firm: string) => canonicalFirm(firm) === "real";
    const r = groundAndDedupInvestors(
      [inv({ firm: "Fabricated Capital", name: "Ghost", source: "investor_db" })],
      getText,
      isDbVerified,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.provenanceDropped).toBe(1);
    expect(r.dbCount).toBe(0);
  });

  it("KEEPS an investor_db-labeled row that IS in the DB ledger", () => {
    const isDbVerified = (firm: string) => canonicalFirm(firm) === "real";
    const r = groundAndDedupInvestors(
      [inv({ firm: "Real Capital", name: "Pat", source: "investor_db" })],
      getText,
      isDbVerified,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.dbCount).toBe(1);
    expect(r.provenanceDropped).toBe(0);
  });

  it("recovers an unverified-DB row IF it can pass the web-evidence gate", () => {
    const isDbVerified = () => false;
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Northwind Capital",
          name: "",
          source: "investor_db",
          source_url: "https://northwind.vc/portfolio",
          evidence_text: "Northwind Capital led the $1.5M seed round",
          evidence_span: "Northwind Capital led the $1.5M seed round in MobilityCo, an adjacent marketplace.",
        }),
      ],
      getText,
      isDbVerified,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.provenanceDropped).toBe(0);
  });

  it("FAILS CLOSED on empty ledger: an unverified investor_db row with no evidence is DROPPED", () => {
    const r = groundAndDedupInvestors(
      [inv({ firm: "Acme Ventures", name: "Jane", source: "investor_db" })],
      getText,
      () => false,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.dbCount).toBe(0);
    expect(r.provenanceDropped).toBe(1);
  });
});

describe("fundraising grounding gate — ANGEL rows (unchanged)", () => {
  it("KEEPS an angel row (no firm) with a real multi-token person name on the page", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "",
          name: "Jane Smith",
          source: "web",
          source_url: "https://angellist.example/jane-smith",
          evidence_text:
            "is an active angel investor who has backed several seed-stage marketplaces",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("DROPS an angel row whose name is a single real page word", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "",
          name: "marketplaces",
          source: "web",
          source_url: "https://angellist.example/jane-smith",
          evidence_text:
            "is an active angel investor who has backed several seed-stage marketplaces",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("DROPS an angel row whose name is a finance phrase ('Seed Round') even when on the page", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "",
          name: "Seed Round",
          source: "web",
          source_url: "https://genericfinance.example/news",
          evidence_text:
            "closed an oversubscribed seed round this quarter from several funds",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("DROPS an angel row whose evidence_text is NOT verbatim on the page", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "",
          name: "Jane Smith",
          source: "web",
          source_url: "https://angellist.example/jane-smith",
          evidence_text: "Jane Smith invests in fintech across Europe and Asia",
        }),
      ],
      getText,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });
});

describe("fundraising dedup canonical key", () => {
  it("strips trailing noise tokens (ventures/capital/vc/partners/...)", () => {
    expect(canonicalFirm("Acme Ventures")).toBe("acme");
    expect(canonicalFirm("Acme Capital")).toBe("acme");
    expect(canonicalFirm("Acme VC")).toBe("acme");
    expect(canonicalFirm("Acme Capital Partners")).toBe("acme");
    expect(canonicalFirm("Founders Fund")).toBe("founders");
    expect(canonicalFirm("A16Z LLC")).toBe("a16z");
  });

  it("dedupKey combines canonical firm + normalized partner name", () => {
    expect(dedupKey(inv({ firm: "Acme Ventures", name: "Jane Partner" }))).toBe(
      "acme|jane partner",
    );
    expect(dedupKey(inv({ firm: "Acme Capital", name: "JANE  PARTNER" }))).toBe(
      "acme|jane partner",
    );
  });

  it("on a DB-vs-web collision, PREFERS the DB row and counts a merge", () => {
    const db = inv({
      firm: "Acme Capital",
      name: "Janet",
      source: "investor_db",
      contact_hint: "acme.vc",
    });
    const web = inv({
      firm: "Acme Ventures",
      name: "Janet",
      source: "web",
      source_url: "https://acme.vc/team",
      evidence_text: "Acme Ventures backs seed-stage marketplaces",
      evidence_span: "Acme Ventures backs seed-stage marketplaces. Partner Janet leads the firm; it invests at seed and leads rounds.",
      contact_hint: "web-hint",
    });
    const isDbVerified = (firm: string) => canonicalFirm(firm) === "acme";
    const r = groundAndDedupInvestors([web, db], getText, isDbVerified);
    expect(r.kept).toHaveLength(1);
    expect(r.merged).toBe(1);
    expect(r.kept[0].source).toBe("investor_db");
    expect(r.kept[0].contact_hint).toBe("acme.vc");
  });
});

describe("fundraising CSV omits provenance", () => {
  it("does not export Source / Source URL columns or any investor_db/web value", () => {
    const csv = buildCsv([
      inv({ firm: "DBFirm", tier: 1, source: "investor_db", source_url: "" }),
      inv({
        firm: "WebFirm",
        tier: 2,
        source: "web",
        source_url: "https://x.example/p",
      }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "Tier,Firm,Name,Focus,Stage,Check Size,Fit Rationale,Contact,Suggested Message",
    );
    expect(lines[0]).not.toContain("Source");
    expect(csv).not.toContain("investor_db");
    expect(csv).not.toContain("https://x.example/p");
  });
});

describe("fundraising rebuilt chat markdown (FIX 3)", () => {
  it("lists only the kept investors, tiered, with a dropped-count footer", () => {
    const kept = [
      inv({ firm: "Northwind Capital", name: "Sam", tier: 1, fit_rationale: "thesis fit" }),
      inv({ firm: "Acme Ventures", name: "Jane", tier: 2, source: "web" }),
    ];
    const md = renderTieredMarkdown(kept, 3);
    expect(md).toContain("Northwind Capital");
    expect(md).toContain("Sam");
    expect(md).toContain("Acme Ventures");
    expect(md).toContain("Tier 1");
    expect(md).toContain("Tier 2");
    expect(md).not.toContain("(investor_db)");
    expect(md).not.toContain("(web)");
    expect(md).toContain("3 web-discovered investors were dropped");
  });

  it("does NOT mention a dropped/fabricated firm that's absent from kept", () => {
    const kept = [inv({ firm: "Real Capital", name: "Pat", tier: 1 })];
    const md = renderTieredMarkdown(kept, 1);
    expect(md).toContain("Real Capital");
    expect(md).not.toContain("Fabricated");
    expect(md).toContain("1 web-discovered investor was dropped");
  });

  it("prepends a Stage header (+ rationale) when stage is provided", () => {
    const kept = [inv({ firm: "Real Capital", name: "Pat", tier: 1 })];
    const md = renderTieredMarkdown(kept, 1, "Pre-seed", "pre-revenue, ~$1.5M target");
    expect(md).toContain("**Stage: Pre-seed**");
    expect(md).toContain("pre-revenue, ~$1.5M target");
    expect(md.indexOf("Stage: Pre-seed")).toBeLessThan(md.indexOf("Investor shortlist"));
    expect(md).toContain("tell me and I'll re-tier");
  });

  it("omits the Stage header cleanly when no stage is provided", () => {
    const kept = [inv({ firm: "Real Capital", name: "Pat", tier: 1 })];
    const md = renderTieredMarkdown(kept, 1);
    expect(md).not.toContain("Stage:");
    expect(md.startsWith("## Investor shortlist")).toBe(true);
  });
});

describe("fundraising grounding gate — ROLE PREDICATE (source_kind + evidence_span)", () => {
  const DIR_PAGE =
    "<untrusted_web_content>\nInvestor directory. Northwind Capital invests in seed-stage mobility and leads rounds. Our portfolio company MobilityCo, a marketplace MobilityCo was founded in 2021 by a small local team.\n</untrusted_web_content>";
  const getDir = (url: string): string | null =>
    url === "https://dir.example/investors" ? DIR_PAGE : null;

  it("DROPS a portfolio-company name (not an investor) lifted off a directory page", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "MobilityCo",
          name: "",
          source: "web",
          source_url: "https://dir.example/investors",
          evidence_text: "MobilityCo, a marketplace MobilityCo was founded in 2021",
          evidence_span: "Our portfolio company MobilityCo, a marketplace MobilityCo was founded in 2021 by a small local team.",
          source_kind: "investor_directory",
        }),
      ],
      getDir,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("KEEPS a real investor entry on a directory page", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Northwind Capital",
          name: "",
          source: "web",
          source_url: "https://dir.example/investors",
          evidence_text: "Northwind Capital invests in seed-stage mobility and leads rounds",
          evidence_span: "Northwind Capital invests in seed-stage mobility and leads rounds.",
          source_kind: "investor_directory",
        }),
      ],
      getDir,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("DROPS a web row whose source_kind is portfolio_or_news", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Northwind Capital",
          name: "",
          source: "web",
          source_url: "https://dir.example/investors",
          evidence_text: "Northwind Capital invests in seed-stage mobility and leads rounds",
          evidence_span: "Northwind Capital invests in seed-stage mobility and leads rounds.",
          source_kind: "portfolio_or_news",
        }),
      ],
      getDir,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("DROPS a web firm row with a missing source_kind", () => {
    const row = inv({
      firm: "Northwind Capital",
      source: "web",
      source_url: "https://dir.example/investors",
      evidence_text: "Northwind Capital invests in seed-stage mobility and leads rounds",
      evidence_span: "Northwind Capital invests in seed-stage mobility and leads rounds.",
    });
    (row as { source_kind?: unknown }).source_kind = undefined;
    const r = groundAndDedupInvestors([row], getDir);
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("DROPS a firm not present on the cited page (even with a valid source_kind)", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Fabricated Capital",
          source: "web",
          source_url: "https://dir.example/investors",
          evidence_text: "Fabricated Capital invests in seed-stage mobility",
          evidence_span: "Fabricated Capital invests in seed-stage mobility and leads rounds.",
          source_kind: "investor_directory",
        }),
      ],
      getDir,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("DROPS a web firm row whose evidence_span is not a real page substring", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Northwind Capital",
          source: "web",
          source_url: "https://dir.example/investors",
          evidence_text: "Northwind Capital invests in seed-stage mobility and leads rounds",
          evidence_span: "Northwind Capital is the best fund ever and totally invented this span",
          source_kind: "investor_directory",
        }),
      ],
      getDir,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("spanReadsLikeInvestorEntry: investor-role cue bound to the firm passes", () => {
    const { spanReadsLikeInvestorEntry } = __test__;
    expect(
      spanReadsLikeInvestorEntry("acme capital invests at seed; later founded a new program", "acme"),
    ).toBe(true);
    expect(
      spanReadsLikeInvestorEntry("portfolio company widgetco was founded by jane", "widgetco"),
    ).toBe(false);
    expect(
      spanReadsLikeInvestorEntry("mobilityco raised seed from northwind capital", "northwind"),
    ).toBe(true);
    expect(
      spanReadsLikeInvestorEntry("mobilityco raised seed from northwind capital", "mobilityco"),
    ).toBe(false);
  });
});

describe("fundraising grounding gate — ROLE PREDICATE firm-binding (FIX 1)", () => {
  const RAISED_FROM_PAGE =
    "<untrusted_web_content>\nFunding roundup. MobilityCo raised seed from Northwind Capital, an early-stage mobility investor. Northwind Capital invests in seed-stage marketplaces.\n</untrusted_web_content>";
  const getRaised = (url: string): string | null =>
    url === "https://news.example/roundup" ? RAISED_FROM_PAGE : null;

  it("DROPS a portfolio company in a 'raised … from' span (MobilityCo)", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "MobilityCo",
          name: "",
          source: "web",
          source_url: "https://news.example/roundup",
          evidence_text: "MobilityCo raised seed from Northwind Capital",
          evidence_span: "MobilityCo raised seed from Northwind Capital, an early-stage mobility investor.",
          source_kind: "investor_directory",
        }),
      ],
      getRaised,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("KEEPS the investor firm in the SAME 'raised … from' span (Northwind Capital)", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Northwind Capital",
          name: "",
          source: "web",
          source_url: "https://news.example/roundup",
          evidence_text: "Northwind Capital invests in seed-stage marketplaces",
          evidence_span: "MobilityCo raised seed from Northwind Capital, an early-stage mobility investor.",
          source_kind: "investor_directory",
        }),
      ],
      getRaised,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("DROPS a '<Startup> founded by <Person>' row", () => {
    const FOUNDED_PAGE =
      "<untrusted_web_content>\nWidgetWorks was founded by Jane Doe in 2021 and builds developer tools. The team is based in Austin.\n</untrusted_web_content>";
    const getFounded = (url: string): string | null =>
      url === "https://blog.example/widgetworks" ? FOUNDED_PAGE : null;
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "WidgetWorks",
          name: "",
          source: "web",
          source_url: "https://blog.example/widgetworks",
          evidence_text: "WidgetWorks was founded by Jane Doe in 2021",
          evidence_span: "WidgetWorks was founded by Jane Doe in 2021 and builds developer tools.",
          source_kind: "investor_directory",
        }),
      ],
      getFounded,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("KEEPS a clean directory investor entry (no regression)", () => {
    const CLEAN_DIR =
      "<untrusted_web_content>\nInvestor directory. Brightwater Partners is a seed-stage venture fund that invests in marketplaces and leads rounds.\n</untrusted_web_content>";
    const getClean = (url: string): string | null =>
      url === "https://dir.example/clean" ? CLEAN_DIR : null;
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Brightwater Partners",
          name: "",
          source: "web",
          source_url: "https://dir.example/clean",
          evidence_text: "Brightwater Partners is a seed-stage venture fund that invests in marketplaces",
          evidence_span: "Brightwater Partners is a seed-stage venture fund that invests in marketplaces and leads rounds.",
          source_kind: "investor_directory",
        }),
      ],
      getClean,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });
});

describe("fundraising grounding gate — WEB-YIELD role-predicate fix (2026-06-24)", () => {
  const LISTICLE_PAGE =
    "<untrusted_web_content>\n" +
    "Top AI investors to watch in 2026. " +
    "The most-active AI check writers cluster around Khosla Ventures, AI Fund, AIX Ventures, Conviction. " +
    "View VC firm Glasswing Ventures 70 investments. " +
    "View VC firm Hyperplane Venture Capital 94 investments. " +
    "Portfolio highlights include Bluefield Capital, a payments software platform for clinics, alongside FleetOps and CareGrid. " +
    "MobilityCo raised $50M from AIX Ventures last spring. " +
    "Author: Riley Capital wrote this guide to top AI investors. " +
    "These funds invest at seed and lead rounds.\n" +
    "</untrusted_web_content>";
  const getList = (url: string): string | null =>
    url === "https://waveup.com/ai-investors" ? LISTICLE_PAGE : null;

  it("RECALL: KEEPS Glasswing Ventures from a 'View VC firm … N investments' listicle span", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Glasswing Ventures",
          name: "",
          source: "web",
          source_url: "https://waveup.com/ai-investors",
          evidence_text: "View VC firm Glasswing Ventures 70 investments",
          evidence_span: "View VC firm Glasswing Ventures 70 investments",
          source_kind: "investor_listicle",
        }),
      ],
      getList,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("RECALL: KEEPS Hyperplane Venture Capital from a 'View VC firm … N investments' listicle span", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Hyperplane Venture Capital",
          name: "",
          source: "web",
          source_url: "https://waveup.com/ai-investors",
          evidence_text: "View VC firm Hyperplane Venture Capital 94 investments",
          evidence_span: "View VC firm Hyperplane Venture Capital 94 investments",
          source_kind: "investor_listicle",
        }),
      ],
      getList,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("RESIDUAL (documented, out of scope): AIX Ventures (canon 'aix', 3 chars) stays dropped by the MIN_FIRM_MATCH_LEN floor", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "AIX Ventures",
          name: "",
          source: "web",
          source_url: "https://waveup.com/ai-investors",
          evidence_text:
            "the most-active AI check writers cluster around Khosla Ventures, AI Fund, AIX Ventures, Conviction",
          evidence_span:
            "The most-active AI check writers cluster around Khosla Ventures, AI Fund, AIX Ventures, Conviction.",
          source_kind: "investor_listicle",
        }),
      ],
      getList,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("PRECISION: DROPS MobilityCo from a 'MobilityCo raised $50M from AIX Ventures' receipt span", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "MobilityCo",
          name: "",
          source: "web",
          source_url: "https://waveup.com/ai-investors",
          evidence_text: "MobilityCo raised $50M from AIX Ventures",
          evidence_span: "MobilityCo raised $50M from AIX Ventures last spring.",
          source_kind: "investor_listicle",
        }),
      ],
      getList,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("PRECISION: DROPS Riley Capital from an 'Author: Riley Capital wrote this guide' byline", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Riley Capital",
          name: "",
          source: "web",
          source_url: "https://waveup.com/ai-investors",
          evidence_text: "Author: Riley Capital wrote this guide to top AI investors",
          evidence_span: "Author: Riley Capital wrote this guide to top AI investors.",
          source_kind: "investor_listicle",
        }),
      ],
      getList,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("PRECISION: DROPS Bluefield Capital from a 'Portfolio highlights include … a payments software platform' blurb", () => {
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Bluefield Capital",
          name: "",
          source: "web",
          source_url: "https://waveup.com/ai-investors",
          evidence_text:
            "Portfolio highlights include Bluefield Capital, a payments software platform for clinics",
          evidence_span:
            "Portfolio highlights include Bluefield Capital, a payments software platform for clinics, alongside FleetOps and CareGrid.",
          source_kind: "investor_listicle",
        }),
      ],
      getList,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("ANCHOR: DROPS a model-claimed investor_listicle row whose page server-classifies as portfolio_or_news", () => {
    const NEWS_PAGE =
      "<untrusted_web_content>\nBy Jane Reporter, published March 2026. Read more. MobilityCo, a startup, announced a new product. 5 min read. Comments below.\n</untrusted_web_content>";
    const getNews = (url: string): string | null =>
      url === "https://news.example/article" ? NEWS_PAGE : null;
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Northwind Capital",
          name: "",
          source: "web",
          source_url: "https://news.example/article",
          evidence_text: "MobilityCo, a startup, announced a new product",
          evidence_span: "MobilityCo, a startup, announced a new product.",
          source_kind: "investor_listicle",
        }),
      ],
      getNews,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("REGRESSION: KEEPS a legit investor whose span contains 'customer'/'software'/'is a … company' ('Glasswing is a venture firm backing customer-facing software companies')", () => {
    const SPAN =
      "Glasswing Ventures is a venture firm backing customer-facing software companies at seed.";
    const PAGE =
      "<untrusted_web_content>\n" +
      SPAN +
      " The firm invests at seed and leads rounds in marketplaces and ventures.\n" +
      "</untrusted_web_content>";
    const getPage = (url: string): string | null =>
      url === "https://glasswing.vc/about" ? PAGE : null;
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Glasswing Ventures",
          name: "",
          source: "web",
          source_url: "https://glasswing.vc/about",
          evidence_text: SPAN,
          evidence_span: SPAN,
          source_kind: "investor_listicle",
        }),
      ],
      getPage,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("REGRESSION: KEEPS a legit investor whose span contains 'customer' ('Northwind backs customer-facing companies')", () => {
    const SPAN =
      "Northwind Capital backs customer-facing companies and invests at seed and leads rounds.";
    const PAGE =
      "<untrusted_web_content>\n" +
      SPAN +
      " A seed-stage venture fund investing in marketplaces.\n" +
      "</untrusted_web_content>";
    const getPage = (url: string): string | null =>
      url === "https://northwind.vc/thesis" ? PAGE : null;
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Northwind Capital",
          name: "",
          source: "web",
          source_url: "https://northwind.vc/thesis",
          evidence_text: SPAN,
          evidence_span: SPAN,
          source_kind: "investor_listicle",
        }),
      ],
      getPage,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("REGRESSION: KEEPS a legit investor whose span contains 'a payments'/'a software' ('Riverstone invests in a payments-heavy sector and a software-first thesis')", () => {
    const SPAN =
      "Riverstone Capital invests in a payments-heavy sector and a software-first thesis at seed.";
    const PAGE =
      "<untrusted_web_content>\n" +
      SPAN +
      " The fund leads rounds in early-stage ventures and marketplaces.\n" +
      "</untrusted_web_content>";
    const getPage = (url: string): string | null =>
      url === "https://riverstone.vc/thesis" ? PAGE : null;
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Riverstone Capital",
          name: "",
          source: "web",
          source_url: "https://riverstone.vc/thesis",
          evidence_text: SPAN,
          evidence_span: SPAN,
          source_kind: "investor_listicle",
        }),
      ],
      getPage,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("ISSUE2: DROPS the TRIMMED Bluefield portfolio-blurb (no 'Portfolio highlights' prefix) via firm-name exclusion", () => {
    const SPAN = "Bluefield Capital, a payments software platform for clinics";
    const PAGE =
      "<untrusted_web_content>\n" +
      SPAN +
      ", alongside FleetOps and CareGrid in our portfolio.\n" +
      "</untrusted_web_content>";
    const getPage = (url: string): string | null =>
      url === "https://waveup.com/ai-investors" ? PAGE : null;
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Bluefield Capital",
          name: "",
          source: "web",
          source_url: "https://waveup.com/ai-investors",
          evidence_text: SPAN,
          evidence_span: SPAN,
          source_kind: "investor_listicle",
        }),
      ],
      getPage,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.webDropped).toBe(1);
  });

  it("ISSUE1: KEEPS 'Glasswing Ventures is a company that invests in early-stage AI startups' (weak is-a-company rescued by surrounding 'invests')", () => {
    const SPAN =
      "Glasswing Ventures is a company that invests in early-stage AI startups";
    const PAGE =
      "<untrusted_web_content>\n" +
      SPAN +
      " and leads seed rounds across marketplaces.\n" +
      "</untrusted_web_content>";
    const getPage = (url: string): string | null =>
      url === "https://waveup.com/ai-investors" ? PAGE : null;
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Glasswing Ventures",
          name: "",
          source: "web",
          source_url: "https://waveup.com/ai-investors",
          evidence_text: SPAN,
          evidence_span: SPAN,
          source_kind: "investor_listicle",
        }),
      ],
      getPage,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });

  it("ISSUE3: KEEPS a fund-profile span 'Our investments include Acme and Beta; we lead seed rounds' (marker removed)", () => {
    const SPAN =
      "Riverstone Capital — our investments include Acme and Beta; we lead seed rounds";
    const PAGE =
      "<untrusted_web_content>\n" +
      SPAN +
      " and partner with founders at the earliest stage.\n" +
      "</untrusted_web_content>";
    const getPage = (url: string): string | null =>
      url === "https://riverstone.vc/portfolio" ? PAGE : null;
    const r = groundAndDedupInvestors(
      [
        inv({
          firm: "Riverstone Capital",
          name: "",
          source: "web",
          source_url: "https://riverstone.vc/portfolio",
          evidence_text: SPAN,
          evidence_span: SPAN,
          source_kind: "fund_profile",
        }),
      ],
      getPage,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.webVerified).toBe(1);
    expect(r.webDropped).toBe(0);
  });
});
