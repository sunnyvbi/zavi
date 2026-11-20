import { describe, it, expect, vi } from "vitest";

vi.mock("../../../onboarding/enrichment/url-guard", () => ({
  assertSafeUrl: vi.fn(async () => {}),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { fetchWithGuards, WebFetchError } from "../web_fetch_core";

const LI_OG = `<html><head>
<meta property="og:title" content="Andrea Manrique - Yanne Capital | LinkedIn">
<meta property="og:description" content="Associate at Kadenwood Group · Experience: Yanne Capital · Education: Universidad Autónoma de Bucaramanga · Location: United States · 500+ connections on LinkedIn.">
<title>Andrea Manrique - Yanne Capital | LinkedIn</title>
</head><body>Sign Up | LinkedIn — Join LinkedIn</body></html>`;

function mkRes(status: number, body: string): Response {
  if (status >= 200 && status <= 599) {
    return new Response(body, { status, headers: new Headers({ "content-type": "text/html" }) });
  }
  return {
    status,
    headers: new Headers({ "content-type": "text/html" }),
    body: null,
  } as unknown as Response;
}

function uaFetch(handler: (url: string, ua: string) => Response): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ua = headers["user-agent"] ?? "";
    return handler(url.toString(), ua);
  }) as typeof fetch;
}

const OPTS = { max_bytes: 1_000_000, timeout_ms: 10_000 };
const LI_URL = "https://www.linkedin.com/in/andrea-manrique-0a90b013b/";

describe("crawler-UA og-card fallback", () => {
  it("LinkedIn 999 on default UA → retries with crawler UA → social_card with the profile", async () => {
    const fetchFn = uaFetch((_url, ua) =>
      ua.includes("facebookexternalhit") ? mkRes(200, LI_OG) : mkRes(999, "blocked"),
    );
    const r = await fetchWithGuards(LI_URL, OPTS, fetchFn);
    expect(r.capture).toBe("social_card");
    expect(r.body_text).toContain("Yanne Capital");
    expect(r.body_text).toContain("social preview card");
    expect(r.status).toBe(200);
  });

  it("non-social host 999 → blocked, NO crawler retry (gate)", async () => {
    let sawCrawlerUa = false;
    const fetchFn = uaFetch((_url, ua) => {
      if (ua.includes("facebookexternalhit")) sawCrawlerUa = true;
      return mkRes(999, "blocked");
    });
    const r = await fetchWithGuards("https://8.8.8.8/", OPTS, fetchFn);
    expect(r.capture).toBe("blocked");
    expect(sawCrawlerUa).toBe(false);
  });

  it("LinkedIn 999 + crawler UA also blocked → falls through to blocked (no loop)", async () => {
    let crawlerHits = 0;
    const fetchFn = uaFetch((_url, ua) => {
      if (ua.includes("facebookexternalhit")) crawlerHits++;
      return mkRes(999, "blocked");
    });
    const r = await fetchWithGuards(LI_URL, OPTS, fetchFn);
    expect(r.capture).toBe("blocked");
    expect(crawlerHits).toBe(1);
  });

  it("LinkedIn 999 + crawler UA 200 but no og card → blocked (not a false social_card)", async () => {
    const fetchFn = uaFetch((_url, ua) =>
      ua.includes("facebookexternalhit")
        ? mkRes(200, "<html><body>just a wall, no meta</body></html>")
        : mkRes(999, "blocked"),
    );
    const r = await fetchWithGuards(LI_URL, OPTS, fetchFn);
    expect(r.capture).toBe("blocked");
  });

  it("451 on a social host still THROWS (legal error, not anti-bot — no crawler retry)", async () => {
    const fetchFn = uaFetch(() => mkRes(451, "gone for legal reasons"));
    await expect(fetchWithGuards(LI_URL, OPTS, fetchFn)).rejects.toThrow(WebFetchError);
  });
});
