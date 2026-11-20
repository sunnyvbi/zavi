
import { describe, it, expect, vi, beforeEach } from "vitest";

let searchResults: Array<{ title?: string; url?: string; content?: string }> = [];
let llmCompetitorsJson = "";

vi.mock("@/services/mcp/internal/web-search", () => ({
  callWebSearchTool: vi.fn(async () => ({
    ok: true,
    is_error: false,
    content: JSON.stringify({ answer: "", results: searchResults }),
  })),
}));

vi.mock("@/services/anthropic", () => ({
  DEFAULT_FAST_MODEL: "claude-haiku-test",
  cachedSystemBlock: (text: string) => ({ type: "text", text }),
  hasAnthropicAuth: () => true,
  createMessageWithFailover: async (req: { system: Array<{ text: string }> }) => {
    const sys = req.system?.[0]?.text ?? "";
    if (sys.includes("generate web-search queries")) {
      return {
        content: [
          {
            type: "text",
            text: '<queries_json>{"category":"ai agents","queries":["ai cofounder competitors","autonomous agent platforms"]}</queries_json>',
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: `<competitors_json>${llmCompetitorsJson}</competitors_json>` }],
    };
  },
}));

import { findCompetitors } from "../competitors";

describe("findCompetitors — grounded LLM", () => {
  beforeEach(() => {
    searchResults = [
      { title: "Top AI cofounder tools — G2", url: "https://g2.com/dust", content: "Dust builds AI agents for teams." },
      { title: "Cofounder.co", url: "https://cofounder.co", content: "An AI cofounder for startups." },
      { title: "Zavi pricing", url: "https://zaviagent.com/pricing", content: "Zavi plans." },
      { title: "Lindy AI review", url: "https://lindy.ai", content: "Lindy is an AI assistant platform." },
    ];
  });

  it("maps evidence_index back to real sources and returns grounded competitors", async () => {
    llmCompetitorsJson = JSON.stringify({
      competitors: [
        { name: "Dust", evidence_index: 1, why: "AI agents, same ICP" },
        { name: "Cofounder.co", evidence_index: 2, why: "AI cofounder" },
        { name: "Lindy", evidence_index: 4, why: "AI assistant" },
      ],
    });
    const out = await findCompetitors("Zavi", "zaviagent.com", "Zavi is an AI cofounder team.");
    expect(out.map((c) => c.name)).toEqual(["Dust", "Cofounder.co", "Lindy"]);
    expect(out[0]).toMatchObject({ source_url: "https://g2.com/dust" });
    expect(out.every((c) => searchResults.some((r) => r.url === c.source_url))).toBe(true);
  });

  it("drops the company's own domain even if the LLM picks it", async () => {
    llmCompetitorsJson = JSON.stringify({
      competitors: [
        { name: "Dust", evidence_index: 1, why: "x" },
        { name: "Zavi", evidence_index: 3, why: "self" },
      ],
    });
    const out = await findCompetitors("Zavi", "zaviagent.com", "ctx");
    expect(out.map((c) => c.name)).toEqual(["Dust"]);
  });

  it("ignores picks with an out-of-range evidence_index (no fabricated URL)", async () => {
    llmCompetitorsJson = JSON.stringify({
      competitors: [{ name: "Ghost", evidence_index: 99, why: "hallucinated" }],
    });
    const out = await findCompetitors("Zavi", "zaviagent.com", "ctx");
    expect(out).toEqual([]);
  });
});

import { parseCompetitorPicks, normalizeCompetitorDomain } from "../competitors";

describe("parseCompetitorPicks", () => {
  const longWhy =
    "Specialty coffee roaster emphasizing exceptional quality, social and environmental responsibility, B Corp certified, with sustainably sourced and transparently traded coffees, and a similar direct-to-consumer subscription model and values.";

  it("keeps a competitor whose why is longer than 200 characters", () => {
    expect(longWhy.length).toBeGreaterThan(200);
    const picks = parseCompetitorPicks([
      { name: "Counter Culture Coffee", evidence_index: 18, why: longWhy },
    ]);
    expect(picks).toHaveLength(1);
    expect(picks[0].name).toBe("Counter Culture Coffee");
    expect(picks[0].why!.length).toBe(200);
  });

  it("drops only the malformed entry, never its siblings", () => {
    const picks = parseCompetitorPicks([
      { name: "Matomo", evidence_index: 11, why: "privacy analytics" },
      { name: "X", evidence_index: 2, why: "name too short" },
      { name: "Fathom Analytics", evidence_index: 12 },
      { evidence_index: 3, why: "no name at all" },
      { name: "Simple Analytics", evidence_index: "not a number" },
    ]);
    expect(picks.map((p) => p.name)).toEqual(["Matomo", "Fathom Analytics"]);
  });

  it("caps the list at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      name: `Brand${i}`,
      evidence_index: i + 1,
      why: "overlap",
    }));
    expect(parseCompetitorPicks(many)).toHaveLength(8);
  });

  it("returns nothing for junk", () => {
    expect(parseCompetitorPicks([null, 7, "text", {}])).toEqual([]);
  });

  it("keeps the model-supplied domain and tolerates it being absent", () => {
    const picks = parseCompetitorPicks([
      { name: "Globex", evidence_index: 1, domain: "globex.com" },
      { name: "Initech", evidence_index: 2 },
      { name: "Umbrella", evidence_index: 3, domain: "" },
      { name: "Wayne", evidence_index: 4, domain: null },
    ]);
    expect(picks.map((p) => p.name)).toEqual(["Globex", "Initech", "Umbrella", "Wayne"]);
    expect(picks[0].domain).toBe("globex.com");
    expect(picks[1].domain).toBeUndefined();
    expect(picks[2].domain).toBe("");
    expect(picks[3].domain).toBeUndefined();
  });
});

describe("normalizeCompetitorDomain", () => {
  it("accepts a bare registrable domain", () => {
    expect(normalizeCompetitorDomain("globex.com")).toBe("globex.com");
  });

  it("strips scheme, www, path, query and case", () => {
    expect(normalizeCompetitorDomain("HTTPS://www.Globex.com/pricing?ref=x")).toBe("globex.com");
  });

  it("collapses a subdomain to the registrable domain", () => {
    expect(normalizeCompetitorDomain("app.globex.com")).toBe("globex.com");
  });

  it("keeps a two-part public suffix", () => {
    expect(normalizeCompetitorDomain("globex.co.uk")).toBe("globex.co.uk");
  });

  it("rejects junk that is not a domain", () => {
    expect(normalizeCompetitorDomain("")).toBeNull();
    expect(normalizeCompetitorDomain(undefined)).toBeNull();
    expect(normalizeCompetitorDomain("not a domain")).toBeNull();
    expect(normalizeCompetitorDomain("localhost")).toBeNull();
    expect(normalizeCompetitorDomain("globex")).toBeNull();
    expect(normalizeCompetitorDomain("192.168.1.1")).toBeNull();
  });
});

describe("competitor identity — never the publisher's domain", () => {
  beforeEach(() => {
    searchResults = [
      {
        title: "The car-sharing boom",
        url: "https://cnbc.com/2026/03/car-sharing",
        content: "Turo and Getaround now dominate peer-to-peer car rental.",
      },
      { title: "Getaround", url: "https://getaround.com", content: "Rent cars from people nearby." },
    ];
  });

  it("does not write the cited article's host into the competitor's url", async () => {
    llmCompetitorsJson = JSON.stringify({
      competitors: [{ name: "Turo", evidence_index: 1, domain: "turo.com", why: "same marketplace" }],
    });
    const out = await findCompetitors("Upcar", "upcar.ai", "Upcar is a peer-to-peer car rental marketplace.");
    expect(out.map((c) => c.name)).toEqual(["Turo"]);
    expect(out[0].url).toBe("https://turo.com");
    expect(out[0].url).not.toContain("cnbc");
    expect(out[0].source_url).toBe("https://cnbc.com/2026/03/car-sharing");
  });

  it("keeps a competitor with no resolvable domain as a name, with an empty url", async () => {
    llmCompetitorsJson = JSON.stringify({
      competitors: [{ name: "Turo", evidence_index: 1, why: "no domain from the model" }],
    });
    const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
    expect(out.map((c) => c.name)).toEqual(["Turo"]);
    expect(out[0].url).toBe("");
  });

  it("falls back to name-only when the model's domain is junk", async () => {
    llmCompetitorsJson = JSON.stringify({
      competitors: [{ name: "Turo", evidence_index: 1, domain: "not a domain", why: "junk" }],
    });
    const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
    expect(out.map((c) => c.name)).toEqual(["Turo"]);
    expect(out[0].url).toBe("");
  });

  it("prefers a domain found in the search results over the model's", async () => {
    llmCompetitorsJson = JSON.stringify({
      competitors: [{ name: "Getaround", evidence_index: 1, domain: "getaround-wrong.com", why: "x" }],
    });
    const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
    expect(out[0].url).toBe("https://getaround.com");
  });

  it("keeps BOTH competitors named in the SAME article", async () => {
    searchResults = [
      {
        title: "The car-sharing boom",
        url: "https://cnbc.com/2026/03/car-sharing",
        content: "Turo and Getaround now dominate peer-to-peer car rental.",
      },
    ];
    llmCompetitorsJson = JSON.stringify({
      competitors: [
        { name: "Turo", evidence_index: 1, domain: "turo.com", why: "a" },
        { name: "Getaround", evidence_index: 1, domain: "getaround.com", why: "b" },
      ],
    });
    const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
    expect(out.map((c) => c.name)).toEqual(["Turo", "Getaround"]);
    expect(out.map((c) => c.url)).toEqual(["https://turo.com", "https://getaround.com"]);
  });

  it("refuses a domain that is just an echo of the cited article", async () => {
    for (const echoed of ["https://cnbc.com/2026/03/car-sharing", "cnbc.com", "www.cnbc.com"]) {
      llmCompetitorsJson = JSON.stringify({
        competitors: [{ name: "Turo", evidence_index: 1, domain: echoed, why: "echo" }],
      });
      const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
      expect(out.map((c) => c.name)).toEqual(["Turo"]);
      expect(out[0].url).toBe("");
    }
  });

  it("refuses a domain echoed from a result the pick did not cite", async () => {
    searchResults = [
      { title: "The car-sharing boom", url: "https://cnbc.com/2026/03/car-sharing", content: "Turo leads." },
      { title: "r/carsharing", url: "https://reddit.com/r/carsharing", content: "People discuss Turo." },
    ];
    llmCompetitorsJson = JSON.stringify({
      competitors: [{ name: "Turo", evidence_index: 2, domain: "cnbc.com", why: "cross-echo" }],
    });
    const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
    expect(out.map((c) => c.name)).toEqual(["Turo"]);
    expect(out[0].url).toBe("");
  });

  it("does NOT strip a TLD-looking syllable off a dot-free brand name", async () => {
    searchResults = [
      { title: "Open", url: "https://open.com", content: "unrelated" },
      { title: "The AI boom", url: "https://cnbc.com/ai", content: "OpenAI leads." },
    ];
    llmCompetitorsJson = JSON.stringify({
      competitors: [{ name: "OpenAI", evidence_index: 2, why: "named in the article" }],
    });
    const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
    expect(out.map((c) => c.name)).toEqual(["OpenAI"]);
    expect(out[0].url).toBe("");
  });

  it("resolves a brand whose name carries the TLD (Cofounder.co)", async () => {
    searchResults = [
      { title: "Cofounder.co", url: "https://cofounder.co", content: "An AI cofounder for startups." },
    ];
    llmCompetitorsJson = JSON.stringify({
      competitors: [{ name: "Cofounder.co", evidence_index: 1, why: "own-domain result exists" }],
    });
    const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
    expect(out[0].url).toBe("https://cofounder.co");
  });

  it("still drops the company itself when it arrives as a name with no domain", async () => {
    llmCompetitorsJson = JSON.stringify({
      competitors: [
        { name: "Upcar", evidence_index: 1, why: "self, no domain" },
        { name: "Turo", evidence_index: 1, domain: "turo.com", why: "real" },
      ],
    });
    const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
    expect(out.map((c) => c.name)).toEqual(["Turo"]);
  });

  it("keeps a homepage whose brand name carries a legal suffix or a leading The", async () => {
    for (const [name, domain, host] of [
      ["The Home Depot", "homedepot.com", "https://www.homedepot.com"],
      ["Getaround Inc", "getaround.com", "https://getaround.com"],
    ]) {
      searchResults = [
        { title: "Retail roundup", url: "https://cnbc.com/retail", content: `${name} leads.` },
        { title: name, url: host, content: "the brand's own site" },
      ];
      llmCompetitorsJson = JSON.stringify({
        competitors: [{ name, evidence_index: 1, domain, why: "x" }],
      });
      const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
      expect(out.map((c) => c.name)).toEqual([name]);
      expect(out[0].url).toBe(`https://${domain}`);
    }
  });

  it("lets a later pick correct an earlier pick's non-brand domain", async () => {
    llmCompetitorsJson = JSON.stringify({
      competitors: [
        { name: "Turo", evidence_index: 1, domain: "some-affiliate-site.com", why: "wrong first" },
        { name: "Turo", evidence_index: 1, domain: "turo.com", why: "right second" },
      ],
    });
    const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://turo.com");
  });

  it("collapses the same competitor arriving with and without a domain", async () => {
    llmCompetitorsJson = JSON.stringify({
      competitors: [
        { name: "Turo", evidence_index: 1, why: "no domain first" },
        { name: "Turo", evidence_index: 1, domain: "turo.com", why: "domain second" },
      ],
    });
    const out = await findCompetitors("Upcar", "upcar.ai", "ctx");
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://turo.com");
  });
});

describe("hosted competitor identity", () => {
  it("keeps two businesses on the same provider distinct", async () => {
    searchResults = [
      {title: "Rival", url: "https://rival.netlify.app/", content: "Rival clinic"},
      {title: "Clinic", url: "https://clinic.netlify.app/", content: "Own clinic"},
    ];
    llmCompetitorsJson = JSON.stringify({competitors: [
      {name: "Rival", evidence_index: 1, domain: "rival.netlify.app", why: "same market"},
      {name: "Clinic", evidence_index: 2, domain: "clinic.netlify.app", why: "self"},
    ]});
    const out = await findCompetitors("Clinic", "clinic.netlify.app", "Medical services");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({name: "Rival", url: "https://rival.netlify.app"});
  });
  it("normalizes a hosted competitor without losing its identity", () => {
    expect(normalizeCompetitorDomain("https://rival.carrd.co/about")).toBe("rival.carrd.co");
    expect(normalizeCompetitorDomain("https://www.netlify.app/")).toBe("www.netlify.app");
  });
});
