// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { GeoMetricsPayload } from "./types";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { GeoChannelPanel } from "./GeoChannelPanel";

afterEach(cleanup);

const rate = (numerator: number, denominator: number, margin: number) => ({
  numerator,
  denominator,
  rate: numerator / denominator,
  ci95: { low: 0, high: 1 },
  margin_pp: margin,
});

const payload = (over: Partial<GeoMetricsPayload> = {}): GeoMetricsPayload => ({
  readiness: {
    status: "ok",
    site: "https://example.com",
    fetched_at: "2026-09-17T00:00:00.000Z",
    pages_analyzed: 4,
    score: {
      total: 75,
      bands: [
        { key: "citability", label: "Passage citability", weight: 25, score: 68, note: "Is there an answer to lift?" },
      ],
    },
    completeness: { below_floor: false, warning: null },
    disclosure: "Our own heuristic.",
    crawlers: [{ name: "OAI-SearchBot", recommended: true, state: "allowed" }],
    llms_txt: true,
    findings: [
      { code: "no_specific_figures", severity: "medium", summary: "3 pages state no figure.", urls: [] },
    ],
    not_checked: [],
    grade: "high",
  },
  visibility: {
    state: "ok",
    country: "US",
    window_days: 30,
    metrics: {
      disclosure: "Sampled.",
      responses: { planned: 300, collected: 288, failed: 12, sweeps: 2, prompts: 24, engines: 4 },
      mention_rate: {
        ...rate(155, 288, 5.8),
        by_engine: [
          { engine: "chatgpt", label: "ChatGPT", ...rate(56, 72, 11) },
          { engine: "claude", label: "Claude", ...rate(32, 72, 11) },
          { engine: "gemini", label: "Gemini", ...rate(20, 72, 11) },
          { engine: "perplexity", label: "Perplexity", ...rate(45, 72, 11) },
        ],
      },
      citation_rate: { ...rate(89, 288, 5.3), by_engine: [] },
      source_mix: {
        domains: [
          { domain: "example.com", responses: 40, used: 0.41, citations: 82, kind: "owned", rival: null },
          { domain: "www.reddit.com", responses: 21, used: 0.22, citations: 44, kind: "other", rival: null },
        ],
        domains_total: 2,
      },
      share_of_voice: {
        state: "ok",
        share: 0.18,
        brand_mentions: 36,
        rival_mentions: 164,
        rivals: [{ name: "Revv", mentions: 164, share: 0.82 }],
      },
    },
    deltas: {
      mention_rate: { delta_pp: 6, significant: true },
      citation_rate: { delta_pp: 4, significant: true },
      share_of_voice: { delta_pp: 0.4, significant: false },
    },
    running: null,
    history: [
      {
        sweep_id: "a",
        finished_at: "2026-09-03T00:00:00.000Z",
        mention_rate: 0.48,
        citation_rate: 0.27,
        share_of_voice: 0.18,
        rival_set_changed: false,
        prompt_set_changed: false,
      },
      {
        sweep_id: "b",
        finished_at: "2026-09-16T00:00:00.000Z",
        mention_rate: 0.54,
        citation_rate: 0.31,
        share_of_voice: 0.18,
        rival_set_changed: false,
        prompt_set_changed: false,
      },
    ],
    config: {
      enabled: true,
      configured: true,
      brand: "Upcar",
      prompts_active: 24,
      suggestions_pending: 0,
      engines: [
        { id: "chatgpt", label: "ChatGPT" },
        { id: "claude", label: "Claude" },
        { id: "gemini", label: "Gemini" },
        { id: "perplexity", label: "Perplexity" },
      ],
      countries: [{ country: "US", label: "United States", tracked: true }],
    },
  },
  crawler_hits: {
    disclosure: "Counted from the logs you send us.",
    state: "ok",
    window_days: 30,
    ingest: {
      connected: true,
      created_at: "2026-07-01T00:00:00.000Z",
      last_received_at: "2026-09-16T00:00:00.000Z",
    },
    totals: { hits: 900, blocked_hits: 4 },
    bots: [
      {
        bot: "Claude-SearchBot",
        owner: "Anthropic",
        class: "search",
        recommended: true,
        hits: 0,
        blocked_hits: 0,
        robots: { state: "blocked" },
        callout: null,
      },
    ],
    daily: Array.from({ length: 30 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 7, 18) + i * 86_400_000).toISOString().slice(0, 10),
      hits: i >= 23 ? 87 : 20,
      blocked_hits: 0,
      by_class: { search: i >= 23 ? 60 : 12, user: i >= 23 ? 17 : 5, training: i >= 23 ? 10 : 3 },
    })),
  },
  ...over,
});

function serve(body: GeoMetricsPayload) {
  apiFetch.mockImplementation(async (path: string) => {
    // eslint-disable-next-line no-console
    if (path === undefined) console.log("CALL-UNDEF", new Error().stack);
    if (String(path).startsWith("/api/geo/metrics")) return { ok: true, json: async () => body };
    return { ok: false, json: async () => ({}) };
  });
}

beforeEach(() => {
  apiFetch.mockReset();
});

describe("GeoChannelPanel", () => {
  it("prints each sampled rate with its interval and its sample size", async () => {
    serve(payload());
    render(<GeoChannelPanel fixes={null} />);

    expect(await screen.findByText("54%")).toBeTruthy();
    expect(screen.getByText("31%")).toBeTruthy();
    expect(screen.getByText("18%")).toBeTruthy();
    expect(screen.getByText("±5.8 pts · 288 answers")).toBeTruthy();
    expect(screen.getByText(/United States · last 30 days · 288 answers/)).toBeTruthy();
  });

  it("gives a real move its arrow and leaves noise without one", async () => {
    serve(payload());
    render(<GeoChannelPanel fixes={null} />);

    expect(await screen.findByText("▲ 6 pts")).toBeTruthy();
    expect(screen.getByText("+0.4 pts")).toBeTruthy();
  });

  it("shows the crawler window, its change, and the bot being turned away", async () => {
    serve(payload());
    render(<GeoChannelPanel fixes={null} />);

    expect(await screen.findByText("609")).toBeTruthy();
    expect(screen.getByText("▲ 335%")).toBeTruthy();
    expect(screen.getByText("Claude-SearchBot")).toBeTruthy();
    expect(screen.getByText("blocked")).toBeTruthy();
  });

  it("scores readiness as a heuristic and never averages it with the sample", async () => {
    serve(payload());
    render(<GeoChannelPanel fixes={null} />);

    expect(await screen.findByText("On track")).toBeTruthy();
    expect(screen.getByText(/Our heuristic · 4 pages read/)).toBeTruthy();
    expect(screen.getByText("8/9")).toBeTruthy();
    expect(screen.getByText("Specific figures")).toBeTruthy();
  });

  it("names WHY there is no sample, and keeps the other two tiers on screen", async () => {
    const p = payload();
    const v = p.visibility as Extract<GeoMetricsPayload["visibility"], { state: string }>;
    serve(
      payload({
        visibility: {
          ...v,
          state: "never_run",
          metrics: null,
          history: [],
          config: { ...v.config, prompts_active: 12 },
        },
      }),
    );
    render(<GeoChannelPanel fixes={null} />);

    expect(await screen.findByText("No answers sampled yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Run now/ })).toBeTruthy();
    expect(screen.getByText("On track")).toBeTruthy();
    expect(screen.getByText("609")).toBeTruthy();
  });

  it("lets one lane fail without blanking the others", async () => {
    serve(payload({ crawler_hits: { error: true } }));
    render(<GeoChannelPanel fixes={null} />);

    expect(await screen.findByText(/couldn't read your crawler logs/i)).toBeTruthy();
    expect(screen.getByText("54%")).toBeTruthy();
    expect(screen.getByText("On track")).toBeTruthy();
  });

  it("starts the prompt set itself when nothing is tracked", async () => {
    const p = payload();
    const v = p.visibility as Extract<GeoMetricsPayload["visibility"], { state: string }>;
    const empty = payload({
      visibility: {
        ...v,
        state: "no_prompts",
        metrics: null,
        history: [],
        config: { ...v.config, prompts_active: 0 },
      },
    });
    const calls: string[] = [];
    apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.startsWith("/api/geo/metrics")) return { ok: true, json: async () => empty };
      if (path === "/api/geo/prompts") {
        return { ok: true, json: async () => ({ active: [], suggested: [] }) };
      }
      if (path === "/api/geo/prompts/starter") {
        return { ok: true, json: async () => ({ ok: true, state: "started", active: [], accepted: 5 }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    render(<GeoChannelPanel fixes={null} />);

    expect(await screen.findByText("Zavi is starting your prompt set")).toBeTruthy();
    await waitFor(() => expect(calls).toContain("POST /api/geo/prompts/starter"));
  });

  it("never seeds a set that already has prompts", async () => {
    const calls: string[] = [];
    apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.startsWith("/api/geo/metrics")) return { ok: true, json: async () => payload() };
      return { ok: true, json: async () => ({ active: [], suggested: [] }) };
    });
    render(<GeoChannelPanel fixes={null} />);

    await screen.findByText("54%");
    expect(calls).not.toContain("POST /api/geo/prompts/starter");
  });

  it("says the read failed rather than showing zeros", async () => {
    apiFetch.mockImplementation(async () => ({ ok: false, json: async () => ({}) }));
    render(<GeoChannelPanel fixes={null} />);

    await waitFor(() => expect(screen.getByText(/Couldn't load the GEO numbers/)).toBeTruthy());
    expect(screen.queryByText("0%")).toBeNull();
  });
});
