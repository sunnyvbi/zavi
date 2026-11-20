import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  askEngine,
  normalizeResponsesResult,
  normalizeScraperResult,
  requestFor,
  taskResultOf,
} from "../dataforseo";
import { engineDef } from "../engines";

const envelope = (result: unknown, over: Record<string, unknown> = {}) => ({
  status_code: 20000,
  status_message: "Ok.",
  cost: 0.0296,
  tasks: [{ id: "t1", status_code: 20000, status_message: "Ok.", cost: 0.0296, result: [result], ...over }],
});

const RESPONSES_RESULT = {
  model_name: "claude-sonnet-4-20250514",
  money_spent: 0.029,
  items: [
    { type: "reasoning", sections: [{ type: "summary_text", text: "thinking…" }] },
    {
      type: "message",
      sections: [
        {
          type: "text",
          text: "Upcar and Turo both rent cars.",
          annotations: [
            { title: "Upcar pricing", url: "https://upcar.ai/pricing" },
            { title: "Upcar pricing", url: "https://upcar.ai/pricing" },
            { title: "junk", url: "javascript:alert(1)" },
          ],
        },
      ],
    },
  ],
  fan_out_queries: ["car rental apps 2026"],
};

const SCRAPER_RESULT = {
  model: "gpt-4o",
  markdown: "## Options\n- Turo\n- Getaround",
  sources: [{ type: "chat_gpt_source", title: "Turo", domain: "turo.com", url: "https://turo.com/" }],
  items: [{ type: "chat_gpt_text", sources: [{ title: "Reddit", domain: "reddit.com", url: "https://reddit.com/r/x" }] }],
  fan_out_queries: ["best p2p car rental"],
};

describe("normalisers", () => {
  it("llm_responses: message text only, annotations as citations, deduped and URL-validated", () => {
    const n = normalizeResponsesResult(RESPONSES_RESULT);
    expect(n.text).toBe("Upcar and Turo both rent cars.");
    expect(n.citations).toEqual([{ url: "https://upcar.ai/pricing", title: "Upcar pricing", domain: null }]);
    expect(n.fan_out_queries).toEqual(["car rental apps 2026"]);
    expect(n.model).toBe("claude-sonnet-4-20250514");
  });

  it("llm_responses: citation-split fragments are concatenated, so a cited list item stays one line", () => {
    const n = normalizeResponsesResult({
      items: [
        {
          type: "message",
          sections: [
            { type: "text", text: "Top picks:\n- ", annotations: [] },
            { type: "text", text: "NoimosAI runs a personal AI marketing team", annotations: [{ title: "n", url: "https://noimosai.com/a" }] },
            { type: "text", text: ".\n- Okara for multi-channel teams.", annotations: [] },
            { type: "text", text: "\n\n", annotations: [] },
            { type: "text", text: "Start small.", annotations: [] },
          ],
        },
      ],
    });
    expect(n.text).toBe(
      "Top picks:\n- NoimosAI runs a personal AI marketing team.\n- Okara for multi-channel teams.\n\nStart small.",
    );
  });

  it("llm_scraper: markdown, then top-level sources, then item sources", () => {
    const n = normalizeScraperResult(SCRAPER_RESULT);
    expect(n.text).toContain("Turo");
    expect(n.citations.map((c) => c.url)).toEqual(["https://turo.com/", "https://reddit.com/r/x"]);
  });

  it("task envelope: surfaces top-level and task-level errors with their cost", () => {
    expect(taskResultOf({ status_code: 40100 })).toEqual({ error_code: "dataforseo_40100", cost_usd: null });
    expect(taskResultOf(envelope(null, { status_code: 40501, cost: 0 }))).toEqual({
      error_code: "dataforseo_task_40501",
      cost_usd: 0,
    });
    expect("result" in taskResultOf(envelope(SCRAPER_RESULT))).toBe(true);
  });
});

describe("requestFor", () => {
  const opts = { locationCode: 2356, languageCode: "en", country: "IN", models: { claude: "claude-sonnet-5", perplexity: "sonar" } };

  it("uses the consumer scraper for ChatGPT (forced web search) and Gemini", () => {
    const r = requestFor(engineDef("chatgpt")!, "best car rental app", opts);
    expect(r.path).toBe("/chat_gpt/llm_scraper/live/advanced");
    expect(r.body[0]).toMatchObject({ keyword: "best car rental app", location_code: 2356, language_code: "en", force_web_search: true });
    const g = requestFor(engineDef("gemini")!, "x", opts);
    expect(g.path).toBe("/gemini/llm_scraper/live/advanced");
    expect(g.body[0]).not.toHaveProperty("force_web_search");
  });

  it("uses llm_responses for Claude (web search on) and Perplexity (Sonar searches by default)", () => {
    const c = requestFor(engineDef("claude")!, "q", opts);
    expect(c.path).toBe("/claude/llm_responses/live");
    expect(c.body[0]).toMatchObject({ model_name: "claude-sonnet-5", web_search: true, web_search_country_iso_code: "IN" });
    const p = requestFor(engineDef("perplexity")!, "q", opts);
    expect(p.path).toBe("/perplexity/llm_responses/live");
    expect(p.body[0]).toMatchObject({ model_name: "sonar" });
    expect(p.body[0]).not.toHaveProperty("web_search");
  });
});

describe("askEngine", () => {
  const opts = { locationCode: 2840, languageCode: "en", country: "US", models: { claude: "c", perplexity: "sonar" } };
  const json = (body: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  beforeEach(() => {
    process.env.DATAFORSEO_LOGIN = "login";
    process.env.DATAFORSEO_PASSWORD = "password";
  });
  afterEach(() => {
    delete process.env.DATAFORSEO_LOGIN;
    delete process.env.DATAFORSEO_PASSWORD;
  });

  it("refuses without credentials and makes no call", async () => {
    delete process.env.DATAFORSEO_LOGIN;
    const fetch = vi.fn();
    const r = await askEngine(engineDef("chatgpt")!, "q", opts, { fetch });
    expect(r).toMatchObject({ ok: false, error_code: "dataforseo_not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns the answer with DataForSEO's own task cost", async () => {
    const fetch = vi.fn().mockResolvedValue(json(envelope(SCRAPER_RESULT)));
    const r = await askEngine(engineDef("chatgpt")!, "q", opts, { fetch });
    expect(r).toMatchObject({ ok: true, cost_usd: 0.0296, data_source: "dataforseo.llm_scraper", model: "gpt-4o" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: `Basic ${Buffer.from("login:password").toString("base64")}` });
  });

  it("retries once on a transient HTTP status", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json(envelope(SCRAPER_RESULT)));
    const r = await askEngine(engineDef("chatgpt")!, "q", opts, { fetch, sleep: async () => {} });
    expect(r.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a timeout — the task may already have been billed", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetch = vi.fn().mockRejectedValue(abort);
    const r = await askEngine(engineDef("claude")!, "q", opts, { fetch, sleep: async () => {} });
    expect(r).toMatchObject({ ok: false, error_code: "dataforseo_timeout" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a task-level error, and keeps its cost", async () => {
    const fetch = vi.fn().mockResolvedValue(json(envelope(null, { status_code: 50000, cost: 0.0006 })));
    const r = await askEngine(engineDef("claude")!, "q", opts, { fetch });
    expect(r).toMatchObject({ ok: false, error_code: "dataforseo_task_50000", cost_usd: 0.0006 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("records DataForSEO's own code from a 4xx body — 40104 says 'verify your account'", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ status_code: 40104, status_message: "Please verify your account" }, 403));
    const r = await askEngine(engineDef("gemini")!, "q", opts, { fetch });
    expect(r).toMatchObject({ ok: false, error_code: "dataforseo_40104" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("treats an empty answer as a failed slot, not a 0% answer", async () => {
    const fetch = vi.fn().mockResolvedValue(json(envelope({ markdown: "", sources: [] })));
    const r = await askEngine(engineDef("gemini")!, "q", opts, { fetch });
    expect(r).toMatchObject({ ok: false, error_code: "dataforseo_empty_answer" });
  });
});
