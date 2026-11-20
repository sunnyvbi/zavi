// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { pathOf, seoIssues, SEO_CHECKING, SEO_NO_ISSUES, SEO_NOT_LIVE, SEO_STALE, SiteSeoView, type SiteSeoPayload } from "./SiteSeoView";
import { PAYMENTS_NONE_TITLE, PAYMENTS_UNUSED_KEY, paymentsState, SitePaymentsBody } from "./SitePaymentsView";
import type { SiteFunctionsPayload } from "./SiteFunctionsSettings";

const BUILD = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const LIVE = "https://hale-ortiz-9f8e7d6c.zaviagent.com";

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

type Ready = Extract<SiteSeoPayload, { state: "ready" | "error" }>;
function report(over: Partial<Ready> = {}): Ready {
  return {
    state: "ready",
    url: LIVE,
    fetched_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    current: true,
    error_code: null,
    notes: [],
    seo: {
      pages_analyzed: 3,
      findings: [
        { code: "meta_description_missing", severity: "medium", summary: "x", urls: [`${LIVE}/practice-areas`, `${LIVE}/contact`] },
        { code: "robots_disallow_all", severity: "blocker", summary: "x", urls: [`${LIVE}/robots.txt`] },
      ],
      pages: [
        { url: `${LIVE}/`, status: 200, title: "Hale & Ortiz | Family law", meta_description: "Family law in Denver.", noindex: false, visible_words: 300 },
        { url: `${LIVE}/contact`, status: 200, title: "Contact", meta_description: null, noindex: false, visible_words: 40 },
      ],
    },
    geo: {
      score: { total: 62 },
      crawlers: [
        { name: "GPTBot", owner: "OpenAI", state: "allowed", recommended: true },
        { name: "PerplexityBot", owner: "Perplexity", state: "partial", recommended: true },
        { name: "ClaudeBot", owner: "Anthropic", state: "blocked", recommended: true },
        { name: "Bytespider", owner: "ByteDance", state: "allowed", recommended: false },
      ],
      llms_txt: false,
      findings: [{ code: "no_answer_passage", severity: "high", summary: "No page opens with a short answer an assistant can quote.", urls: [`${LIVE}/`] }],
      not_checked: ["whether any assistant cites you today"],
    },
    refresh_after: null,
    ...over,
  };
}

beforeEach(() => apiFetch.mockReset());
afterEach(() => cleanup());

describe("seoIssues", () => {
  it("lists search and AI issues most severe first, in founder words, each with a chat request", () => {
    const issues = seoIssues(report());
    expect(issues.map((i) => [i.severity, i.area])).toEqual([
      ["blocker", "Search"],
      ["high", "AI search"],
      ["medium", "Search"],
    ]);
    expect(issues[2].title).toBe("2 pages have no meta description");
    expect(issues[2].request).toBe("Fix this on my site: 2 pages have no meta description.");
    expect(issues[1].title).toBe("No page opens with a short answer an assistant can quote.");
    expect(pathOf(`${LIVE}/contact`)).toBe("/contact");
  });

  it("titles a finding on Markdown files only as files, not pages", () => {
    const base = report();
    const issues = seoIssues({
      ...base,
      seo: {
        ...base.seo!,
        non_html_urls: [`${LIVE}/auth.md`],
        findings: [{ code: "noindex", severity: "high", summary: "x", urls: [`${LIVE}/auth.md`] }],
      },
      geo: null,
    });
    expect(issues[0].title).toBe("1 file tells search engines not to list it");
    const mixed = seoIssues({
      ...base,
      seo: {
        ...base.seo!,
        non_html_urls: [`${LIVE}/auth.md`],
        findings: [{ code: "noindex", severity: "high", summary: "x", urls: [`${LIVE}/contact`, `${LIVE}/auth.md`] }],
      },
      geo: null,
    });
    expect(mixed[0].title).toBe("1 page tells search engines not to list it, plus 1 other file");
    expect(mixed[0].request).toContain("plus 1 other file");
  });
});

describe("SiteSeoView", () => {
  it("before the site is live: explains and checks nothing", () => {
    render(<SiteSeoView buildSessionId={BUILD} deployedUrl={null} canRefresh />);
    expect(screen.getByText(SEO_NOT_LIVE)).toBeTruthy();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("says a first check takes a while, then shows issues, pages as search shows them, and the AI crawlers", async () => {
    apiFetch.mockResolvedValue(json(200, report()));
    render(<SiteSeoView buildSessionId={BUILD} deployedUrl={LIVE} canRefresh />);
    expect(screen.getByText(SEO_CHECKING)).toBeTruthy();
    expect(await screen.findByText("robots.txt blocks every search engine from the whole site")).toBeTruthy();
    expect(screen.getByText("62")).toBeTruthy();
    expect(screen.getByText("2 of 3 AI crawlers may read your site")).toBeTruthy();
    expect(screen.getByText("Hale & Ortiz | Family law")).toBeTruthy();
    expect(screen.getByText(/No description: search engines pick their own snippet/)).toBeTruthy();
    expect(screen.queryByText("Bytespider")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Copy request/ })).toHaveLength(3);
    expect(String(apiFetch.mock.calls[0][0])).toBe(`/api/website/site-seo?build_session_id=${BUILD}`);
  });

  it("says when the check is older than the live version, and when nothing needs fixing", async () => {
    apiFetch.mockResolvedValue(json(200, report({ current: false, seo: { pages_analyzed: 1, findings: [], pages: [{ url: `${LIVE}/`, status: 200, title: "Home", meta_description: "x", noindex: false, visible_words: 300 }] }, geo: null })));
    render(<SiteSeoView buildSessionId={BUILD} deployedUrl={LIVE} canRefresh />);
    expect(await screen.findByText(SEO_STALE)).toBeTruthy();
    expect(screen.getByText(SEO_NO_ISSUES)).toBeTruthy();
  });

  it("a check that read only Markdown files says so instead of 'every page we checked'", async () => {
    apiFetch.mockResolvedValue(json(200, report({ seo: { pages_analyzed: 2, non_html_urls: [`${LIVE}/a.md`, `${LIVE}/b.md`], findings: [], pages: [] }, geo: null })));
    render(<SiteSeoView buildSessionId={BUILD} deployedUrl={LIVE} canRefresh />);
    expect(await screen.findByText("Read 2 files, none of them a web page.")).toBeTruthy();
    expect(screen.queryByText(SEO_NO_ISSUES)).toBeNull();
  });

  it("Check again posts a refresh and is held while the last check is fresh", async () => {
    apiFetch.mockResolvedValueOnce(json(200, report()));
    render(<SiteSeoView buildSessionId={BUILD} deployedUrl={LIVE} canRefresh />);
    const button = await screen.findByRole("button", { name: /Check again/ });
    apiFetch.mockResolvedValueOnce(json(200, report({ refresh_after: new Date(Date.now() + 60_000).toISOString() })));
    fireEvent.click(button);
    const [url, init] = apiFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/website/site-seo/refresh");
    expect(JSON.parse(String(init.body))).toEqual({ build_session_id: BUILD });
    await vi.waitFor(() => expect((screen.getByRole("button", { name: /Check again/ }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("a site that did not answer says so, plainly", async () => {
    apiFetch.mockResolvedValue(json(200, report({ state: "error", error_code: "seo_site_unreachable", seo: null, geo: null })));
    render(<SiteSeoView buildSessionId={BUILD} deployedUrl={LIVE} canRefresh />);
    expect(await screen.findByText("We couldn’t read your site")).toBeTruthy();
  });

  it("a member sees the check but no Check again", async () => {
    apiFetch.mockResolvedValue(json(200, report()));
    render(<SiteSeoView buildSessionId={BUILD} deployedUrl={LIVE} canRefresh={false} />);
    expect(await screen.findByText("62")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Check again/ })).toBeNull();
  });

  it("Check again comes back by itself when the cooldown ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      apiFetch.mockResolvedValue(json(200, report({ refresh_after: new Date(Date.now() + 30_000).toISOString() })));
      render(<SiteSeoView buildSessionId={BUILD} deployedUrl={LIVE} canRefresh />);
      const button = (await screen.findByRole("button", { name: /Check again/ })) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(31_000);
      });
      expect((screen.getByRole("button", { name: /Check again/ }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed read can be retried", async () => {
    apiFetch.mockResolvedValueOnce(json(503, { error: { code: "seo_unavailable", message: "Couldn't check your site right now. Try again in a moment." } }));
    render(<SiteSeoView buildSessionId={BUILD} deployedUrl={LIVE} canRefresh />);
    expect(await screen.findByText(/Couldn't check your site right now/)).toBeTruthy();
    apiFetch.mockResolvedValueOnce(json(200, report()));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("62")).toBeTruthy();
  });
});

describe("Payments", () => {
  const fns = (required: string[], added: string[]): SiteFunctionsPayload => ({
    secrets: { secrets: added.map((name) => ({ name, updated_at: "2026-10-02T00:00:00Z" })), required },
    functions: [
      { name: "create-checkout", kind: "http", url: null, cron: null, enabled: null, last_run: null },
      { name: "stripe-webhook", kind: "webhook", url: null, cron: null, enabled: null, last_run: null },
      { name: "nightly", kind: "schedule", url: null, cron: "0 3 * * *", enabled: true, last_run: null },
    ],
  });

  it("tells apart no payments, a missing key and a ready key", () => {
    expect(paymentsState(fns([], ["MAILER_KEY"]))).toEqual({ kind: "none" });
    expect(paymentsState(fns([], ["STRIPE_SECRET_KEY"]))).toEqual({ kind: "unused_key", keys: ["STRIPE_SECRET_KEY"] });
    expect(paymentsState(fns(["STRIPE_SECRET_KEY", "MAILER_KEY"], []))).toEqual({
      kind: "needs_key",
      missing: ["STRIPE_SECRET_KEY"],
      functions: ["create-checkout", "stripe-webhook"],
    });
    expect(paymentsState(fns(["STRIPE_SECRET_KEY"], ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]))).toMatchObject({
      kind: "key_added",
      keys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    });
  });

  it("sends the founder to Secrets for a missing key, and never claims payments are live", () => {
    const open = vi.fn();
    render(<SitePaymentsBody data={fns(["STRIPE_SECRET_KEY"], [])} onOpenSecrets={open} />);
    fireEvent.click(screen.getByRole("button", { name: /Add it in Secrets/ }));
    expect(open).toHaveBeenCalled();
    cleanup();
    render(<SitePaymentsBody data={fns([], [])} onOpenSecrets={open} />);
    expect(screen.getByText(PAYMENTS_NONE_TITLE)).toBeTruthy();
    cleanup();
    render(<SitePaymentsBody data={fns([], ["STRIPE_SECRET_KEY"])} onOpenSecrets={open} />);
    expect(screen.getByText(PAYMENTS_UNUSED_KEY)).toBeTruthy();
    cleanup();
    render(<SitePaymentsBody data={fns(["STRIPE_SECRET_KEY"], ["STRIPE_SECRET_KEY"])} onOpenSecrets={open} />);
    expect(screen.getByText("The Stripe key your checkout needs is added")).toBeTruthy();
    expect(screen.queryByText(/payments are (live|active)/i)).toBeNull();
  });
});
