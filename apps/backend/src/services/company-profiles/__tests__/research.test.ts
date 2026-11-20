import { describe, expect, it } from "vitest";
import { extractCompanyResearch, normalizeCompanyWebsite } from "../research";

const report = {
  kind: "report",
  blocks: [
    {
      type: "table",
      title: "Company profile fields",
      columns: ["Field", "Value"],
      rows: [
        ["industry", "Peer-to-peer car rental"],
        ["category", "Marketplace for car sharing"],
        ["founded", "2019"],
        ["location", "San Francisco, CA"],
        ["linkedin_url", "https://www.linkedin.com/company/upcar"],
        ["x_url", "https://x.com/upcar"],
        ["instagram_url", ""],
        ["facebook_url", "n/a"],
        ["youtube_url", "Not found"],
        ["tiktok_url", ""],
      ],
      citations: [1],
    },
  ],
  sources: [{ n: 1, url: "https://upcar.ai/" }],
};

describe("company profile research extraction", () => {
  it("maps the pinned table into the review form and drops blank socials", () => {
    expect(extractCompanyResearch(report, "https://upcar.ai/")).toEqual({
      website: "https://upcar.ai/",
      industry: "Peer-to-peer car rental",
      category: "Marketplace for car sharing",
      founded: "2019",
      location: "San Francisco, CA",
      social_profiles: [
        { platform: "linkedin", url: "https://www.linkedin.com/company/upcar", followers: null },
        { platform: "x", url: "https://x.com/upcar", followers: null },
      ],
      source_urls: ["https://upcar.ai/"],
    });
  });

  it("accepts a bundled social_urls field", () => {
    const bundled = structuredClone(report) as { blocks: Array<{ rows: string[][] }> };
    bundled.blocks[0].rows = [
      ["industry", "Car rental"],
      ["social_urls", "https://instagram.com/upcar https://www.tiktok.com/@upcar"],
    ];
    const extracted = extractCompanyResearch(bundled, "https://upcar.ai/");
    expect(extracted?.social_profiles.map((row) => row.platform)).toEqual(["instagram", "tiktok"]);
  });

  it("fails closed when no usable fields are present", () => {
    expect(extractCompanyResearch({ kind: "report", blocks: [] }, "https://upcar.ai/")).toBeNull();
  });

  it("normalizes a bare domain to https", () => {
    expect(normalizeCompanyWebsite("upcar.ai")).toEqual({
      website: "https://upcar.ai/",
      domain: "upcar.ai",
    });
  });
});

it.each(["netlify.app", "carrd.co", "my.canva.site", "lovable.app"])("keeps the company on %s distinct from its host", (suffix) => {
  expect(normalizeCompanyWebsite(`https://brand.${suffix}/about`)).toEqual({
    website: `https://brand.${suffix}/about`, domain: `brand.${suffix}`,
  });
});
