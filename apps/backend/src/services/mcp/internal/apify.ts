
import type { ToolEffect } from "@/services/tools/types";
import { z } from "zod";
import type { McpCallResult, McpTool } from "../types";
import { ExpectedToolError } from "@/services/tools/types";
import { zodToJsonSchema } from "@/services/tools/registry";
import { scrubSecretsFromUrl } from "../egress-secret-scrub";
import { logEvent } from "@/services/logging/logEvent";
import { apifyRanAndBilled, recordApifyCall, vendorContext, withVendorContext } from "@/services/vendors/usage";
import {
  assertSafeUrl,
  SsrfBlockedError,
} from "../../onboarding/enrichment/url-guard";

const APIFY_BASE = "https://api.apify.com/v2/acts";

const IG_ACTOR = "apify~instagram-scraper";
const TIKTOK_ACTOR = "clockworks~tiktok-scraper";
const RAG_WEB_BROWSER_ACTOR = "apify~rag-web-browser";
const REDDIT_ACTOR = "harshmaur~reddit-scraper-pro";
const META_ADS_LIB_ACTOR = "apify~facebook-ads-scraper";
const PINTEREST_ACTOR = "silentflow~pinterest-scraper-ppr";
const PINTEREST_TRENDS_ACTOR = "automation-lab~pinterest-trends-scraper";

export function ragMemoryMb(): number {
  const n = Number(process.env.APIFY_RAG_MEMORY_MB);
  const valid = Number.isInteger(n) && n >= 128 && n <= 32768 && (n & (n - 1)) === 0;
  return valid ? n : 4096;
}

const APIFY_TIMEOUT_MS = 240_000;

export function bareHandle(raw: string): string {
  return raw.trim().replace(/^[@#]+/, "");
}

const igInput = z.object({
  hashtag: z.string().min(1).max(80).optional(),
  username: z.string().min(1).max(80).optional(),
  url: z.string().url().optional(),
  max_items: z.number().int().min(1).max(50).default(20),
  result_type: z.enum(["posts", "reels", "stories", "details"]).default("posts"),
});

const tiktokInput = z.object({
  hashtag: z.string().min(1).max(80).optional(),
  username: z.string().min(1).max(80).optional(),
  max_items: z.number().int().min(1).max(50).default(12),
});

const ragWebBrowserInput = z.object({
  url: z.string().url().max(2048),
  allowed_origin: z.string().url().max(2048).optional(),
  output_format: z.enum(["markdown", "html"]).default("markdown"),
  wait_ms: z.number().int().min(0).max(15000).default(8000),
  max_bytes: z.number().int().min(1024).max(2 * 1024 * 1024).default(64 * 1024),
});

const redditInput = z.object({
  mode: z.enum(["communities", "community_rules", "subreddit", "search_posts"]),
  query: z.string().min(2).max(200).optional(),
  subreddit: z.string().min(2).max(50).optional(),
  max_items: z.number().int().min(1).max(25).default(10),
  with_comments: z.boolean().default(false),
  max_comments_per_post: z.number().int().min(1).max(10).default(3),
  time: z.enum(["day", "week", "month", "year", "all"]).default("year"),
});

const metaAdsLibInput = z.object({
  page_url: z.string().url().max(2048).optional(),
  query: z.string().min(2).max(120).optional(),
  country: z.string().min(2).max(3).default("ALL"),
  active_status: z.enum(["active", "inactive", "all"]).default("active"),
  max_items: z.number().int().min(1).max(40).default(15),
});

const pinterestInput = z.object({
  mode: z.enum(["search", "trends"]),
  queries: z.array(z.string().min(2).max(80)).min(1).max(5).optional(),
  max_items: z.number().int().min(1).max(40).default(15),
  trend_type: z.enum(["growing", "monthly", "yearly", "seasonal"]).default("growing"),
  country: z.string().length(2).default("US"),
});

const SUBREDDIT_NAME = /^[A-Za-z0-9_]{2,50}$/;

type SpecEntry = { description: string; schema: z.ZodTypeAny; effect: ToolEffect };

const SPECS: Record<string, SpecEntry> = {
  scrape_instagram: {
    description:
      "Read a public Instagram account or hashtag. THE ONLY TOOL THAT READS INSTAGRAM — a plain fetch of instagram.com returns an empty JS shell. Provide ONE of: hashtag, username, or url. result_type 'details' (use this for an account audit) returns the PROFILE — followers, follows, posts_total, is_business_account, is_private, is_verified, biography, full_name, external_url — PLUS recent_posts (~12) in a single call. result_type 'posts'/'reels' returns items only. Each post names its author (owner_username, owner_full_name, coauthors, tagged_users) and carries format (type, product_type: feed|clips|carousel_container, carousel_slides), PUBLIC counts (likes, comments, views), and craft signals (aspect_ratio, hashtag_count, has_written_alt, comments_disabled). `views` is plays including repeats — it is NOT reach and never a count of people. Reach, impressions, saves and sends are Insights-only and are NOT returned. Cost ~$0.02-0.05 per call.",
    schema: igInput,
    effect: "read",
  },
  scrape_tiktok: {
    description:
      "Scrape public TikTok videos via Apify's tiktok-scraper actor. Provide ONE of: hashtag (e.g. 'homebaking') or username (e.g. 'examplebrand'). Per video returns caption, plays, likes, comments, saves, shares, posted_at, duration_seconds, is_slideshow, cover_url, sound_name/sound_is_original, hashtags, and subtitle_url (a WEBVTT transcript link — fetch it to read the video's actual spoken hook). Also returns is_ad and is_pinned: NEVER mix those into an organic read, and an `organic_window` block is returned with them already excluded plus median/min/max plays. A username query additionally returns a `profile` block with followers, total_likes, videos_total, verified and bio_link. All of it is PUBLIC data, so it may be described and compared but is never the account's private analytics: watch time, completion rate, retention, profile views and outbound traffic remain unreadable. Cost ~$0.02-0.05 per call.",
    schema: tiktokInput,
    effect: "read",
  },
  scrape_pinterest: {
    description:
      "Read Pinterest. A plain fetch of pinterest.com search returns no pins (it is rendered by JavaScript), so this is the ONLY keyword read. Two modes. mode='search' + queries (1-3 phrases a shopper would type): the top pins for each phrase, each with title, description, public saves and comments, destination link and domain, board, pinner and pinner followers, created_at and is_video, plus a per-query summary (median saves, which domains win). mode='trends' + queries (single broad words a term must contain; a multi-word phrase rarely matches) + trend_type (growing|monthly|yearly|seasonal): trending Pinterest search terms with week/month/year change and a seasonality score; it cannot look up one keyword's volume. Every number is PUBLIC, never this company's analytics. For an account's recent pins use pinterest__public_pins (free) instead. Cost: search ~$0.002/pin, trends ~$0.001/term.",
    schema: pinterestInput,
    effect: "read",
  },
  rag_web_browser: {
    description:
      "Fetch a web page through real Chromium (JS rendering, handles Cloudflare bot-challenge and SPA-only sites). Returns markdown by default — switch to html when the page is data-heavy (tables, prices, structured product info). Use this WHENEVER http_fetch returns a Cloudflare challenge or near-empty body for a SPA. Cost ~$0.013 per call (measured over 197 real runs), latency 3-8s — this is the MOST EXPENSIVE read here, roughly 13x a plain fetch, because a blocked page silently retries through a residential proxy. Do NOT use it on a site that has a dedicated tool: Reddit is apify__scrape_reddit, Instagram is apify__scrape_instagram, TikTok is apify__scrape_tiktok, Pinterest is apify__scrape_pinterest. Those are cheaper, return structured fields instead of a page of markdown, and actually succeed where this one gets blocked. Inputs: url (required), output_format ('markdown'|'html', default 'markdown'), wait_ms (0-15000, default 8000 for SPA hydration), max_bytes (default 512KB).",
    schema: ragWebBrowserInput,
    effect: "read",
  },
  scrape_reddit: {
    description:
      "Read Reddit. THE ONLY TOOL THAT READS REDDIT — reddit.com returns 403 to this infrastructure's own requests, so a plain fetch of a subreddit or a rules page always fails. Four modes. mode='communities' + query: find the subreddits where a problem is discussed; each returns name, title and the sidebar `description`, which FREQUENTLY CONTAINS THE SUBREDDIT'S POSTED RULES VERBATIM — read it before claiming rules are unknown. mode='community_rules' + subreddit (bare name): ONE named community's rules, read off its sidebar `description` (the only server-side rules source there is — /about/rules is reCAPTCHA-walled), matched on the EXACT name and never on a neighbour; no exact match raises reddit_community_unresolved instead of answering with an adjacent subreddit. A rule you have not read is UNREAD, never 'promotion is allowed'. mode='subreddit' + subreddit (bare name): that community's top posts for `time`, each with score, upvote_ratio, comments, post_type, outbound_host, flair, removed_by/removal_reason and locked. mode='search_posts' + query: posts matching the phrase across Reddit, sorted by RELEVANCE (pinned — the actor's 'top' sort ignores the query and returns site-wide noise). Set with_comments to also pull top comments. Every number returned is PUBLIC Reddit data about a community, never this company's ad performance. Cost ~$0.002-0.04 per call.",
    schema: redditInput,
    effect: "read",
  },
  scrape_meta_ads: {
    description:
      "Read the META AD LIBRARY — the ads a Facebook/Instagram advertiser is RUNNING RIGHT NOW, public for every advertiser. THE ONLY TOOL THAT READS IT: facebook.com 403s this infrastructure, so web_fetch and rag_web_browser both return nothing. Provide ONE of: page_url (one named advertiser's facebook.com Page — also how you read the customer's OWN ads when Meta is not connected) or query (a brand/keyword search, for competitors). Per ad returns headline, body, cta, link_url, the creative's image/video URL, carousel cards, format, platforms, started and is_active. An ad first shown long ago and still active is one somebody is PAYING to keep alive — that is the strongest signal here. No spend, reach or ctr: Meta publishes those for political/issue ads only, so never report a competitor's performance, only what they SAY and how long they have said it. Cost ~$0.003-0.006 per ad.",
    schema: metaAdsLibInput,
    effect: "read",
  },
};

export function listApifyTools(): McpTool[] {
  return Object.entries(SPECS).map(([tool_name, spec]) => {
    const schema = zodToJsonSchema(spec.schema);
    if (schema.type !== "object") {
      throw new Error(`apify/${tool_name} input schema must be a top-level z.object()`);
    }
    return {
      server_id: "apify",
      tool_name,
      description: spec.description,
      effect: spec.effect,
      input_schema: schema as { type: "object"; [k: string]: unknown },
    };
  });
}

const PER_RUN_CALL_CAP: Readonly<Record<string, number>> = {
  scrape_pinterest: 4,
  scrape_reddit: 12,
  reddit_thread_read: 8,
  rag_web_browser: 30,
  scrape_tiktok: 8,
  scrape_instagram: 8,
  scrape_meta_ads: 8,
};
const perRunCalls = new Map<string, number>();

const UNREACHABLE_TTL_MS = 24 * 60 * 60 * 1000;
const SITE_MISSES_BEFORE_SKIP = 3;
const unreachablePages = new Map<string, number>();
const siteMisses = new Map<string, { count: number; until: number }>();

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

const scoped = (tenant: string, key: string) => `${tenant}\u0000${key}`;

export function recentlyUnreachable(tenant: string, url: string, now = Date.now()): number {
  const page = unreachablePages.get(scoped(tenant, url)) ?? 0;
  if (page > now) return page;
  const site = siteMisses.get(scoped(tenant, originOf(url)));
  if (site && site.count >= SITE_MISSES_BEFORE_SKIP && site.until > now) return site.until;
  return 0;
}

export function markUnreachable(
  tenant: string,
  url: string,
  opts: { siteLevel: boolean },
  now = Date.now(),
): void {
  if (unreachablePages.size > 5000) unreachablePages.clear();
  if (siteMisses.size > 5000) siteMisses.clear();
  unreachablePages.set(scoped(tenant, url), now + UNREACHABLE_TTL_MS);
  if (!opts.siteLevel) return;
  const origin = originOf(url);
  if (!origin) return;
  const key = scoped(tenant, origin);
  const prev = siteMisses.get(key);
  const live = prev && prev.until > now ? prev.count : 0;
  siteMisses.set(key, { count: live + 1, until: now + UNREACHABLE_TTL_MS });
}

export function resetUnreachableForTest(): void {
  unreachablePages.clear();
  siteMisses.clear();
}

export function apifyRunCap(tool_name: string): number | undefined {
  return PER_RUN_CALL_CAP[tool_name];
}

export function takeApifyCall(run_id: string | undefined, tool_name: string): boolean {
  const cap = PER_RUN_CALL_CAP[tool_name];
  if (cap === undefined || !run_id) return true;
  const key = `${run_id}:${tool_name}`;
  const used = perRunCalls.get(key) ?? 0;
  if (used >= cap) return false;
  if (perRunCalls.size > 5000) perRunCalls.clear();
  perRunCalls.set(key, used + 1);
  return true;
}

export async function callApifyTool(
  tenant_id: string,
  tool_name: string,
  args: unknown,
  run_id?: string,
): Promise<McpCallResult> {
  const start = Date.now();
  const spec = SPECS[tool_name];
  if (!spec) {
    return errorResult(start, "tool_unknown", `apify/${tool_name} not registered`);
  }
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    return errorResult(
      start,
      "apify_not_configured",
      "APIFY_TOKEN env var missing. Add to local .env + AWS Secrets Manager praxis-envprod-1.",
    );
  }
  try {
    const parsed = spec.schema.parse(args);
    if (tool_name === "scrape_pinterest" && !(parsed as { queries?: unknown[] }).queries?.length) {
      throw new ExpectedToolError("tool_input_invalid", "scrape_pinterest needs `queries` (1-3 phrases).");
    }
    if (!takeApifyCall(run_id, tool_name)) {
      return errorResult(
        start,
        "apify_run_budget_spent",
        `${tool_name} has been called ${PER_RUN_CALL_CAP[tool_name]} times this run, its limit. Work with what those calls returned; say what you could not read.`,
      );
    }
    const outer = vendorContext();
    const output = await withVendorContext(
      {
        tenant_id,
        run_id: run_id ?? outer?.run_id ?? null,
        source: outer?.source ?? (run_id ? "run" : "unknown"),
      },
      () => runActor(token, tool_name, parsed, tenant_id),
    );
    return {
      ok: true,
      is_error: false,
      content: JSON.stringify(output),
      ms: Date.now() - start,
    };
  } catch (e) {
    if (e instanceof SsrfBlockedError) {
      return errorResult(start, e.code, e.message);
    }
    if (e instanceof ExpectedToolError) {
      return errorResult(start, e.code, e.message);
    }
    if ((e as { name?: string })?.name === "ZodError") {
      return errorResult(start, "tool_input_invalid", (e as Error).message);
    }
    throw e;
  }
}

async function runActor(
  token: string,
  tool_name: string,
  args: unknown,
  tenant_id = "",
): Promise<unknown> {
  if (tool_name === "scrape_instagram") {
    return runInstagram(token, args as z.infer<typeof igInput>);
  }
  if (tool_name === "scrape_tiktok") {
    return runTiktok(token, args as z.infer<typeof tiktokInput>);
  }
  if (tool_name === "rag_web_browser") {
    return runRagWebBrowser(token, args as z.infer<typeof ragWebBrowserInput>, tenant_id);
  }
  if (tool_name === "scrape_reddit") {
    return runReddit(token, args as z.infer<typeof redditInput>);
  }
  if (tool_name === "scrape_meta_ads") {
    return runMetaAdsLibrary(token, args as z.infer<typeof metaAdsLibInput>);
  }
  if (tool_name === "scrape_pinterest") {
    return runPinterest(token, args as z.infer<typeof pinterestInput>);
  }
  throw new Error(`unhandled apify tool: ${tool_name}`);
}

const PREFLIGHT_MAX_REDIRECTS = 3;
const PREFLIGHT_TIMEOUT_MS = 10_000;

export async function resolveValidatedFinalUrl(
  initialUrl: string,
  fetchFn: typeof fetch = fetch,
  allowedOrigin?: string,
): Promise<string> {
  let url = initialUrl;
  for (let hop = 0; hop <= PREFLIGHT_MAX_REDIRECTS; hop++) {
    await assertSafeUrl(url);
    if (allowedOrigin !== undefined && new URL(url).origin !== allowedOrigin) {
      throw new ExpectedToolError(
        "render_origin_refused",
        `Refusing to render ${url}: origin does not match the caller's pinned origin ${allowedOrigin}.`,
      );
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PREFLIGHT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "GET",
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": "praxis-web-fetch/1.0" },
      });
    } catch {
      throw new ExpectedToolError(
        "render_preflight_failed",
        `Could not preflight ${url} to verify it is safe to render (network error or timeout). Refusing to render an unverified URL.`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) {
        throw new ExpectedToolError(
          "render_preflight_failed",
          `Redirect from ${url} had no Location header; cannot resolve a verified final URL to render.`,
        );
      }
      if (hop === PREFLIGHT_MAX_REDIRECTS) {
        throw new ExpectedToolError(
          "render_too_many_redirects",
          `Exceeded ${PREFLIGHT_MAX_REDIRECTS} redirects resolving ${initialUrl}; refusing to hand Apify an unvalidated hop.`,
        );
      }
      let next: string;
      try {
        next = new URL(loc, url).toString();
      } catch {
        throw new ExpectedToolError(
          "render_preflight_failed",
          `Malformed Location header redirecting from ${url}; cannot resolve a verified final URL.`,
        );
      }
      url = next;
      continue;
    }
    return url;
  }
  throw new ExpectedToolError(
    "render_preflight_failed",
    `Could not resolve a verified final URL for ${initialUrl}.`,
  );
}

function detectAuthWall(
  resolvedUrl: string,
  renderedUrl: string | undefined,
  requestedUrl: string,
): string | null {
  const AUTH_SEGMENT =
    /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|auth|oauth|authorize|checkpoint|challenge|captcha|verify|session[s]?[-_]?new)(\/|$)/i;

  let requestedPath: string;
  try {
    requestedPath = new URL(requestedUrl).pathname;
  } catch {
    return null;
  }
  if (AUTH_SEGMENT.test(requestedPath)) return null;

  for (const candidate of [resolvedUrl, renderedUrl]) {
    if (!candidate) continue;
    let u: URL;
    try {
      u = new URL(candidate);
    } catch {
      continue;
    }
    if (u.pathname === requestedPath) continue;
    if (AUTH_SEGMENT.test(u.pathname)) return `redirected to ${u.origin}${u.pathname}`;
  }
  return null;
}

async function runRagWebBrowser(
  token: string,
  a: z.infer<typeof ragWebBrowserInput>,
  tenant_id = "",
): Promise<unknown> {
  const { scrubbed: safeUrl, redactions } = scrubSecretsFromUrl(a.url);
  if (redactions.length > 0) {
    await logEvent({
      level: "warn",
      source: "apify-rag",
      code: "egress_secret_scrubbed",
      meta: { detectors: redactions.slice(0, 10), count: redactions.length },
    });
  }
  const pinnedOrigin =
    typeof a.allowed_origin === "string" ? new URL(a.allowed_origin).origin : undefined;
  const renderUrl = await resolveValidatedFinalUrl(safeUrl, fetch, pinnedOrigin);
  const body: Record<string, unknown> = {
    query: renderUrl,
    scrapingTool: "browser-playwright",
    outputFormats: [a.output_format],
    maxResults: 1,
    requestTimeoutSecs: Math.ceil((a.wait_ms + 30_000) / 1000),
    dynamicContentWaitSecs: Math.ceil(a.wait_ms / 1000),
  };
  type RwbItem = {
    metadata?: { url?: string; title?: string; description?: string };
    markdown?: string;
    html?: string;
    text?: string;
    crawl?: { httpStatusCode?: number; loadedAt?: string };
  };
  const RESIDENTIAL = {
    useApifyProxy: true,
    apifyProxyGroups: ["RESIDENTIAL"],
  } as const;

  const isBlocked = (arr: unknown): boolean => {
    const first = (arr as RwbItem[])[0];
    if (!first) return true;
    const code = first.crawl?.httpStatusCode ?? 0;
    const body = first.markdown ?? first.text ?? first.html ?? "";
    return code >= 400 || body.length === 0;
  };

  const ALWAYS_RESIDENTIAL_HOSTS = ["reddit.com"];
  const renderHost = (() => {
    try {
      return new URL(renderUrl).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const skipDatacenter = ALWAYS_RESIDENTIAL_HOSTS.some(
    (h) => renderHost === h || renderHost.endsWith(`.${h}`),
  );

  const unreachableUntil = recentlyUnreachable(tenant_id, safeUrl);
  if (unreachableUntil) {
    throw new ExpectedToolError(
      "rag_web_browser_recently_unreachable",
      `${safeUrl} returned nothing on both the datacenter and the residential proxy within the last 24 hours, so it was not fetched again. Report it as an unread page. Do not describe its contents.`,
    );
  }

  const memoryMb = ragMemoryMb();
  let items = skipDatacenter
    ? await callApifySync(token, RAG_WEB_BROWSER_ACTOR, { ...body, proxyConfiguration: RESIDENTIAL }, { memoryMb })
    : await callApifySync(token, RAG_WEB_BROWSER_ACTOR, body, { memoryMb });
  let proxy_tier: "datacenter" | "residential" = skipDatacenter ? "residential" : "datacenter";
  const firstStatus = (items as RwbItem[])[0]?.crawl?.httpStatusCode ?? 0;
  if (firstStatus === 404 || firstStatus === 410) {
    throw new ExpectedToolError(
      "rag_web_browser_not_found",
      `${safeUrl} answered HTTP ${firstStatus}: the page does not exist. Report it as missing. Do not describe its contents.`,
    );
  }
  if (!skipDatacenter && isBlocked(items)) {
    proxy_tier = "residential";
    items = await callApifySync(
      token,
      RAG_WEB_BROWSER_ACTOR,
      { ...body, proxyConfiguration: RESIDENTIAL },
      { memoryMb },
    );
    await logEvent({
      level: "info",
      source: "apify",
      code: "rag_web_browser_residential_retry",
      meta: {
        origin: new URL(renderUrl).origin,
        proxy_tier: "residential",
        recovered: !isBlocked(items),
      },
    });
  }

  if (isBlocked(items)) {
    markUnreachable(tenant_id, safeUrl, { siteLevel: !skipDatacenter });
    throw new ExpectedToolError(
      "rag_web_browser_empty",
      `rag_web_browser got no usable content for ${safeUrl} on EITHER the datacenter or the residential proxy — the page is blocked, login-walled, redirected, or the actor timed out. Treat this as a real absence you must report, not as an empty page.`,
    );
  }
  const item = (items as RwbItem[])[0]!;

  const authWall = detectAuthWall(renderUrl, item.metadata?.url, safeUrl);
  if (authWall) {
    throw new ExpectedToolError(
      "rag_web_browser_auth_wall",
      `${safeUrl} redirected to an authentication page (${authWall}) and that login page is what rendered — the requested content was never reached. Report this as an unread page. Do not describe its contents, and do not treat the login text as the page's content.`,
    );
  }

  const raw =
    a.output_format === "markdown"
      ? (item.markdown ?? item.text ?? "")
      : (item.html ?? "");
  const bytes = Buffer.byteLength(raw, "utf-8");
  const content =
    bytes <= a.max_bytes
      ? raw
      : `${raw.slice(0, a.max_bytes)}\n\n[truncated — original was ${bytes} bytes, capped at ${a.max_bytes}]`;
  return {
    url: item.metadata?.url ?? safeUrl,
    title: item.metadata?.title ?? null,
    description: item.metadata?.description ?? null,
    http_status: item.crawl?.httpStatusCode ?? null,
    proxy_tier,
    fetched_at: item.crawl?.loadedAt ?? new Date().toISOString(),
    tag_detection:
      a.output_format === "markdown"
        ? "unavailable — this is rendered markdown, which contains no <script> tags. A tracking pixel, tag manager or analytics snippet CANNOT be observed here. Do not report a tag as missing or 'not installed' from this read; say tag presence is unverified and check it in the platform's own UI or a tag-inspection tool."
        : "partial — this is the rendered DOM; inline snippets may appear, but a tag injected after load or by a consent manager will not. Do not report a tag as absent from this read alone.",
    output_format: a.output_format,
    content,
    truncated: bytes > a.max_bytes,
    original_bytes: bytes,
    ...(redactions.length > 0
      ? {
          secret_scrub_note: `${redactions.length} secret-like value(s) were redacted from the URL before fetching. Do not put credentials/tokens in fetch URLs.`,
        }
      : {}),
  };
}

async function runInstagram(token: string, a: z.infer<typeof igInput>): Promise<unknown> {
  const provided = [a.hashtag, a.username, a.url].filter(Boolean).length;
  if (provided !== 1) {
    throw new ExpectedToolError(
      "tool_input_invalid",
      "scrape_instagram requires exactly one of: hashtag, username, url.",
    );
  }
  const directUrls: string[] = [];
  if (a.url) {
    const { scrubbed, redactions } = scrubSecretsFromUrl(a.url);
    if (redactions.length > 0) {
      await logEvent({
        level: "warn",
        source: "apify-instagram",
        code: "egress_secret_scrubbed",
        meta: { detectors: redactions.slice(0, 10), count: redactions.length },
      });
    }
    directUrls.push(scrubbed);
  }
  const bare = a.username ?? a.hashtag;
  if (bare !== undefined && bareHandle(bare) === "") {
    throw new ExpectedToolError(
      "tool_input_invalid",
      "scrape_instagram needs a name, not just a @ or # sign.",
    );
  }

  else if (a.username) directUrls.push(`https://www.instagram.com/${encodeURIComponent(bareHandle(a.username))}/`);
  else if (a.hashtag) directUrls.push(`https://www.instagram.com/explore/tags/${encodeURIComponent(bareHandle(a.hashtag))}/`);

  const body = {
    directUrls,
    resultsType: a.result_type === "reels" ? "posts" : a.result_type,
    resultsLimit: a.max_items,
    addParentData: false,
  };
  const items = await callApifySync(token, IG_ACTOR, body);

  if (a.result_type === "details") {
    const p = (items as IgProfile[])[0];
    if (!p || !p.username) {
      throw new ExpectedToolError(
        "tool_no_data",
        "scrape_instagram(details) returned no profile. The handle may be wrong, or the account private or deleted.",
      );
    }
    if (
      p.fullName == null &&
      p.followersCount == null &&
      p.postsCount == null &&
      !p.biography &&
      !(p.latestPosts ?? []).length
    ) {
      throw new ExpectedToolError(
        "tool_no_data",
        `scrape_instagram(details) could not read @${p.username}: every profile field came back empty. This is NOT evidence the account is absent or inactive; report it as could not verify.`,
      );
    }
    return {
      profile: {
        username: p.username ?? null,
        full_name: p.fullName ?? null,
        biography: (p.biography ?? "").slice(0, 600),
        followers: p.followersCount ?? null,
        follows: p.followsCount ?? null,
        posts_total: p.postsCount ?? null,
        is_business_account: p.isBusinessAccount ?? null,
        business_category: p.businessCategoryName ?? null,
        is_private: p.private ?? null,
        is_verified: p.verified ?? null,
        external_url: p.externalUrl ?? null,
        external_link_count: Array.isArray(p.externalUrls) ? p.externalUrls.length : null,
      },
      recent_posts: (p.latestPosts ?? []).slice(0, a.max_items).map(mapIgPost),
      recent_posts_window: Math.min((p.latestPosts ?? []).length, a.max_items),
    };
  }

  return { items: (items as IgItem[]).slice(0, a.max_items).map(mapIgPost) };
}

type IgItem = {
  caption?: string;
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  videoUrl?: string;
  displayUrl?: string;
  url?: string;
  timestamp?: string;
  type?: string;
  productType?: string;
  hashtags?: string[];
  dimensionsWidth?: number;
  dimensionsHeight?: number;
  childPosts?: unknown[];
  isCommentsDisabled?: boolean;
  paidPartnership?: boolean;
  alt?: string;
  ownerUsername?: string;
  ownerFullName?: string;
  coauthorProducers?: { username?: string }[];
  taggedUsers?: { username?: string }[];
};

function igUsernames(list: unknown, cap: number): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const u of list) {
    const name = (u as { username?: unknown } | null)?.username;
    if (typeof name === "string" && name.trim()) out.push(name.trim());
    if (out.length >= cap) break;
  }
  return out;
}

type IgProfile = {
  username?: string;
  fullName?: string;
  biography?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  isBusinessAccount?: boolean;
  businessCategoryName?: string | null;
  private?: boolean;
  verified?: boolean;
  externalUrl?: string;
  externalUrls?: unknown[];
  latestPosts?: IgItem[];
};

function mapIgPost(it: IgItem) {
  const w = it.dimensionsWidth ?? null;
  const h = it.dimensionsHeight ?? null;
  return {
    type: it.type ?? null,
    product_type: it.productType ?? null,
    caption: (it.caption ?? "").slice(0, 600),
    owner_username: it.ownerUsername ?? null,
    owner_full_name: it.ownerFullName ?? null,
    coauthors: igUsernames(it.coauthorProducers, 5),
    tagged_users: igUsernames(it.taggedUsers, 10),
    likes: it.likesCount ?? null,
    comments: it.commentsCount ?? null,
    views: it.videoViewCount ?? null,
    carousel_slides: Array.isArray(it.childPosts) ? it.childPosts.length : null,
    hashtag_count: Array.isArray(it.hashtags) ? it.hashtags.length : null,
    hashtags: (it.hashtags ?? []).slice(0, 30),
    aspect_ratio: w && h ? Number((w / h).toFixed(3)) : null,
    comments_disabled: it.isCommentsDisabled ?? null,
    paid_partnership: it.paidPartnership ?? null,
    has_written_alt: typeof it.alt === "string" ? !/^Photo by .+ on .+\.$/.test(it.alt) : null,
    video_url: it.videoUrl ?? null,
    image_url: it.displayUrl ?? null,
    post_url: it.url ?? null,
    taken_at: it.timestamp ?? null,
  };
}

async function runTiktok(token: string, a: z.infer<typeof tiktokInput>): Promise<unknown> {
  const provided = [a.hashtag, a.username].filter(Boolean).length;
  if (provided !== 1) {
    throw new ExpectedToolError(
      "tool_input_invalid",
      "scrape_tiktok requires exactly one of: hashtag, username.",
    );
  }
  const ttBare = a.username ?? a.hashtag;
  if (ttBare !== undefined && bareHandle(ttBare) === "") {
    throw new ExpectedToolError(
      "tool_input_invalid",
      "scrape_tiktok needs a name, not just a @ or # sign.",
    );
  }
  const body: Record<string, unknown> = {
    resultsPerPage: a.max_items,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
  };
  if (a.hashtag) body.hashtags = [bareHandle(a.hashtag)];
  if (a.username) body.profiles = [bareHandle(a.username)];

  const items = await callApifySync(token, TIKTOK_ACTOR, body);
  const mapped = (items as TtItem[])
    .slice(0, a.max_items)
    .map(mapTtItem)
    .filter((m) => !(m.caption === "" && m.plays == null && m.posted_at == null && m.author == null));
  if (mapped.length === 0 && (items as TtItem[]).length > 0) {
    throw new ExpectedToolError(
      "tool_no_data",
      `scrape_tiktok could not read ${a.username ? "@" + bareHandle(a.username) : "#" + bareHandle(a.hashtag ?? "")}: every returned item was empty. This is NOT evidence the account or tag is absent; report it as could not verify.`,
    );
  }

  const organic = mapped.filter((m) => !m.is_ad && !m.is_pinned);
  const plays = organic
    .map((m) => m.plays)
    .filter((n): n is number => typeof n === "number")
    .sort((x, y) => x - y);

  const out: Record<string, unknown> = {
    items: mapped,
    organic_window: {
      returned: mapped.length,
      organic: organic.length,
      excluded_ads_or_pinned: mapped.length - organic.length,
      median_basis: plays.length,
      median_plays_organic: plays.length ? medianOf(plays) : null,
      min_plays_organic: plays.length ? plays[0] : null,
      max_plays_organic: plays.length ? plays[plays.length - 1] : null,
    },
  };

  if (a.username) {
    const am = (items as TtItem[])[0]?.authorMeta;
    if (am) {
      out.profile = {
        username: am.name ?? null,
        display_name: am.nickName ?? null,
        bio: (am.signature ?? "").slice(0, 160),
        bio_link: am.bioLink ?? null,
        followers: am.fans ?? null,
        following: am.following ?? null,
        total_likes: am.heart ?? null,
        videos_total: am.video ?? null,
        is_verified: am.verified ?? null,
        is_private: am.privateAccount ?? null,
      };
    }
  }

  return out;
}

function medianOf(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type TtItem = {
  text?: string;
  playCount?: number;
  diggCount?: number;
  commentCount?: number;
  collectCount?: number;
  shareCount?: number;
  repostCount?: number;
  videoUrl?: string;
  webVideoUrl?: string;
  createTimeISO?: string;
  textLanguage?: string;
  isAd?: boolean;
  isPinned?: boolean;
  isSlideshow?: boolean;
  hashtags?: unknown[];
  authorMeta?: {
    name?: string;
    nickName?: string;
    signature?: string;
    bioLink?: string;
    fans?: number;
    following?: number;
    heart?: number;
    video?: number;
    verified?: boolean;
    privateAccount?: boolean;
  };
  videoMeta?: {
    duration?: number;
    height?: number;
    width?: number;
    subtitleLinks?: { language?: string; downloadLink?: string }[];
  };
  musicMeta?: {
    musicName?: string;
    musicAuthor?: string;
    musicOriginal?: boolean;
  };
};

function mapTtItem(it: TtItem) {
  const vm = it.videoMeta ?? {};
  const mm = it.musicMeta ?? {};
  const subs = vm.subtitleLinks ?? [];
  const w = vm.width ?? null;
  const h = vm.height ?? null;
  return {
    caption: (it.text ?? "").slice(0, 600),
    plays: it.playCount ?? null,
    likes: it.diggCount ?? null,
    comments: it.commentCount ?? null,
    saves: it.collectCount ?? null,
    shares: it.shareCount ?? null,
    reposts: it.repostCount ?? null,
    author: it.authorMeta?.name ?? null,
    posted_at: it.createTimeISO ?? null,
    video_url: it.videoUrl ?? it.webVideoUrl ?? null,

    duration_seconds: vm.duration ?? null,
    is_slideshow: it.isSlideshow ?? null,
    aspect_ratio: w && h ? Number((w / h).toFixed(3)) : null,

    is_ad: it.isAd ?? null,
    is_pinned: it.isPinned ?? null,

    sound_name: mm.musicName ?? null,
    sound_author: mm.musicAuthor ?? null,
    sound_is_original: mm.musicOriginal ?? null,

    hashtags: (it.hashtags ?? [])
      .slice(0, 30)
      .map((h2) => (typeof h2 === "string" ? h2 : ((h2 as { name?: string })?.name ?? null)))
      .filter((x): x is string => typeof x === "string"),
    text_language: it.textLanguage ?? null,

    subtitle_url: subs[0]?.downloadLink ?? null,
    subtitle_languages: subs
      .map((s2) => s2.language ?? null)
      .filter((x): x is string => typeof x === "string"),
  };
}

type RedditRaw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

function mapRedditPost(r: RedditRaw) {
  const hours = num(r.ageHours);
  return {
    title: str(r.title),
    url: str(r.postUrl) ?? str(r.url),
    community: str(r.communityName),
    author: str(r.authorName) ?? str(r.username),
    score: num(r.score) ?? num(r.upVotes),
    upvote_ratio: num(r.upvoteRatio),
    comments: num(r.commentsCount),
    subscribers: num(r.subredditSubscribers),
    age_hours: hours === null ? null : Math.round(hours * 10) / 10,
    post_type: str(r.postType),
    outbound_host: str(r.outboundUrlHost),
    flair: str(r.flair) ?? str(r.authorFlairText),
    removed_by: str(r.removedBy) ?? str(r.removedByCategory),
    removal_reason: str(r.removalReason),
    locked: bool(r.locked),
    stickied: bool(r.stickied),
    over18: bool(r.over18),
    body: (str(r.body) ?? "").slice(0, 1200),
  };
}

function mapRedditComment(r: RedditRaw) {
  return {
    author: str(r.authorName) ?? str(r.username),
    score: num(r.score) ?? num(r.upVotes),
    community: str(r.communityName),
    post_url: str(r.postUrl) ?? str(r.url),
    body: (str(r.body) ?? "").slice(0, 800),
  };
}

function communityRulesText(r: RedditRaw): string {
  const rules = Array.isArray(r.rules) ? (r.rules as unknown[]) : [];
  const lines = rules
    .map((rule, i) => {
      if (!rule || typeof rule !== "object") return null;
      const x = rule as Record<string, unknown>;
      const head = str(x.shortName) ?? str(x.violationReason);
      const body = str(x.description);
      if (!head && !body) return null;
      return `${i + 1}. ${head ?? ""}${body ? `\n${body}` : ""}`.trim();
    })
    .filter((line): line is string => !!line);
  const about = str(r.publicDescription);
  return [about, lines.length ? `Rules:\n${lines.join("\n\n")}` : null].filter(Boolean).join("\n\n");
}

function mapRedditCommunity(r: RedditRaw) {
  const sidebar = str(r.description) ?? "";
  return {
    name: str(r.name) ?? str(r.communityName),
    title: str(r.title),
    subscribers: num(r.subscribers) ?? num(r.subredditSubscribers),
    over18: bool(r.over18),
    description: (sidebar.trim() ? sidebar : communityRulesText(r)).slice(0, 4000),
  };
}

const RULES_LOOKUP_COMMUNITIES = 10;

function bareCommunityName(name: string): string {
  return name.replace(/^\/?r\//i, "").trim().toLowerCase();
}

async function runCommunityRules(
  token: string,
  a: z.infer<typeof redditInput>,
  subreddit: string,
): Promise<unknown> {
  const body = {
    searchTerms: [subreddit],
    searchPosts: false,
    searchComments: false,
    searchCommunities: true,
    searchSort: "relevance",
    searchTime: a.time,
    maxPostsCount: 0,
    maxCommunitiesCount: RULES_LOOKUP_COMMUNITIES,
    crawlCommentsPerPost: false,
    maxCommentsPerPost: 0,
    includeNSFW: true,
    fastMode: false,
  };

  const items = (await callApifySync(token, REDDIT_ACTOR, body)) as RedditRaw[];
  const communities = items
    .filter((i) => i?.dataType === "community")
    .map(mapRedditCommunity);

  const wanted = bareCommunityName(subreddit);
  const hit = communities.find((c) => c.name && bareCommunityName(c.name) === wanted);

  if (!hit) {
    const near = communities
      .map((c) => c.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    throw new ExpectedToolError(
      "reddit_community_unresolved",
      `scrape_reddit(mode='community_rules') could not resolve r/${subreddit} by exact name. ` +
        (near.length
          ? `The community search returned only these OTHER communities: ${near.join(", ")}. Their rules are not r/${subreddit}'s rules. `
          : "The community search returned no community records at all. ") +
        `Treat r/${subreddit}'s rules as UNREAD — never as permission. A rule you did not read is not a rule that does not exist, and the absence of a rule is never "promotion is allowed".`,
    );
  }

  return {
    mode: "community_rules" as const,
    subreddit: hit.name,
    rules_text: hit.description,
    rules_text_present: hit.description.length > 0,
    source: "sidebar_description" as const,
    matched: true as const,
  };
}

async function runReddit(token: string, a: z.infer<typeof redditInput>): Promise<unknown> {
  let body: Record<string, unknown>;

  if (a.mode === "community_rules") {
    if (!a.subreddit || !SUBREDDIT_NAME.test(a.subreddit)) {
      throw new ExpectedToolError(
        "tool_input_invalid",
        "scrape_reddit(mode='community_rules') needs `subreddit` as a bare name — letters, digits and underscore only, no 'r/' prefix, no URL.",
      );
    }
    return runCommunityRules(token, a, a.subreddit);
  }

  if (a.mode === "subreddit") {
    if (!a.subreddit || !SUBREDDIT_NAME.test(a.subreddit)) {
      throw new ExpectedToolError(
        "tool_input_invalid",
        "scrape_reddit(mode='subreddit') needs `subreddit` as a bare name — letters, digits and underscore only, no 'r/' prefix, no URL.",
      );
    }
    body = {
      startUrls: [
        {
          url: `https://www.reddit.com/r/${a.subreddit}/top/?t=${a.time === "all" ? "all" : a.time}`,
        },
      ],
      maxPostsCount: a.max_items,
      crawlCommentsPerPost: a.with_comments,
      maxCommentsPerPost: a.with_comments ? a.max_comments_per_post : 0,
      includeNSFW: true,
      fastMode: false,
    };
  } else {
    if (!a.query) {
      throw new ExpectedToolError(
        "tool_input_invalid",
        `scrape_reddit(mode='${a.mode}') needs \`query\`.`,
      );
    }
    const communities = a.mode === "communities";
    body = {
      searchTerms: [a.query],
      searchPosts: !communities,
      searchComments: false,
      searchCommunities: communities,
      searchSort: "relevance",
      searchTime: a.time,
      maxPostsCount: communities ? 0 : a.max_items,
      maxCommunitiesCount: communities ? a.max_items : 0,
      crawlCommentsPerPost: !communities && a.with_comments,
      maxCommentsPerPost: !communities && a.with_comments ? a.max_comments_per_post : 0,
      includeNSFW: true,
      fastMode: false,
    };
  }

  const items = (await callApifySync(token, REDDIT_ACTOR, body)) as RedditRaw[];

  const posts = items.filter((i) => i?.dataType === "post").map(mapRedditPost);
  const comments = items.filter((i) => i?.dataType === "comment").map(mapRedditComment);
  const found = items.filter((i) => i?.dataType === "community").map(mapRedditCommunity);

  if (posts.length === 0 && comments.length === 0 && found.length === 0) {
    throw new ExpectedToolError(
      "tool_no_data",
      a.mode === "subreddit"
        ? `scrape_reddit found nothing in r/${a.subreddit}. The subreddit may be private, quarantined, banned or misspelled. Treat it as UNVERIFIED — do not describe it from memory.`
        : `scrape_reddit found nothing on Reddit for "${a.query}". Treat the absence as a gap to report, not as proof the conversation does not exist.`,
    );
  }

  return {
    mode: a.mode,
    window: a.mode === "subreddit" ? `top posts, past ${a.time}` : `relevance, past ${a.time}`,
    communities: found,
    posts,
    comments,
  };
}

type AdLibRaw = {
  adArchiveID?: string;
  pageID?: string;
  isActive?: boolean;
  collationCount?: number;
  publisherPlatform?: string[];
  startDateFormatted?: string;
  snapshot?: {
    pageName?: string;
    pageProfileUri?: string;
    title?: string;
    body?: { text?: string } | string;
    caption?: string;
    linkDescription?: string;
    linkUrl?: string;
    ctaText?: string;
    displayFormat?: string;
    images?: Array<{ originalImageUrl?: string; resizedImageUrl?: string }>;
    videos?: Array<{ videoPreviewImageUrl?: string }>;
    cards?: Array<{
      title?: string;
      body?: string;
      ctaText?: string;
      linkUrl?: string;
      originalImageUrl?: string;
      videoPreviewImageUrl?: string;
    }>;
  };
};

function clip(v: unknown, max = 400): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.replace(/\{\{[^}]*\}\}/g, "").trim() === "") return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function mapAdLibraryItem(r: AdLibRaw) {
  const sn = r.snapshot ?? {};
  const media =
    sn.videos?.[0]?.videoPreviewImageUrl ??
    sn.images?.[0]?.originalImageUrl ??
    sn.images?.[0]?.resizedImageUrl ??
    sn.cards?.[0]?.videoPreviewImageUrl ??
    sn.cards?.[0]?.originalImageUrl ??
    null;
  return {
    ad_id: r.adArchiveID ?? null,
    advertiser: clip(sn.pageName, 120),
    page_id: r.pageID ?? null,
    page_url: clip(sn.pageProfileUri, 200),
    started: r.startDateFormatted ? r.startDateFormatted.slice(0, 10) : null,
    is_active: r.isActive ?? null,
    variants: r.collationCount ?? null,
    platforms: r.publisherPlatform ?? [],
    format: clip(sn.displayFormat, 40),
    cta: clip(sn.ctaText, 60),
    headline: clip(sn.title),
    body: clip(typeof sn.body === "string" ? sn.body : sn.body?.text),
    link_description: clip(sn.linkDescription),
    link_url: clip(sn.linkUrl, 300),
    caption: clip(sn.caption, 120),
    media_url: clip(media, 400),
    cards: (sn.cards ?? []).slice(0, 3).map((c) => ({
      title: clip(c.title),
      body: clip(c.body),
      cta: clip(c.ctaText, 60),
      link_url: clip(c.linkUrl, 300),
    })),
  };
}

function assertFacebookUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ExpectedToolError(
      "tool_input_invalid",
      "scrape_meta_ads `page_url` is not a URL.",
    );
  }
  const host = u.hostname.replace(/^www\./, "");
  if (u.protocol !== "https:" || (host !== "facebook.com" && !host.endsWith(".facebook.com"))) {
    throw new ExpectedToolError(
      "tool_input_invalid",
      "scrape_meta_ads `page_url` must be an https://www.facebook.com/… URL — either the advertiser's Page or a Meta Ad Library view URL. To search by brand or keyword instead, pass `query`.",
    );
  }
  return u.toString();
}

function adLibrarySearchUrl(a: z.infer<typeof metaAdsLibInput>): string {
  const sp = new URLSearchParams({
    active_status: a.active_status,
    ad_type: "all",
    country: a.country.toUpperCase(),
    q: a.query as string,
    search_type: "keyword_unordered",
    media_type: "all",
  });
  return `https://www.facebook.com/ads/library/?${sp.toString()}`;
}

async function runMetaAdsLibrary(
  token: string,
  a: z.infer<typeof metaAdsLibInput>,
): Promise<unknown> {
  if (!a.page_url === !a.query) {
    throw new ExpectedToolError(
      "tool_input_invalid",
      "scrape_meta_ads needs EXACTLY ONE of `page_url` (one named advertiser — use this for the customer's own page) or `query` (a brand/keyword search — use this to find competitors).",
    );
  }
  const scope = a.page_url ? ("page" as const) : ("search" as const);
  const url = a.page_url ? assertFacebookUrl(a.page_url) : adLibrarySearchUrl(a);

  const items = (await callApifySync(token, META_ADS_LIB_ACTOR, {
    startUrls: [{ url }],
    resultsLimit: a.max_items,
    activeStatus: a.active_status,
  })) as AdLibRaw[];

  const ads = items.filter((i) => i && typeof i === "object").map(mapAdLibraryItem);

  if (ads.length === 0) {
    throw new ExpectedToolError(
      "tool_no_data",
      `scrape_meta_ads found no ads in the Meta Ad Library for ${scope === "page" ? a.page_url : `"${a.query}"`} (country=${a.country}, active_status=${a.active_status}). That is NOT proof they advertise nothing: the country filter, the active filter, or the spelling of the advertiser will each produce this. Widen country to ALL or active_status to 'all' before concluding anything, and report an unresolved lookup as a gap rather than as an absence of ads.`,
    );
  }

  return {
    source: "meta_ad_library" as const,
    scope,
    looked_up: scope === "page" ? url : a.query,
    country: a.country.toUpperCase(),
    active_status: a.active_status,
    bounds:
      "Public Meta Ad Library records: what this advertiser is SAYING and how long each ad has run. No spend, reach, CTR or conversion data — Meta publishes those for political/issue ads only.",
    ads_returned: ads.length,
    ads,
  };
}

type PinRaw = {
  type?: string;
  url?: string;
  title?: string | null;
  description?: string | null;
  link?: string | null;
  domain?: string | null;
  saves?: number | null;
  comments?: number | null;
  createdAt?: string | null;
  isVideo?: boolean | null;
  pinner?: { username?: string | null; followerCount?: number | null } | null;
  board?: { name?: string | null } | null;
  sourceQueries?: string[];
  query?: string | null;
  searchQuery?: string | null;
};

type TrendRaw = {
  term?: string;
  rank?: number;
  trendType?: string;
  weeklyChange?: number | null;
  monthlyChange?: number | null;
  yearlyChange?: number | null;
  seasonalityScore?: number | null;
  pinterestTrendsUrl?: string | null;
};

function pinNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function mapPinterestPin(r: PinRaw) {
  const created = r.createdAt ? new Date(r.createdAt) : null;
  return {
    pin_url: clip(r.url, 200),
    title: clip(r.title, 120),
    description: clip(r.description, 240),
    link: clip(r.link, 240),
    domain: r.domain && !/^uploaded by user$/i.test(r.domain.trim()) ? clip(r.domain, 80) : null,
    saves: pinNum(r.saves),
    comments: pinNum(r.comments),
    created_at: created && !Number.isNaN(created.getTime()) ? created.toISOString().slice(0, 10) : null,
    is_video: r.isVideo ?? null,
    board: clip(r.board?.name, 80),
    pinner: clip(r.pinner?.username, 60),
    pinner_followers: pinNum(r.pinner?.followerCount),
  };
}

export function summarisePinSearch(query: string, pins: ReturnType<typeof mapPinterestPin>[]) {
  const saves = pins.map((p) => p.saves).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const mid = Math.floor(saves.length / 2);
  const median = saves.length === 0 ? null : saves.length % 2 ? saves[mid] : (saves[mid - 1] + saves[mid]) / 2;
  const domains = new Map<string, number>();
  for (const p of pins) if (p.domain) domains.set(p.domain, (domains.get(p.domain) ?? 0) + 1);
  return {
    query,
    pins_read: pins.length,
    median_saves: median,
    max_saves: saves.length ? saves[saves.length - 1] : null,
    video_pins: pins.filter((p) => p.is_video).length,
    winning_domains: Object.fromEntries([...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)),
  };
}

async function runPinterest(token: string, a: z.infer<typeof pinterestInput>): Promise<unknown> {
  if (!a.queries || a.queries.length === 0) {
    throw new ExpectedToolError("tool_input_invalid", `scrape_pinterest mode='${a.mode}' needs \`queries\`.`);
  }

  if (a.mode === "trends") {
    let items: TrendRaw[];
    try {
      items = (await callApifySync(token, PINTEREST_TRENDS_ACTOR, {
        countries: [a.country.toUpperCase()],
        trendTypes: [a.trend_type],
        keywordsToInclude: a.queries,
        maxResultsPerCountry: 20,
        lookbackWindow: "30D",
      })) as TrendRaw[];
    } catch (e) {
      if (!/run-failed|did not succeed/i.test((e as Error).message ?? "")) throw e;
      throw new ExpectedToolError(
        "pinterest_trends_unavailable",
        `Pinterest trends returned nothing for ${a.queries.map((q) => `"${q}"`).join(" or ")} (${a.trend_type}, ${a.country.toUpperCase()}): either no curated trending term contains it, or the trends reader failed. Report trends as NOT RUN, never as "nobody searches this". One retry with a single broader word is reasonable.`,
      );
    }
    const terms = items
      .filter((t) => t && typeof t.term === "string")
      .slice(0, 20)
      .map((t) => ({
        term: t.term!,
        rank: pinNum(t.rank),
        weekly_change: pinNum(t.weeklyChange),
        monthly_change: pinNum(t.monthlyChange),
        yearly_change: pinNum(t.yearlyChange),
        seasonality: pinNum(t.seasonalityScore),
      }));
    if (terms.length === 0) {
      throw new ExpectedToolError(
        "tool_no_data",
        `No ${a.trend_type} Pinterest trends in ${a.country.toUpperCase()} contain ${a.queries.map((q) => `"${q}"`).join(" or ")}. Trends lists are short curated tops, so an empty list is NOT "nobody searches this". Try one broad word (e.g. the product noun alone) or another trend_type.`,
      );
    }
    return {
      source: "pinterest_trends_public" as const,
      country: a.country.toUpperCase(),
      trend_type: a.trend_type,
      contains: a.queries,
      terms,
      bounds:
        "Changes are Pinterest's own relative search-volume changes (e.g. 7 = +700%). No absolute search volume. Seasonality near 1 means the term peaks at the same time every year.",
    };
  }

  const queries = a.queries.slice(0, 3);
  const results = [];
  for (const q of queries) {
    const items = (await callApifySync(token, PINTEREST_ACTOR, {
      search: q,
      maxItems: a.max_items,
    })) as PinRaw[];
    const pins = items.filter((i) => i && typeof i === "object" && (i.type ?? "pin") === "pin").map(mapPinterestPin);
    results.push({ summary: summarisePinSearch(q, pins), pins });
  }
  if (results.every((r) => r.pins.length === 0)) {
    throw new ExpectedToolError(
      "tool_no_data",
      `Pinterest search returned no pins for ${queries.map((q) => `"${q}"`).join(", ")}. That is a failed read, not proof nobody pins this. Try a plainer phrase.`,
    );
  }
  return {
    source: "pinterest_search_public" as const,
    summaries: results.map((r) => r.summary),
    results: results.map((r) => ({ query: r.summary.query, pins: r.pins })),
    bounds:
      "Public search results in Pinterest's own order, which is personalised and not a rank. Saves and comments are public counts, never reach.",
  };
}

async function callApifySync(
  token: string,
  actor: string,
  body: unknown,
  opts: { memoryMb?: number } = {},
): Promise<unknown[]> {
  const memory = opts.memoryMb ? `&memory=${opts.memoryMb}` : "";
  const url = `${APIFY_BASE}/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}${memory}`;
  const startedAt = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), APIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (apifyRanAndBilled(res.status)) {
        recordApifyCall({ actor, ms: Date.now() - startedAt, memoryMb: opts.memoryMb ?? null, items: 0, at: new Date(startedAt) });
      }
      if (res.status === 403 && /platform-feature-disabled|hard limit exceeded|usage limit/i.test(text)) {
        throw new ExpectedToolError(
          "apify_quota_exhausted",
          "Apify monthly usage limit is exhausted — the account is out of credit, the token is NOT the problem. Instagram, TikTok, Reddit and rendered-page reads are unavailable until the billing cycle resets or the plan is upgraded. Treat the requested data as UNVERIFIED: do not describe it from memory and do not substitute an estimate.",
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new ExpectedToolError(
          "apify_auth_failed",
          `Apify auth failed (${res.status}). Check APIFY_TOKEN.`,
        );
      }
      if (res.status === 408) {
        throw new ExpectedToolError(
          "apify_timeout",
          "Apify actor exceeded sync timeout. Reduce max_items or retry.",
        );
      }
      if (res.status === 429) {
        throw new ExpectedToolError(
          "apify_rate_limited",
          "Apify rate-limited. Retry after a minute.",
        );
      }
      throw new Error(`apify HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    const items = Array.isArray(json) ? json : [];
    recordApifyCall({ actor, ms: Date.now() - startedAt, memoryMb: opts.memoryMb ?? null, items: items.length, at: new Date(startedAt) });
    return items;
  } catch (e) {
    if ((e as { name?: string }).name === "AbortError") {
      recordApifyCall({ actor, ms: Date.now() - startedAt, memoryMb: opts.memoryMb ?? null, items: 0, at: new Date(startedAt) });
      throw new ExpectedToolError(
        "apify_timeout",
        `Apify actor exceeded ${APIFY_TIMEOUT_MS / 1000}s wait.`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function errorResult(start: number, code: string, message: string): McpCallResult {
  return {
    ok: false,
    is_error: true,
    content: JSON.stringify({ error: code, message }),
    ms: Date.now() - start,
  };
}
