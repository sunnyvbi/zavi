
import { describe, it, expect } from "vitest";
import {
  canonicalizeStages,
  canonicalizeGeography,
  canonicalizeSectors,
  normVocab,
  isAngelTagged,
  CANONICAL_STAGES,
  CANONICAL_GEOGRAPHIES,
} from "../vocab";

const PROD_STAGES = ["Seed", "Series A", "Pre-seed", "Series B+", "Multi-stage"];
const PROD_GEOGRAPHIES = [
  "US/Canada","Europe","Asia-Pacific","Latin America","Israel","India","Africa",
  "Australia/New Zealand","North Africa","Middle East","Global","USA","Canada","Oceania","China",
];
const PROD_NICHES = [
  "AI","API","AR/VR","Advertising","AgTech","Analytics","Angel","Automation","B2B SaaS",
  "B2C/E-Commerce","BioTech","CPG/D2C","Chemicals","CleanTech/Environment","Climate","Cloud",
  "Cloud Infrastructure","Commercial Services","ConstructionTech","Consumer","Consumer Durables",
  "Consumer Health","Creator Economy","Crypto/Blockchain","Cybersecurity","Data Services","DeepTech",
  "Defense, Gov, & Legal","Developer Tools","Digital Health","Direct-to-Consumer (DTC)",
  "Diverse Investors","EdTech","Education","Energy","EnergyTech","Enterprise","Enterprise Applications",
  "Entertainment","Entertainment & Sports","Fashion","FinTech","Financial Services","Food & Ag",
  "Food and Beverage","Frontier Tech","Future of Work","Gaming/eSports","Generalist","Gig Economy",
  "GovTech","Government Technology","HRTech","Hardware","Health & Hospital Services","Health IT",
  "Health and Wellness","Healthcare/Medtech","Human Capital/HRTech","IT Services","Impact","Industrial",
  "Infrastructure","Insurance","InsureTech","IoT","Life Sciences","Local Services","Lodging/Hospitality",
  "Logistics","Manufacturing","MarketingTech","Marketplaces","Material Science","Media","Media/Content",
  "Medical Devices","Messaging","Mobility","Parenting/Families","Payments","Pharmaceuticals","Productivity",
  "Proptech","Real Estate","Retail","Robotics","SMB Software","SaaS","Sales & CRM","Scout","Security",
  "Semiconductors","Social Commerce","Social Media","Social Networks","Space","Supply Chain","Transportation",
  "TransportationTech","Travel","Under-represented founders","Web3","Wellness & Fitness","and Solo-Capitalists",
];

describe("vocab parity — every prod value canonicalizes to itself", () => {
  it("every prod stage is recognized and maps to itself (none ignored)", () => {
    for (const s of PROD_STAGES) {
      const { values, ignored } = canonicalizeStages([s]);
      expect(ignored, `stage ${s} should be recognized`).toEqual([]);
      expect(values).toEqual([s]);
    }
  });

  it("every prod geography is recognized and includes itself", () => {
    for (const g of PROD_GEOGRAPHIES) {
      const { values, ignored } = canonicalizeGeography(g);
      expect(ignored, `geo ${g} should be recognized`).toEqual([]);
      expect(values, `geo ${g} should map to include itself`).toContain(g);
    }
  });

  it("every prod niche is recognized and maps to itself (none ignored)", () => {
    for (const n of PROD_NICHES) {
      const { values, ignored } = canonicalizeSectors([n]);
      expect(ignored, `niche ${n} should be recognized`).toEqual([]);
      expect(values).toEqual([n]);
    }
  });

  it("the exported enum lists are subsets of the prod corpus", () => {
    for (const s of CANONICAL_STAGES) expect(PROD_STAGES).toContain(s);
    for (const g of CANONICAL_GEOGRAPHIES) expect(PROD_GEOGRAPHIES).toContain(g);
  });
});

describe("canonicalization — near-miss caller inputs", () => {
  it("maps the proven zero-causing stage variants", () => {
    expect(canonicalizeStages(["Pre-Seed"]).values).toEqual(["Pre-seed"]);
    expect(canonicalizeStages(["pre seed"]).values).toEqual(["Pre-seed"]);
    expect(canonicalizeStages(["preseed"]).values).toEqual(["Pre-seed"]);
    expect(canonicalizeStages(["seed"]).values).toEqual(["Seed"]);
    expect(canonicalizeStages(["Series B"]).values).toEqual(["Series B+"]);
  });

  it("maps the proven zero-causing geography variants onto US buckets", () => {
    expect(canonicalizeGeography("US").values).toEqual(["US/Canada", "USA"]);
    expect(canonicalizeGeography("united states").values).toEqual(["US/Canada", "USA"]);
    expect(canonicalizeGeography("America").values).toEqual(["US/Canada", "USA"]);
    expect(canonicalizeGeography("UK").values).toEqual(["Europe"]);
  });

  it("does NOT fold a specific region into Global (no over-broadening)", () => {
    expect(canonicalizeGeography("US").values).not.toContain("Global");
    expect(canonicalizeGeography("Europe").values).not.toContain("Global");
  });

  it("normalizes sector casing + common aliases", () => {
    expect(canonicalizeSectors(["b2b saas", "fintech", "ai"]).values).toEqual(["B2B SaaS", "FinTech", "AI"]);
    expect(canonicalizeSectors(["agentic ai"]).values).toEqual(["AI"]);
    expect(canonicalizeSectors(["dev tools"]).values).toEqual(["Developer Tools"]);
  });

  it("reports unresolvable values in ignored and dedupes", () => {
    const s = canonicalizeStages(["Pre-Seed", "Series Z"]);
    expect(s.values).toEqual(["Pre-seed"]);
    expect(s.ignored).toEqual(["Series Z"]);
    expect(canonicalizeGeography("USA").values).toEqual(["US/Canada", "USA"]);
    expect(canonicalizeSectors(["AI", "artificial intelligence"]).values).toEqual(["AI"]);
  });
});

describe("normVocab — separator + dash tolerance", () => {
  it("keeps / and + but tolerates surrounding spaces and Unicode dashes", () => {
    expect(normVocab("US/Canada")).toBe("us/canada");
    expect(normVocab("US / Canada")).toBe("us/canada");
    expect(normVocab("Series B+")).toBe("series b+");
    expect(normVocab("Series B +")).toBe("series b+");
    expect(normVocab("Pre–Seed")).toBe("pre seed");
    expect(normVocab("  pre_seed ")).toBe("pre seed");
  });

  it("the dash tolerance lets an en-dash'd stage still canonicalize", () => {
    expect(canonicalizeStages(["Pre–Seed"]).values).toEqual(["Pre-seed"]);
  });
});

describe("angel round + solo-capitalist niche", () => {
  it("'Angel' is an angel round, not silently Pre-seed and not ignored", () => {
    for (const s of ["Angel", "angels", "Angel round"]) {
      const c = canonicalizeStages([s]);
      expect(c.angel).toBe(true);
      expect(c.values).toEqual([]);
      expect(c.ignored).toEqual([]);
    }
    expect(canonicalizeStages(["Pre-seed"]).angel).toBe(false);
  });

  it("solo-capitalist phrasings resolve to the stored split token", () => {
    for (const s of ["Solo-Capitalists", "solo capitalists", "solo capitalist", "and Solo-Capitalists"]) {
      expect(canonicalizeSectors([s]).values).toEqual(["and Solo-Capitalists"]);
    }
    expect(canonicalizeSectors(["angels"]).values).toEqual(["Angel"]);
    expect(isAngelTagged(["AI", "and Solo-Capitalists"], ["$0 - $25K"])).toBe(true);
    expect(isAngelTagged(["AI", "Scout"], ["$0 - $25K"])).toBe(false);
    expect(isAngelTagged(["Angel", "and Solo-Capitalists"], ["$500K - $1M", "$10M - $50M"])).toBe(false);
  });
});
