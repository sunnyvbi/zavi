
import { describe, it, expect } from "vitest";
import {
  assertOwnedRows,
  normalizeCampaignName,
  ownsCampaignName,
  tenantCampaignPrefix,
} from "../tenant-scope";
import { ExpectedToolError } from "@/services/tools/types";

describe("tenantCampaignPrefix", () => {
  it("ends in the DOUBLE-hyphen separator, which is what stops a slug matching a longer slug", () => {
    expect(tenantCampaignPrefix("acme")).toBe("zv-acme--");
    expect(tenantCampaignPrefix("acme-labs")).toBe("zv-acme-labs--");
  });

  it("is case- and whitespace-insensitive about the slug it is handed", () => {
    expect(tenantCampaignPrefix("  Acme-Labs  ")).toBe("zv-acme-labs--");
  });

  it("REFUSES an empty or malformed slug rather than returning a loose prefix", () => {
    for (const bad of ["", "   ", "-acme", "acme-", "ac me", "acme_labs", "acme/*", "ACME!"]) {
      expect(() => tenantCampaignPrefix(bad), JSON.stringify(bad)).toThrow(ExpectedToolError);
    }
  });
});

describe("ownsCampaignName", () => {
  const acme = tenantCampaignPrefix("acme");
  const acmeLabs = tenantCampaignPrefix("acme-labs");

  it("keeps the tenant's own campaigns, hyphens in the campaign part included", () => {
    expect(ownsCampaignName("zv-acme--spring-launch", acme)).toBe(true);
    expect(ownsCampaignName("  ZV-ACME--Spring-Launch ", acme)).toBe(true);
  });

  it("does NOT let a slug that is a prefix of another slug see that other tenant", () => {
    expect(ownsCampaignName("zv-acme-labs--launch", acme)).toBe(false);
    expect(ownsCampaignName("zv-acme--labs-launch", acmeLabs)).toBe(false);
    expect(ownsCampaignName("zv-acme-labs--launch", acmeLabs)).toBe(true);
    expect(ownsCampaignName("zv-acme--labs-launch", acme)).toBe(true);
  });

  it("does not match a slug that merely starts with the same letters", () => {
    expect(ownsCampaignName("zv-acmex--spring", acme)).toBe(false);
    expect(ownsCampaignName("zv-acme2--spring", acme)).toBe(false);
  });

  it("treats an unprefixed, foreign or unnamed campaign as belonging to NOBODY", () => {
    for (const name of [
      "spring-launch",
      "zv-globex--spring",
      "zv-acme",
      "zv-acme-spring",
      "zv-acme--",
      "holiday zv-acme--spring",
      "",
      "   ",
      null,
      undefined,
      42,
      { name: "zv-acme--spring" },
    ]) {
      expect(ownsCampaignName(name, acme), JSON.stringify(name ?? null)).toBe(false);
    }
  });

  it("refuses a prefix built without the double separator, rather than matching loosely", () => {
    expect(() => ownsCampaignName("zv-acme-labs--x", "zv-acme-")).toThrow(/separator/);
    expect(() => ownsCampaignName("zv-acme-labs--x", "zv-acme")).toThrow(/separator/);
  });
});

describe("normalizeCampaignName", () => {
  it("lowercases and trims, and turns a non-string into the empty string", () => {
    expect(normalizeCampaignName("  ZV-Acme--X ")).toBe("zv-acme--x");
    expect(normalizeCampaignName(null)).toBe("");
    expect(normalizeCampaignName(7)).toBe("");
  });
});

describe("assertOwnedRows (the belt)", () => {
  const owned = new Set(["c1", "c2"]);

  it("keeps rows whose campaign is in the filtered set", () => {
    const { kept, dropped } = assertOwnedRows(
      [
        { campaign_id: "c1", row_campaign_id: "c1" },
        { campaign_id: "c2", row_campaign_id: null },
      ],
      owned,
    );
    expect(kept).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it("drops a row for a campaign that is NOT in the filtered set", () => {
    const { kept, dropped } = assertOwnedRows(
      [
        { campaign_id: "c1", row_campaign_id: "c1" },
        { campaign_id: "c9", row_campaign_id: "c9" },
      ],
      owned,
    );
    expect(kept.map((r) => r.campaign_id)).toEqual(["c1"]);
    expect(dropped).toBe(1);
  });

  it("drops a row whose own campaign_id disagrees with the campaign we asked about", () => {
    const { kept, dropped } = assertOwnedRows(
      [{ campaign_id: "c1", row_campaign_id: "c9" }],
      owned,
    );
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });
});

describe("a legacy slug containing the separator cannot be read by a shorter tenant", () => {
  it("`acme` does not own `zv-acme--labs--spring`", () => {
    const acme = tenantCampaignPrefix("acme");
    expect(ownsCampaignName("zv-acme--labs--spring", acme)).toBe(false);
    expect(ownsCampaignName("zv-acme--labs--q4-brand", acme)).toBe(false);
  });

  it("`acme` still owns its own campaigns", () => {
    const acme = tenantCampaignPrefix("acme");
    expect(ownsCampaignName("zv-acme--spring", acme)).toBe(true);
    expect(ownsCampaignName("zv-acme--holiday-brand", acme)).toBe(true);
    expect(ownsCampaignName("zv-acme--a-b", acme)).toBe(true);
  });

  it("refuses a campaign that is only the prefix plus hyphens", () => {
    const acme = tenantCampaignPrefix("acme");
    expect(ownsCampaignName("zv-acme---", acme)).toBe(false);
  });
});
