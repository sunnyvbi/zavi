import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getCompanyFacts: vi.fn(),
  projectCompanyFactValue: vi.fn(),
  researchIdea: vi.fn(),
}));

vi.mock("../facts", async (orig) => ({
  ...(await orig<typeof import("../facts")>()),
  getCompanyFacts: mocks.getCompanyFacts,
  projectCompanyFactValue: mocks.projectCompanyFactValue,
}));
vi.mock("@/services/onboarding/brainstorm-research", async (orig) => ({
  ...(await orig<typeof import("@/services/onboarding/brainstorm-research")>()),
  researchIdea: mocks.researchIdea,
}));

import { __resetIdeaCompetitorsForTest, competitorsFromIdea, seedFromFacts } from "../idea-competitors";
import type { CompanyFacts } from "../facts";

const record = (over: Partial<CompanyFacts> = {}): CompanyFacts => ({
  name: "SFrent",
  nameIsWorkspaceLabel: false,
  website: null,
  competitors: [],
  facts: {
    what_we_sell: { value: "A peer-to-peer car rental marketplace in San Francisco", source: "ai_estimated", verified_at: null },
    company_story: { value: "Rent cars from neighbours in SF", source: "human_confirmed", verified_at: null },
  },
  ...over,
});

const landscape = (names: string[], grounded = true) => ({
  competitors: names.map((name) => ({ name, angle: "" })),
  evidence_sources: [
    { title: "Turo vs Getaround: which is better in SF", url: "https://example.com/a" },
    { title: "Car sharing", url: "https://www.zipcar.com/" },
  ],
  grounded,
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetIdeaCompetitorsForTest();
  mocks.getCompanyFacts.mockResolvedValue(record());
  mocks.projectCompanyFactValue.mockResolvedValue({ written: true, error: null });
});

describe("competitorsFromIdea", () => {
  it("researches from the stated details and saves only cited names at the lowest machine rank", async () => {
    mocks.researchIdea.mockResolvedValue(landscape(["Turo", "Getaround", "Zipcar", "a taxi", "Imaginary Co"]));
    const names = await competitorsFromIdea("t1");
    expect(names).toEqual(["Turo", "Getaround", "Zipcar"]);
    const seed = mocks.researchIdea.mock.calls[0][0] as string;
    expect(seed).toContain("SFrent");
    expect(seed).toContain("peer-to-peer car rental");
    expect(seed).toContain("Rent cars from neighbours");
    expect(mocks.projectCompanyFactValue).toHaveBeenCalledWith("t1", "competitors", "Turo, Getaround, Zipcar", "ai_estimated", "idea web research");
  });

  it("prefers the idea it is handed over the record", async () => {
    mocks.researchIdea.mockResolvedValue(landscape(["Turo"]));
    await competitorsFromIdea("t1", "Airbnb for cars");
    expect(mocks.researchIdea).toHaveBeenCalledWith("Airbnb for cars");
  });

  it("returns the record's list without researching when one exists", async () => {
    mocks.getCompanyFacts.mockResolvedValue(record({ competitors: ["Turo"] }));
    expect(await competitorsFromIdea("t1")).toEqual(["Turo"]);
    expect(mocks.researchIdea).not.toHaveBeenCalled();
  });

  it("joins a research already running for the tenant", async () => {
    let release!: (v: unknown) => void;
    mocks.researchIdea.mockReturnValue(new Promise((r) => { release = r; }));
    const a = competitorsFromIdea("t1");
    const b = competitorsFromIdea("t1");
    await vi.waitFor(() => expect(mocks.researchIdea).toHaveBeenCalledTimes(1));
    release(landscape(["Turo"]));
    expect(await a).toEqual(["Turo"]);
    expect(await b).toEqual(["Turo"]);
    expect(mocks.researchIdea).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when ungrounded, and does not search again right away", async () => {
    mocks.researchIdea.mockResolvedValue(landscape(["Turo"], false));
    expect(await competitorsFromIdea("t1")).toEqual([]);
    expect(await competitorsFromIdea("t1")).toEqual([]);
    expect(mocks.researchIdea).toHaveBeenCalledTimes(1);
    expect(mocks.projectCompanyFactValue).not.toHaveBeenCalled();
  });

  it("does not search again right away after a saved list is cleared, or after a failed write", async () => {
    mocks.researchIdea.mockResolvedValue(landscape(["Turo"]));
    expect(await competitorsFromIdea("t1")).toEqual(["Turo"]);
    expect(await competitorsFromIdea("t1")).toEqual([]);
    mocks.projectCompanyFactValue.mockResolvedValue({ written: false, error: "boom" });
    await expect(competitorsFromIdea("t2")).rejects.toThrow("boom");
    expect(await competitorsFromIdea("t2")).toEqual([]);
    expect(mocks.researchIdea).toHaveBeenCalledTimes(2);
  });

  it("returns the record's list when a founder's list outranked the write", async () => {
    mocks.researchIdea.mockResolvedValue(landscape(["Turo"]));
    mocks.projectCompanyFactValue.mockResolvedValue({ written: false, error: null });
    mocks.getCompanyFacts.mockResolvedValueOnce(record()).mockResolvedValueOnce(record({ competitors: ["Zipcar"] }));
    expect(await competitorsFromIdea("t1")).toEqual(["Zipcar"]);
  });

  it("never saves the website builder a build idea runs on as the business's competitors", async () => {
    mocks.researchIdea.mockResolvedValue({
      competitors: ["Squarespace", "Wix.com", "Shopify", "WordPress", "Tiff's Treats"].map((name) => ({ name, angle: "" })),
      evidence_sources: [
        { title: "Squarespace vs Wix vs Shopify: best website builder for a bakery", url: "https://example.com/builders" },
        { title: "WordPress for small bakeries", url: "https://example.com/wp" },
        { title: "Tiff's Treats opens a second Austin bakery", url: "https://example.com/tiffs" },
      ],
      grounded: true,
    });
    const names = await competitorsFromIdea("t1", "Build a website for my local bakery in Austin");
    expect(names).toEqual(["Tiff's Treats"]);
    expect(mocks.projectCompanyFactValue).toHaveBeenCalledTimes(1);
    expect(mocks.projectCompanyFactValue).toHaveBeenCalledWith("t1", "competitors", "Tiff's Treats", "ai_estimated", "idea web research");
  });

  it("writes nothing when every cited name is a site platform", async () => {
    mocks.researchIdea.mockResolvedValue({
      competitors: ["Squarespace", "Wix", "Shopify"].map((name) => ({ name, angle: "" })),
      evidence_sources: [{ title: "Squarespace vs Wix vs Shopify for bakeries", url: "https://example.com/b" }],
      grounded: true,
    });
    expect(await competitorsFromIdea("t1", "A website for my bakery")).toEqual([]);
    expect(mocks.projectCompanyFactValue).not.toHaveBeenCalled();
  });

  it("keeps site platforms when the business is itself a website builder", async () => {
    mocks.researchIdea.mockResolvedValue({
      competitors: ["Squarespace", "Wix"].map((name) => ({ name, angle: "" })),
      evidence_sources: [{ title: "Squarespace vs Wix for restaurants", url: "https://example.com/b" }],
      grounded: true,
    });
    expect(await competitorsFromIdea("t1", "A website builder made for restaurants")).toEqual(["Squarespace", "Wix"]);
  });

  it("keeps site platforms for a web agency that builds sites for others", async () => {
    mocks.researchIdea.mockResolvedValue({
      competitors: ["Squarespace", "Wix"].map((name) => ({ name, angle: "" })),
      evidence_sources: [{ title: "Squarespace vs Wix for restaurants", url: "https://example.com/b" }],
      grounded: true,
    });
    expect(await competitorsFromIdea("t1", "We build custom websites for restaurants")).toEqual(["Squarespace", "Wix"]);
  });

  it("does nothing with no details to search from", async () => {
    mocks.getCompanyFacts.mockResolvedValue(record({ name: "ws", nameIsWorkspaceLabel: true, facts: {} }));
    expect(await competitorsFromIdea("t1")).toEqual([]);
    expect(mocks.researchIdea).not.toHaveBeenCalled();
  });
});

describe("seedFromFacts", () => {
  it("leaves out a workspace label posing as the name", () => {
    expect(seedFromFacts(record({ name: "ws", nameIsWorkspaceLabel: true }))).not.toContain("ws");
  });
});
