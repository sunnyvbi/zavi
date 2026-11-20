
import {
  fetchCrux,
  type CruxCollectionPeriod,
  type CruxMetric,
  type CruxMetricName,
} from "./crux";
import { readGoogleApiKey, type GoogleApiUnavailable } from "./google-api";
import { fetchPagespeed, PAGESPEED_TIMEOUT_MS, type PagespeedReport } from "./pagespeed";

export const SEO_PERFORMANCE_MAX_PAGES = 6;

export const SEO_PERFORMANCE_CONCURRENCY = 2;

export const SEO_PERFORMANCE_BUDGET_MS = 400_000;

const MIN_PAGE_SLICE_MS = 90_000;

export type SeoFieldState =
  | {
      state: "ok";
      scope: "url" | "origin";
      key: string;
      collection_period: CruxCollectionPeriod;
      metrics: Record<CruxMetricName, CruxMetric | null>;
    }
  | { state: "no_data"; tried: string[] }
  | { state: "not_configured" }
  | { state: "unavailable"; reason: string };

export type SeoLabState =
  | { state: "ok"; pages: PagespeedReport[]; truncated: boolean }
  | { state: "not_configured" }
  | { state: "unavailable"; reason: string };

export type DeliveryGap = {
  lab_ms: number;
  field_ms: number;
  field_scope: "url" | "origin";
  state: "diverged" | "aligned";
  note: string;
} | null;

export const DELIVERY_GAP_THRESHOLD_MS = 800;

export type SeoPerformanceReport = {
  field: SeoFieldState;
  lab: SeoLabState;
  delivery_gap: DeliveryGap;
  fetched_at: string;
};

export function seoPerformanceIsConfigured(): boolean {
  return readGoogleApiKey() !== null;
}

export function reasonOf(u: GoogleApiUnavailable): string {
  switch (u.kind) {
    case "not_configured":
      return "Performance checks are not switched on yet.";
    case "rate_limited":
      return u.retry_after_seconds !== null
        ? `Google is rate-limiting these checks right now. It suggested retrying in ${u.retry_after_seconds}s.`
        : "Google is rate-limiting these checks right now. Try again shortly.";
    case "http_error":
      return `Google refused the request (HTTP ${u.status}). ${u.message}`.trim();
    case "timeout":
      return `Google did not answer within ${Math.round(u.timeout_ms / 1000)}s.`;
    case "network_error":
      return `Could not reach Google: ${u.message}`;
    case "malformed_response":
      return `Google's answer could not be read: ${u.message}`;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function selectPerformancePages(urls: string[], maxPages: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const url = typeof raw === "string" ? raw.trim() : "";
    if (!url || seen.has(url)) continue;
    if (originOf(url) === null) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= maxPages) break;
  }
  return out;
}

export function homepageOf(urls: string[]): string | null {
  for (const u of urls) {
    try {
      if (new URL(u).pathname === "/") return u;
    } catch {
      continue;
    }
  }
  return urls[0] ?? null;
}

function fieldStateOf(res: Awaited<ReturnType<typeof fetchCrux>>): SeoFieldState {
  if (res.kind === "ok") {
    return {
      state: "ok",
      scope: res.scope,
      key: res.key,
      collection_period: res.collection_period ?? { first_date: null, last_date: null },
      metrics: res.metrics,
    };
  }
  if (res.kind === "no_data") {
    return { state: "no_data", tried: [...res.tried] };
  }
  if (res.kind === "not_configured") return { state: "not_configured" };
  return { state: "unavailable", reason: reasonOf(res) };
}

type LabOutcome = {
  reports: PagespeedReport[];
  truncated: boolean;
  firstFailure: GoogleApiUnavailable | null;
};

async function runLab(
  urls: string[],
  opts: {
    budgetMs: number;
    concurrency: number;
    strategy: "mobile" | "desktop";
    signal?: AbortSignal;
  },
): Promise<LabOutcome> {
  const deadline = Date.now() + opts.budgetMs;
  const reports: PagespeedReport[] = [];
  let firstFailure: GoogleApiUnavailable | null = null;
  let truncated = false;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= urls.length) return;

      const remaining = deadline - Date.now();
      if (remaining < MIN_PAGE_SLICE_MS) {
        truncated = true;
        continue;
      }
      const clamped = remaining < PAGESPEED_TIMEOUT_MS;
      const res = await fetchPagespeed(urls[i], {
        strategy: opts.strategy,
        timeoutMs: Math.min(PAGESPEED_TIMEOUT_MS, remaining),
        signal: opts.signal,
      });

      if (res.kind === "ok") {
        reports.push(res);
        continue;
      }
      if (res.kind === "timeout" && clamped) truncated = true;
      if (!firstFailure) firstFailure = res;
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency, urls.length)) }, worker),
  );

  const rank = new Map(urls.map((u, i) => [u, i]));
  reports.sort((a, b) => (rank.get(a.requested_url) ?? 0) - (rank.get(b.requested_url) ?? 0));

  return { reports, truncated, firstFailure };
}

export function computeDeliveryGap(
  field: SeoFieldState,
  labPage: PagespeedReport | null,
): DeliveryGap {
  if (field.state !== "ok") return null;
  if (!labPage || labPage.server_response_ms === null) return null;

  const ttfb = field.metrics.experimental_time_to_first_byte;
  const field_ms = ttfb?.p75 ?? null;
  if (field_ms === null) return null;

  const lab_ms = labPage.server_response_ms;
  const diverged = field_ms - lab_ms >= DELIVERY_GAP_THRESHOLD_MS;
  const who =
    field.scope === "url" ? "real visitors to this page" : "real visitors across your site";

  const note = diverged
    ? `Your server answered the test load in ${Math.round(lab_ms)} ms, but ${who} wait about ` +
      `${Math.round(field_ms)} ms before the first byte arrives. The delay is in front of the ` +
      `application, not inside it — redirects, DNS, TLS and your CDN are what to check.`
    : `Your server answered the test load in ${Math.round(lab_ms)} ms, and ${who} wait about ` +
      `${Math.round(field_ms)} ms before the first byte. The two agree, so time to first byte ` +
      `is not where the delay is.`;

  return { lab_ms, field_ms, field_scope: field.scope, state: diverged ? "diverged" : "aligned", note };
}

function labStateOf(outcome: LabOutcome): SeoLabState {
  if (outcome.reports.length > 0) {
    return { state: "ok", pages: outcome.reports, truncated: outcome.truncated };
  }
  if (outcome.firstFailure) {
    if (outcome.firstFailure.kind === "not_configured") return { state: "not_configured" };
    return { state: "unavailable", reason: reasonOf(outcome.firstFailure) };
  }
  return {
    state: "unavailable",
    reason: "Ran out of time before any page could be checked.",
  };
}

export async function fetchSeoPerformance(
  pageUrls: string[],
  opts?: {
    maxPages?: number;
    budgetMs?: number;
    concurrency?: number;
    strategy?: "mobile" | "desktop";
    signal?: AbortSignal;
  },
): Promise<SeoPerformanceReport> {
  const fetched_at = new Date().toISOString();

  if (!readGoogleApiKey()) {
    return {
      field: { state: "not_configured" },
      lab: { state: "not_configured" },
      delivery_gap: null,
      fetched_at,
    };
  }

  const urls = selectPerformancePages(pageUrls, opts?.maxPages ?? SEO_PERFORMANCE_MAX_PAGES);
  const home = homepageOf(urls);

  const NO_PAGES = "The crawl returned no pages to test.";
  if (!home) {
    return {
      field: { state: "unavailable", reason: NO_PAGES },
      lab: { state: "unavailable", reason: NO_PAGES },
      delivery_gap: null,
      fetched_at,
    };
  }

  const [fieldRes, labOutcome] = await Promise.all([
    fetchCrux(home, { signal: opts?.signal }),
    runLab(urls, {
      budgetMs: opts?.budgetMs ?? SEO_PERFORMANCE_BUDGET_MS,
      concurrency: opts?.concurrency ?? SEO_PERFORMANCE_CONCURRENCY,
      strategy: opts?.strategy ?? "mobile",
      signal: opts?.signal,
    }),
  ]);

  const field = fieldStateOf(fieldRes);
  const lab = labStateOf(labOutcome);
  const homeReport =
    lab.state === "ok"
      ? (lab.pages.find((p) => p.requested_url === home || p.final_url === home) ?? null)
      : null;

  return {
    field,
    lab,
    delivery_gap: computeDeliveryGap(field, homeReport),
    fetched_at,
  };
}
