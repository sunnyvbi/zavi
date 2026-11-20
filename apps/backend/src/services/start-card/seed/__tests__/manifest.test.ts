import { describe, it, expect } from "vitest";
import { companyDomain, mergeManifest, pickYc } from "../manifest";

describe("seed manifest", () => {
  it("keeps a company's own domain and drops platform pages", () => {
    expect(companyDomain("https://www.Acme.io/about")).toBe("acme.io");
    expect(companyDomain("acme.co")).toBe("acme.co");
    for (const u of ["https://apps.apple.com/app/x", "https://acme.vercel.app", "https://github.com/acme", "http://10.0.0.1", "", null, "not a url"]) {
      expect(companyDomain(u), String(u)).toBeNull();
    }
  });
  it("picks active, small YC companies with a site, newest first", () => {
    const rows = [
      { website: "https://old.com", status: "Active", team_size: 5, launched_at: 1 },
      { website: "https://new.com", status: "Active", team_size: 5, launched_at: 9 },
      { website: "https://dead.com", status: "Inactive", team_size: 5, launched_at: 9 },
      { website: "https://big.com", status: "Active", team_size: 900, launched_at: 9 },
      { website: "https://x.notion.site", status: "Active", team_size: 3, launched_at: 9 },
      { website: "https://noteam.com", status: "Active", team_size: null, launched_at: 9 },
    ];
    expect(pickYc(rows, { maxTeam: 200 }).map((i) => i.domain)).toEqual(["new.com", "old.com"]);
  });
  it("interleaves sources, dedupes, excludes and stops at the limit", () => {
    const yc = [{ domain: "a.com", source: "yc" as const }, { domain: "b.com", source: "yc" as const }, { domain: "c.com", source: "yc" as const }];
    const ph = [{ domain: "www.b.com", source: "product_hunt" as const }, { domain: "z.com", source: "product_hunt" as const }];
    expect(mergeManifest([yc, ph], 10, ["c.com"])).toEqual([
      { domain: "a.com", source: "yc" },
      { domain: "b.com", source: "product_hunt" },
      { domain: "z.com", source: "product_hunt" },
    ]);
    expect(mergeManifest([yc, ph], 2)).toHaveLength(2);
  });
});
