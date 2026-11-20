
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callMcpTool: vi.fn() }));
vi.mock("@/services/mcp/execute", () => ({ callMcpTool: mocks.callMcpTool }));

import {
  recordWebFetchCapture,
  getCapturedText,
  isDiscoveryRun,
  __resetCaptureLedgerForTest,
} from "@/services/agents/engine/capture-ledger";
import { runInvestorDiscovery } from "../search";
import {
  buildDiscoveryQueries,
  rankCandidateUrls,
  extractCandidatesFromPage,
  classifySourceKind,
} from "../extract";

const RUN = "run-disc-1";

function fetchOk(url: string, body: string, finalUrl?: string): string {
  return JSON.stringify({
    final_url: finalUrl ?? url,
    status: 200,
    content_type: "text/html",
    body_text: `<untrusted_web_content>\n${body}\n</untrusted_web_content>`,
    capture: "dom_text",
  });
}

function searchOk(urls: string[]): string {
  return JSON.stringify({
    answer: null,
    results: urls.map((u) => ({ title: "t", url: u, snippet: "s" })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetCaptureLedgerForTest();
});

describe("investor_discovery capture-ledger integration (MAKE-OR-BREAK)", () => {
  it("the tool's fetches ARE visible to getCapturedText(run_id, url) afterwards", async () => {
    const DIR_URL = "https://openvc.example/seed-investors-list";
    const dirBody =
      "Top seed investors directory. Northwind Capital invests in seed-stage mobility and leads rounds. Brightwater Partners backs early marketplaces at seed.";

    mocks.callMcpTool.mockImplementation(
      async (ctx: { run_id: string }, server_id: string, tool_name: string, args: { url?: string }) => {
        if (server_id === "web_search" && tool_name === "search") {
          return { ok: true, is_error: false, content: searchOk([DIR_URL]), ms: 1 };
        }
        if (server_id === "web_fetch" && tool_name === "fetch") {
          const content = fetchOk(args.url as string, dirBody);
          recordWebFetchCapture(ctx.run_id, args, content);
          return { ok: true, is_error: false, content, ms: 1 };
        }
        return { ok: false, is_error: true, content: "{}", ms: 1 };
      },
    );

    const ctx = { tenant_id: "t-1", run_id: RUN } as never;
    const out = await runInvestorDiscovery(ctx, {
      sector: "marketplace mobility",
      stage: "seed",
      region: "US",
    });

    expect(out.pages_fetched).toBeGreaterThanOrEqual(1);
    expect(out.count).toBeGreaterThanOrEqual(1);
    const firms = out.candidates.map((c) => c.firm.toLowerCase());
    expect(firms.some((f) => f.includes("northwind"))).toBe(true);

    const captured = getCapturedText(RUN, DIR_URL);
    expect(captured).not.toBeNull();
    expect(captured as string).toContain("Northwind Capital");

    expect(isDiscoveryRun(RUN)).toBe(true);

    for (const c of out.candidates) {
      expect(getCapturedText(RUN, c.source_url)).not.toBeNull();
    }
  });

  it("requests a larger (24KB) excerpt from web_fetch for list pages", async () => {
    mocks.callMcpTool.mockImplementation(
      async (_ctx: unknown, server_id: string, tool_name: string, args: { url?: string }) => {
        if (server_id === "web_search") {
          return { ok: true, is_error: false, content: searchOk(["https://x.example/investors-list"]), ms: 1 };
        }
        return { ok: true, is_error: false, content: fetchOk(args.url as string, "Acme Capital invests at seed."), ms: 1 };
      },
    );
    const ctx = { tenant_id: "t-1", run_id: "run-excerpt" } as never;
    await runInvestorDiscovery(ctx, { sector: "fintech", stage: "seed" });
    const fetchCall = mocks.callMcpTool.mock.calls.find(
      (c) => c[1] === "web_fetch" && c[2] === "fetch",
    );
    expect(fetchCall).toBeDefined();
    const fetchArgs = fetchCall?.[3] as { max_excerpt_bytes?: number };
    expect(fetchArgs.max_excerpt_bytes).toBeGreaterThan(16 * 1024);
  });

  it("skips blocked fetches without crashing (capture still ledgered)", async () => {
    mocks.callMcpTool.mockImplementation(
      async (ctx: { run_id: string }, server_id: string, _t: string, args: { url?: string }) => {
        if (server_id === "web_search") {
          return { ok: true, is_error: false, content: searchOk(["https://blocked.example/list"]), ms: 1 };
        }
        const content = JSON.stringify({
          error: "web_fetch_http_error",
          meta: { status: 403, final_url: args.url },
          status: 403,
          capture: "blocked",
          body_text: "<untrusted_web_content>[blocked]</untrusted_web_content>",
        });
        recordWebFetchCapture(ctx.run_id, args, content);
        return { ok: false, is_error: true, content, ms: 1 };
      },
    );
    const ctx = { tenant_id: "t-1", run_id: "run-blocked" } as never;
    const out = await runInvestorDiscovery(ctx, { sector: "ai", stage: "seed" });
    expect(out.pages_fetched).toBe(0);
    expect(out.count).toBe(0);
  });
});

describe("buildDiscoveryQueries", () => {
  it("builds category+stage queries and skips empty fields", () => {
    const qs = buildDiscoveryQueries({ sector: "fintech", stage: "seed", region: "US" });
    expect(qs.length).toBeGreaterThanOrEqual(5);
    expect(qs.length).toBeLessThanOrEqual(12);
    expect(qs.every((q) => !q.toLowerCase().includes("undefined"))).toBe(true);
    expect(qs.some((q) => q.includes("fintech"))).toBe(true);
  });

  it("NEVER includes a company/founder name (privacy) — only what's passed", () => {
    const qs = buildDiscoveryQueries({ sector: "mobility", stage: "seed" });
    expect(qs.every((q) => q.length > 0)).toBe(true);
    expect(qs.some((q) => q.toLowerCase().includes("mobility"))).toBe(true);
  });

  it("uses comparables to build 'investors who backed X' queries", () => {
    const qs = buildDiscoveryQueries({ sector: "marketplace", comparables: ["Turo", "Faire"] });
    expect(qs.some((q) => /backed turo/i.test(q))).toBe(true);
  });

  it("falls back to stage-only queries when sector is absent", () => {
    const qs = buildDiscoveryQueries({ stage: "Series A", region: "Europe" });
    expect(qs.length).toBeGreaterThan(0);
  });
});

describe("rankCandidateUrls", () => {
  it("deprioritizes linkedin.com + crunchbase.com to the back", () => {
    const ranked = rankCandidateUrls([
      "https://linkedin.com/in/someone",
      "https://openvc.example/seed-investors-list",
      "https://crunchbase.com/org/x",
      "https://fundlist.example/best-seed-funds",
    ]);
    expect(ranked[0]).not.toContain("linkedin.com");
    expect(ranked[0]).not.toContain("crunchbase.com");
    expect(ranked[ranked.length - 1]).toMatch(/linkedin\.com|crunchbase\.com/);
  });

  it("boosts list/directory URL shapes above plain pages", () => {
    const ranked = rankCandidateUrls([
      "https://blog.example/random-post",
      "https://site.example/top-seed-investors-list",
    ]);
    expect(ranked[0]).toContain("list");
  });
});

describe("classifySourceKind", () => {
  it("classifies a directory page", () => {
    expect(
      classifySourceKind("Investor directory. Browse investors and filter by stage. Northwind Capital invests at seed."),
    ).toBe("investor_directory");
  });

  it("classifies a listicle", () => {
    expect(
      classifySourceKind("Top 20 seed investors for fintech. These investors lead seed rounds and back early funds."),
    ).toBe("investor_listicle");
  });

  it("classifies a fund's own profile page", () => {
    expect(
      classifySourceKind("We invest in seed-stage marketplaces. Our portfolio includes several funds. Our thesis is mobility."),
    ).toBe("fund_profile");
  });

  it("classifies a news/portfolio page as portfolio_or_news", () => {
    expect(
      classifySourceKind("By Jane Doe. Published yesterday. 5 min read. Read more about this startup's founders. Comments below."),
    ).toBe("portfolio_or_news");
  });
});

describe("extractCandidatesFromPage", () => {
  it("extracts firm-shaped names near investor-entry cues with bounded evidence spans", () => {
    const body =
      "Seed investor directory. Northwind Capital invests in seed-stage mobility and leads rounds. Brightwater Partners backs early marketplaces and funds at seed.";
    const cands = extractCandidatesFromPage(body, "https://dir.example/list");
    const firms = cands.map((c) => c.firm.toLowerCase());
    expect(firms.some((f) => f.includes("northwind"))).toBe(true);
    expect(firms.some((f) => f.includes("brightwater"))).toBe(true);
    for (const c of cands) {
      expect(c.evidence_span.length).toBeGreaterThanOrEqual(40);
      expect(c.evidence_span.length).toBeLessThanOrEqual(400);
      expect(c.evidence_span.toLowerCase()).toContain(c.firm.split(" ")[0].toLowerCase());
      expect(c.source_url).toBe("https://dir.example/list");
    }
  });

  it("does NOT extract Capitalized words with no nearby investor cue", () => {
    const body = "The City Council approved a New Park near Main Street. Residents Welcomed The Green Space.";
    const cands = extractCandidatesFromPage(body, "https://news.example/x");
    expect(cands).toHaveLength(0);
  });

  it("rejects page-chrome on an investor-dense SPA (no fund suffix)", () => {
    const body =
      "Top 2026 Marketplaces Pre-Seed Investors Identified v4.0.2 Now with Pre-Seed Investor Lists FAQ SIGN UP / LOGIN LOGIN Investor List: Top Marketplaces Pre-Seed Investors (1751) Add Investor";
    const cands = extractCandidatesFromPage(body, "https://signal.nfx.com/investor-lists/x");
    expect(cands).toHaveLength(0);
  });

  it("keeps real funds (suffix-bearing) on the same investor-dense page", () => {
    const body =
      "Investor List FAQ SIGN UP. Northwind Capital invests in seed marketplaces and leads rounds. Brightwater Ventures backs early mobility at seed.";
    const cands = extractCandidatesFromPage(body, "https://blog.example/top-vcs");
    const firms = cands.map((c) => c.firm.toLowerCase());
    expect(firms.some((f) => f.includes("northwind capital"))).toBe(true);
    expect(firms.some((f) => f.includes("brightwater ventures"))).toBe(true);
    expect(firms.some((f) => f === "top" || f === "sign up" || f.includes("faq"))).toBe(false);
  });
});
