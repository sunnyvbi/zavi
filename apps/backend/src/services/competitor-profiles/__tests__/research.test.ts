import { describe, expect, it } from "vitest";
import {
  extractCompetitorResearch,
  normalizeCompetitorWebsite,
} from "../research";

const report = {
  kind: "report",
  blocks: [
    {
      type: "competitive_table",
      rows: [
        {
          brand: "Acme Security",
          price: "$20 per seat",
          positioning: "Identity security for mid-market teams.",
          gap: "Limited partner ecosystem.",
          citations: [1],
        },
      ],
    },
    {
      type: "table",
      title: "Competitor profile fields",
      columns: ["Field", "Value"],
      rows: [
        ["industry", "Identity and access management"],
        ["target_audience", "Mid-market IT and security teams"],
        ["primary_acquisition_channels", "Paid search, Content, Partnerships"],
        ["threat_level", "High"],
      ],
      citations: [1, 2],
    },
  ],
  sources: [
    { n: 1, url: "https://acme.example/" },
    { n: 2, url: "https://example.org/acme-review" },
  ],
};

describe("competitor profile research extraction", () => {
  it("maps existing Research Agent blocks into the editable profile", () => {
    expect(extractCompetitorResearch(report, "https://acme.example/")).toEqual({
      website: "https://acme.example/",
      company_name: "Acme Security",
      industry: "Identity and access management",
      positioning: "Identity security for mid-market teams.",
      target_audience: "Mid-market IT and security teams",
      pricing: "$20 per seat",
      acquisition_channels: ["Paid search", "Content", "Partnerships"],
      threat_level: "high",
      source_urls: ["https://acme.example/", "https://example.org/acme-review"],
    });
  });

  it("fails closed when a required autofill field is missing", () => {
    const incomplete = structuredClone(report) as unknown as {
      blocks: Array<{ rows: string[][] }>;
    };
    incomplete.blocks[1].rows = incomplete.blocks[1].rows.filter(
      (row) => row[0] !== "target_audience",
    );
    expect(extractCompetitorResearch(incomplete, "https://acme.example/")).toBeNull();
  });

  it("normalizes a canonical domain and rejects non-http URLs", () => {
    expect(normalizeCompetitorWebsite("https://www.acme.com/pricing#plans")).toEqual({
      website: "https://www.acme.com/pricing",
      domain: "acme.com",
    });
    expect(() => normalizeCompetitorWebsite("ftp://acme.com")).toThrow(/http/);
  });
});

it.each(["netlify.app", "carrd.co", "my.canva.site", "lovable.app"])("keeps the company on %s distinct from its host", (suffix) => {
  expect(normalizeCompetitorWebsite(`https://brand.${suffix}/about`)).toEqual({
    website: `https://brand.${suffix}/about`, domain: `brand.${suffix}`,
  });
});
