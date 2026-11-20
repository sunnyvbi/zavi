
import { describe, it, expect, vi, beforeEach } from "vitest";

let searchResults: Array<{ title?: string; url?: string; content?: string }> = [];
let searchAnswer = "";
let llmCompetitorsJson = "";

vi.mock("@/services/mcp/internal/web-search", () => ({
  callWebSearchTool: vi.fn(async () => ({
    ok: true,
    is_error: false,
    content: JSON.stringify({ answer: searchAnswer, results: searchResults }),
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
          { type: "text", text: '<queries_json>{"category":"widgets","queries":["widget marketplace competitors","widget platforms alternatives"]}</queries_json>' },
        ],
      };
    }
    return { content: [{ type: "text", text: `<competitors_json>${llmCompetitorsJson}</competitors_json>` }] };
  },
}));

import { findCompetitors } from "../competitors";

describe("findCompetitors — answer-grounded competitors", () => {
  beforeEach(() => {
    searchResults = [
      { title: "10 best widget marketplaces — SomeBlog", url: "https://someblog.com/best-widgets", content: "A roundup of widget marketplaces including Globex and Initech." },
      { title: "r/widgets discussion", url: "https://reddit.com/r/widgets", content: "People compare Globex and Initech." },
      { title: "Globex — the widget marketplace", url: "https://globex.com", content: "Globex is a marketplace for widgets." },
      { title: "Initech widgets", url: "https://initech.com", content: "Initech sells widgets to teams." },
    ];
    searchAnswer = "The top widget marketplaces include Globex and Initech.";
  });

  it("surfaces summary-named competitors, grounded to their own-domain results (clean homepage URL)", async () => {
    llmCompetitorsJson = JSON.stringify({
      competitors: [
        { name: "Globex", evidence_index: 5, why: "named in the search summary" },
        { name: "Initech", evidence_index: 5, why: "named in the search summary" },
      ],
    });
    const out = await findCompetitors("Acme", "acme.io", "Acme is a widget marketplace.");
    expect(out.map((c) => c.name)).toEqual(["Globex", "Initech"]);
    expect(out.map((c) => c.url)).toEqual(["https://globex.com", "https://initech.com"]);
  });

  it("keeps a summary-named competitor with no own-domain result as a NAME, never a guessed domain", async () => {
    searchAnswer = "Competitors include Globex and Umbrella.";
    llmCompetitorsJson = JSON.stringify({
      competitors: [
        { name: "Globex", evidence_index: 5, why: "own-domain result exists" },
        { name: "Umbrella", evidence_index: 5, why: "only named in summary, no domain" },
      ],
    });
    const out = await findCompetitors("Acme", "acme.io", "ctx");
    expect(out.map((c) => c.name)).toEqual(["Globex", "Umbrella"]);
    expect(out[0].url).toBe("https://globex.com");
    expect(out[1].url).toBe("");
  });

  it("does NOT match a short name as a substring of an unrelated domain", async () => {
    searchResults = [
      { title: "Racetrack widgets", url: "https://racetrack.com", content: "unrelated" },
      { title: "Globex", url: "https://globex.com", content: "widget marketplace" },
    ];
    searchAnswer = "Competitors include Ace and Globex.";
    llmCompetitorsJson = JSON.stringify({
      competitors: [
        { name: "Ace", evidence_index: 3, why: "named in summary" },
        { name: "Globex", evidence_index: 3, why: "named in summary" },
      ],
    });
    const out = await findCompetitors("Acme", "acme.io", "ctx");
    expect(out.map((c) => c.name)).toEqual(["Ace", "Globex"]);
    expect(out.every((c) => !c.url.includes("racetrack"))).toBe(true);
    expect(out[0].url).toBe("");
  });

  it("still resolves RESULT-cited competitors (backward compatible)", async () => {
    searchAnswer = "";
    llmCompetitorsJson = JSON.stringify({
      competitors: [{ name: "Globex", evidence_index: 3, why: "direct result" }],
    });
    const out = await findCompetitors("Acme", "acme.io", "ctx");
    expect(out.map((c) => c.name)).toEqual(["Globex"]);
    expect(out[0].source_url).toBe("https://globex.com");
  });
});
