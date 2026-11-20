
import type { GeoEngine, EngineDef } from "./engines";
import { reportIfOutOfCredit } from "./dataforseo-credit";
import { recordDataForSeoTask } from "@/services/vendors/usage";

export const DATAFORSEO_BASE = "https://api.dataforseo.com/v3/ai_optimization";

export const DATAFORSEO_TIMEOUT_MS = 130_000;

export const MAX_ANSWER_CHARS = 20_000;
export const MAX_FAN_OUT_QUERIES = 20;

export function dataForSeoConfigured(): boolean {
  return Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

export type RawCitation = { url: string; title: string | null; domain: string | null };

export type EngineAnswer =
  | {
      ok: true;
      text: string;
      citations: RawCitation[];
      fan_out_queries: string[];
      model: string | null;
      cost_usd: number | null;
      data_source: string;
    }
  | {
      ok: false;
      error_code: string;
      cost_usd: number | null;
      data_source: string;
    };

export type AskOptions = {
  locationCode: number;
  languageCode: string;
  country: string;
  models: { claude: string; perplexity: string };
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const OK = 20000;

const asObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function citationOf(v: unknown): RawCitation | null {
  const o = asObj(v);
  const url = asStr(o?.url);
  if (!o || !url || !/^https?:\/\//i.test(url)) return null;
  return { url, title: asStr(o.title), domain: asStr(o.domain) };
}

function dedupeByUrl(list: RawCitation[]): RawCitation[] {
  const seen = new Set<string>();
  const out: RawCitation[] = [];
  for (const c of list) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

function fanOutOf(result: Record<string, unknown>): string[] {
  return asArr(result.fan_out_queries)
    .map(asStr)
    .filter((q): q is string => q !== null)
    .map((q) => q.slice(0, 300))
    .slice(0, MAX_FAN_OUT_QUERIES);
}

export function taskResultOf(
  body: unknown,
): { result: Record<string, unknown>; cost_usd: number | null } | { error_code: string; cost_usd: number | null } {
  const top = asObj(body);
  if (!top) return { error_code: "dataforseo_bad_body", cost_usd: null };
  const topCode = asNum(top.status_code);
  const task = asObj(asArr(top.tasks)[0]);
  const cost = asNum(task?.cost) ?? asNum(top.cost);
  if (topCode !== OK) return { error_code: `dataforseo_${topCode ?? "unknown"}`, cost_usd: cost };
  if (!task) return { error_code: "dataforseo_no_task", cost_usd: cost };
  const taskCode = asNum(task.status_code);
  if (taskCode !== OK) return { error_code: `dataforseo_task_${taskCode ?? "unknown"}`, cost_usd: cost };
  const result = asObj(asArr(task.result)[0]);
  if (!result) return { error_code: "dataforseo_no_result", cost_usd: cost };
  return { result, cost_usd: cost };
}

export function normalizeScraperResult(result: Record<string, unknown>): {
  text: string;
  citations: RawCitation[];
  fan_out_queries: string[];
  model: string | null;
} {
  const text = asStr(result.markdown) ?? "";
  const top = asArr(result.sources).map(citationOf);
  const items = asArr(result.items).flatMap((it) => asArr(asObj(it)?.sources).map(citationOf));
  const citations = dedupeByUrl([...top, ...items].filter((c): c is RawCitation => c !== null));
  return { text, citations, fan_out_queries: fanOutOf(result), model: asStr(result.model) };
}

export function normalizeResponsesResult(result: Record<string, unknown>): {
  text: string;
  citations: RawCitation[];
  fan_out_queries: string[];
  model: string | null;
} {
  const sections = asArr(result.items)
    .map(asObj)
    .filter((it): it is Record<string, unknown> => it !== null && it.type === "message")
    .flatMap((it) => asArr(it.sections).map(asObj))
    .filter((s): s is Record<string, unknown> => s !== null && (s.type === "text" || s.type === undefined));
  const text = sections
    .map((s) => (typeof s.text === "string" ? s.text : ""))
    .join("");
  const citations = dedupeByUrl(
    sections
      .flatMap((s) => asArr(s.annotations).map(citationOf))
      .filter((c): c is RawCitation => c !== null),
  );
  return { text, citations, fan_out_queries: fanOutOf(result), model: asStr(result.model_name) };
}

export function requestFor(
  engine: EngineDef,
  prompt: string,
  opts: AskOptions,
): { path: string; body: Record<string, unknown>[] } {
  if (engine.endpoint === "llm_scraper") {
    const body: Record<string, unknown> = {
      keyword: prompt,
      location_code: opts.locationCode,
      language_code: opts.languageCode,
    };
    if (engine.id === "chatgpt") body.force_web_search = true;
    return { path: `/${engine.dataforseo_se}/llm_scraper/live/advanced`, body: [body] };
  }
  const base: Record<string, unknown> = {
    user_prompt: prompt,
    max_output_tokens: 4096,
    web_search_country_iso_code: opts.country,
  };
  if (engine.id === "claude") {
    return {
      path: `/claude/llm_responses/live`,
      body: [{ ...base, model_name: opts.models.claude, web_search: true, force_web_search: true }],
    };
  }
  return {
    path: `/perplexity/llm_responses/live`,
    body: [{ ...base, model_name: opts.models.perplexity }],
  };
}

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

export async function askEngine(
  engine: EngineDef,
  prompt: string,
  opts: AskOptions,
  deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<EngineAnswer> {
  const startedAt = Date.now();
  const answer = await askEngineOnce(engine, prompt, opts, deps);
  recordDataForSeoTask({ endpoint: engine.endpoint, cost_usd: answer.cost_usd, ms: Date.now() - startedAt });
  if (!answer.ok) reportIfOutOfCredit(answer.error_code, answer.data_source);
  return answer;
}

async function askEngineOnce(
  engine: EngineDef,
  prompt: string,
  opts: AskOptions,
  deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void> },
): Promise<EngineAnswer> {
  const data_source = `dataforseo.${engine.endpoint}`;
  if (!dataForSeoConfigured()) {
    return { ok: false, error_code: "dataforseo_not_configured", cost_usd: null, data_source };
  }
  const doFetch: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const { path, body } = requestFor(engine, prompt, opts);
  const auth = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`,
  ).toString("base64");

  let lastError = "dataforseo_network";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(2_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DATAFORSEO_TIMEOUT_MS);
    try {
      const res = await doFetch(`${DATAFORSEO_BASE}${path}`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        let vendorCode: number | null = null;
        try {
          vendorCode = asNum(asObj(await res.json())?.status_code);
        } catch {
        }
        lastError = vendorCode ? `dataforseo_${vendorCode}` : `dataforseo_http_${res.status}`;
        if (RETRYABLE_HTTP.has(res.status)) continue;
        return { ok: false, error_code: lastError, cost_usd: null, data_source };
      }
      const parsed = taskResultOf(await res.json());
      if ("error_code" in parsed) {
        return { ok: false, error_code: parsed.error_code, cost_usd: parsed.cost_usd, data_source };
      }
      const n =
        engine.endpoint === "llm_scraper"
          ? normalizeScraperResult(parsed.result)
          : normalizeResponsesResult(parsed.result);
      if (n.text.trim() === "") {
        return { ok: false, error_code: "dataforseo_empty_answer", cost_usd: parsed.cost_usd, data_source };
      }
      return {
        ok: true,
        text: n.text.slice(0, MAX_ANSWER_CHARS),
        citations: n.citations,
        fan_out_queries: n.fan_out_queries,
        model: n.model,
        cost_usd: parsed.cost_usd,
        data_source,
      };
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        return { ok: false, error_code: "dataforseo_timeout", cost_usd: null, data_source };
      }
      lastError = "dataforseo_network";
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error_code: lastError, cost_usd: null, data_source };
}

export type { GeoEngine };
