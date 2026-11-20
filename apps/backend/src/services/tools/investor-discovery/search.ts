
import { z } from "zod";
import { ExpectedToolError } from "@/services/tools/types";
import type { ToolSpec } from "@/services/tools/types";
import type { CallMcpContext } from "@/services/mcp/execute";
import { callMcpTool } from "@/services/mcp/execute";
import { markDiscoveryRun } from "@/services/agents/engine/capture-ledger";
import {
  buildDiscoveryQueries,
  rankCandidateUrls,
  extractCandidatesFromPage,
  type SourceKind,
} from "./extract";

const DISCOVERY_EXCERPT_BYTES = 64 * 1024;

const DEFAULT_MAX_PAGES = 15;
const HARD_MAX_PAGES = 25;
const CANDIDATE_RETURN_CAP = 120;
const RETURN_MAX_BYTES = 80 * 1024;
const RESULTS_PER_QUERY = 6;

export const investorDiscoverySearchInput = z.object({
  region: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Market geography, e.g. 'US', 'Europe', 'India', 'US/Canada'. Skipped if absent."),
  stage: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Raise stage, e.g. 'pre-seed', 'seed', 'Series A'. Skipped if absent."),
  sector: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Sector / thesis, e.g. 'B2B SaaS', 'fintech', 'marketplace mobility'. Skipped if absent."),
  comparables: z
    .array(z.string().min(1).max(120))
    .max(12)
    .optional()
    .describe(
      "Comparable companies whose backers you want to find, e.g. ['Faire','Gusto']. Drives 'investors who backed X' queries.",
    ),
  max_pages: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Max LIST/DIRECTORY pages to fetch (default ${DEFAULT_MAX_PAGES}, hard cap ${HARD_MAX_PAGES}).`),
});

type InvestorDiscoverySearchInput = z.infer<typeof investorDiscoverySearchInput>;

export type DiscoveredCandidate = {
  firm: string;
  source_url: string;
  evidence_span: string;
  source_kind: SourceKind;
};

export const investorDiscoverySearchTool: ToolSpec = {
  name: "investor_discovery_search",
  effect: "read",
  description:
    "Server-side HUMAN-VOLUME investor discovery. In ONE call: builds category+stage search queries from " +
    "{region, stage, sector, comparables}, finds LIST/DIRECTORY pages of investors on the open web, FETCHES " +
    "the top pages, and returns MANY page-grounded candidate investor firms at once — each with the page it " +
    "was found on (source_url), a short evidence_span from that page, and the page's source_kind. This is the " +
    "PRIMARY way to get investor VOLUME: it does the breadth (dozens of fetches) for you, so you don't loop " +
    "web_fetch by hand. Read-only. Returns { candidates:[{firm, source_url, evidence_span, source_kind}], " +
    "pages_fetched, count }. PRIVACY: pass sector/stage/region/comparables ONLY — never the company or founder name.",
  input_schema: investorDiscoverySearchInput,
  async execute() {
    throw new ExpectedToolError(
      "investor_discovery_misrouted",
      "investor_discovery__search must be dispatched via runInvestorDiscovery with a run-scoped ctx.",
    );
  },
};

type WebFetchContent = {
  body_text?: string;
  final_url?: string;
  capture?: string;
};

type WebSearchContent = {
  results?: Array<{ title?: string; url?: string; snippet?: string }>;
};

export async function runInvestorDiscovery(
  ctx: CallMcpContext,
  rawInput: unknown,
): Promise<{
  candidates: DiscoveredCandidate[];
  pages_fetched: number;
  count: number;
}> {
  const input = investorDiscoverySearchInput.parse(rawInput) as InvestorDiscoverySearchInput;
  const maxPages = Math.min(Math.max(1, input.max_pages ?? DEFAULT_MAX_PAGES), HARD_MAX_PAGES);

  if (ctx.run_id) markDiscoveryRun(ctx.run_id);

  const queries = buildDiscoveryQueries({
    region: input.region,
    stage: input.stage,
    sector: input.sector,
    comparables: input.comparables,
  });

  const seenUrls = new Set<string>();
  const rawUrls: string[] = [];
  for (const query of queries) {
    let res;
    try {
      res = await callMcpTool(ctx, "web_search", "search", {
        query,
        max_results: RESULTS_PER_QUERY,
      });
    } catch {
      continue;
    }
    if (res.is_error) continue;
    let parsed: WebSearchContent;
    try {
      parsed = JSON.parse(res.content) as WebSearchContent;
    } catch {
      continue;
    }
    for (const r of parsed.results ?? []) {
      const url = (r?.url ?? "").trim();
      if (!url) continue;
      const key = url.toLowerCase();
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      rawUrls.push(url);
    }
  }

  const rankedUrls = rankCandidateUrls(rawUrls).slice(0, maxPages);

  const candidates: DiscoveredCandidate[] = [];
  let pagesFetched = 0;
  for (const url of rankedUrls) {
    if (candidates.length >= CANDIDATE_RETURN_CAP) break;
    let res;
    try {
      res = await callMcpTool(ctx, "web_fetch", "fetch", {
        url,
        max_excerpt_bytes: DISCOVERY_EXCERPT_BYTES,
      });
    } catch {
      continue;
    }
    if (res.is_error) continue;
    let parsed: WebFetchContent;
    try {
      parsed = JSON.parse(res.content) as WebFetchContent;
    } catch {
      continue;
    }
    const body = parsed.body_text;
    if (typeof body !== "string" || body.length === 0) continue;
    pagesFetched += 1;
    const sourceUrl = (parsed.final_url ?? url).trim() || url;
    const pageCandidates = extractCandidatesFromPage(body, sourceUrl);
    for (const c of pageCandidates) {
      if (candidates.length >= CANDIDATE_RETURN_CAP) break;
      candidates.push(c);
    }
  }

  const deduped: DiscoveredCandidate[] = [];
  const seenFirm = new Set<string>();
  for (const c of candidates) {
    const key = c.firm.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenFirm.has(key)) continue;
    seenFirm.add(key);
    deduped.push(c);
    if (deduped.length >= CANDIDATE_RETURN_CAP) break;
  }

  while (
    deduped.length > 0 &&
    Buffer.byteLength(JSON.stringify(deduped), "utf8") > RETURN_MAX_BYTES
  ) {
    deduped.pop();
  }

  return { candidates: deduped, pages_fetched: pagesFetched, count: deduped.length };
}
