
import type { ToolEffect } from "@/services/tools/types";
import { z } from "zod";
import type { McpCallResult, McpTool } from "../types";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { scrubSecretsFromText } from "../egress-secret-scrub";
import { logEvent } from "@/services/logging/logEvent";
import { recordTavilySearch, vendorContext } from "@/services/vendors/usage";

const TAVILY_URL = "https://api.tavily.com/search";

const searchInput = z.object({
  query: z.string().min(2).max(400),
  max_results: z.number().int().min(1).max(10).default(5),
  search_depth: z.enum(["basic", "advanced"]).default("basic"),
  include_answer: z.boolean().default(true),
  topic: z.enum(["general", "news"]).default("general"),
  days: z.number().int().min(1).max(30).optional(),
});

type SpecEntry = { description: string; schema: z.ZodTypeAny; effect: ToolEffect };

const SPECS: Record<string, SpecEntry> = {
  search: {
    description:
      "General web search via Tavily. Returns top-N results (title, url, snippet) plus an optional synthesized answer. Use for competitor lookups, market intel, news, factual research. NOT for Instagram/TikTok content — use web_search__... tools or apify__scrape_instagram instead. Cost ~$0.01/call.",
    schema: searchInput,
    effect: "read",
  },
};

export function listWebSearchTools(): McpTool[] {
  return Object.entries(SPECS).map(([tool_name, spec]) => {
    const schema = zodToJsonSchema(spec.schema);
    if (schema.type !== "object") {
      throw new Error(`web_search/${tool_name} input schema must be a top-level z.object()`);
    }
    return {
      server_id: "web_search",
      tool_name,
      description: spec.description,
      effect: spec.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

export async function callWebSearchTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  run_id?: string,
): Promise<McpCallResult> {
  const start = Date.now();
  const spec = SPECS[tool_name];
  if (!spec) {
    return errorResult(start, "tool_unknown", `web_search/${tool_name} not registered`);
  }
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return errorResult(
      start,
      "web_search_not_configured",
      "TAVILY_API_KEY env var missing. Add to local .env + AWS Secrets Manager praxis-envprod-1.",
    );
  }
  try {
    const parsed = spec.schema.parse(args) as z.infer<typeof searchInput>;
    const { scrubbed: safeQuery, redactions } = scrubSecretsFromText(parsed.query);
    if (redactions.length > 0) {
      await logEvent({
        level: "warn",
        source: "web-search",
        code: "egress_secret_scrubbed",
        meta: { detectors: redactions.slice(0, 10), count: redactions.length },
      });
    }
    const { query: tavilyQuery, include_domains } = splitSiteOperators(safeQuery);
    const res = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: tavilyQuery,
        ...(include_domains.length > 0 ? { include_domains } : {}),
        max_results: parsed.max_results,
        search_depth: parsed.search_depth,
        include_answer: parsed.include_answer,
        topic: parsed.topic,
        ...(parsed.topic === "news" && parsed.days ? { days: parsed.days } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new ExpectedToolError(
          "web_search_auth_failed",
          `Tavily auth failed (${res.status}). Check TAVILY_API_KEY.`,
        );
      }
      if (res.status === 429) {
        throw new ExpectedToolError(
          "web_search_rate_limited",
          "Tavily rate-limited. Retry after a minute.",
        );
      }
      throw new Error(`tavily HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      answer?: string;
      results?: Array<{
        title: string;
        url: string;
        content: string;
        score?: number;
        published_date?: string;
      }>;
    };
    const outer = vendorContext();
    recordTavilySearch(
      { depth: parsed.search_depth, ms: Date.now() - start, results: json.results?.length ?? 0 },
      {
        tenant_id: tenant_id || outer?.tenant_id || null,
        run_id: run_id ?? outer?.run_id ?? null,
        source: outer?.source ?? (run_id ? "run" : "unknown"),
      },
    );
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify({
        answer: json.answer ?? null,
        results: dropOffTopicSiteResults(json.results ?? [], tavilyQuery, include_domains).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content.slice(0, 800),
          published_date: r.published_date ?? null,
        })),
        ...(redactions.length > 0
          ? {
              secret_scrub_note: `${redactions.length} secret-like token(s) were redacted from your query before it was sent to the web — results are for the redacted query. Do not put credentials/tokens in web search queries.`,
            }
          : {}),
      }),
      ms: Date.now() - start,
    };
  } catch (e) {
    if (e instanceof ExpectedToolError) {
      return errorResult(start, e.code, e.message);
    }
    if ((e as { name?: string })?.name === "ZodError") {
      return errorResult(start, "tool_input_invalid", (e as Error).message);
    }
    throw e;
  }
}

export function splitSiteOperators(raw: string): { query: string; include_domains: string[] } {
  const include_domains: string[] = [];
  const pathWords: string[] = [];
  const rest = raw.replace(/(^|\s)-?site:(\S+)/gi, (_m, lead: string, target: string) => {
    if (_m.trimStart().startsWith("-")) return lead;
    const cleaned = target.replace(/^https?:\/\//i, "").replace(/^["']|["']$/g, "");
    const [host, ...path] = cleaned.split("/");
    if (host && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
      if (!include_domains.includes(host.toLowerCase())) include_domains.push(host.toLowerCase());
    }
    for (const seg of path) {
      if (seg && seg !== "status" && seg !== "*") pathWords.push(seg);
    }
    return lead;
  });
  const words = rest.replace(/\s+/g, " ").trim().replace(/^(OR\s+)+|(\s+OR)+$/g, "");
  let query = [words, ...pathWords].filter(Boolean).join(" ").trim();
  if (query.length < 2) query = include_domains[0] ?? raw;
  return { query, include_domains };
}

export function dropOffTopicSiteResults<T extends { title: string; url: string; content: string }>(
  results: T[],
  query: string,
  include_domains: string[],
): T[] {
  if (include_domains.length === 0) return results;
  const words = query
    .toLowerCase()
    .replace(/["()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && w !== "and" && w !== "the" && w !== "or");
  if (words.length === 0) return results;
  return results.filter((r) => {
    const hay = `${r.title} ${r.url} ${r.content}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });
}

function errorResult(start: number, code: string, message: string): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({ error: code, message }),
    ms: Date.now() - start,
  };
}
