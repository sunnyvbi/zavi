
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { callApifyTool, resolveValidatedFinalUrl } from "../apify";
import { SsrfBlockedError } from "@/services/onboarding/enrichment/url-guard";
import { ExpectedToolError } from "@/services/tools/types";

function mkRedirect(loc: string): Response {
  return new Response("", { status: 302, headers: new Headers({ location: loc }) });
}
function mkOk(): Response {
  return new Response("ok", { status: 200, headers: new Headers({ "content-type": "text/html" }) });
}
function fakeFetch(map: Record<string, Response>) {
  return (async (url: string | URL) => {
    const r = map[url.toString()];
    if (!r) throw new Error(`fake fetch: no entry for ${url}`);
    return r;
  }) as typeof fetch;
}

const TENANT = "00000000-0000-0000-0000-000000000000";

describe("callApifyTool: rag_web_browser SSRF defense", () => {
  let prevToken: string | undefined;
  beforeEach(() => {
    prevToken = process.env.APIFY_TOKEN;
    process.env.APIFY_TOKEN = "test-token-not-used";
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = prevToken;
  });

  it("rejects the EC2 IMDS link-local address (169.254.169.254)", async () => {
    const r = await callApifyTool(TENANT, "rag_web_browser", {
      url: "https://169.254.169.254/latest/meta-data/",
    });
    expect(r.is_error).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.error).toBe("ssrf_blocked");
  });

  it("rejects a private RFC1918 literal (10.0.0.1)", async () => {
    const r = await callApifyTool(TENANT, "rag_web_browser", {
      url: "https://10.0.0.1/admin",
    });
    expect(r.is_error).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.error).toBe("ssrf_blocked");
  });

  it("rejects a non-https scheme (http://localhost/)", async () => {
    const r = await callApifyTool(TENANT, "rag_web_browser", {
      url: "http://localhost/",
    });
    expect(r.is_error).toBe(true);
    const parsed = JSON.parse(r.content);
    expect(parsed.error).toBe("ssrf_scheme");
  });
});

describe("resolveValidatedFinalUrl: redirect-hop SSRF — FAIL CLOSED (P1-B)", () => {
  it("rejects a public URL that 302-redirects to an internal target", async () => {
    const fake = fakeFetch({
      "https://8.8.8.8/start": mkRedirect("https://169.254.169.254/"),
    });
    await expect(
      resolveValidatedFinalUrl("https://8.8.8.8/start", fake),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("returns the validated final URL after a safe redirect chain ending in a non-redirect", async () => {
    const fake = fakeFetch({
      "https://8.8.8.8/a": mkRedirect("https://8.8.8.8/b"),
      "https://8.8.8.8/b": mkOk(),
    });
    const final = await resolveValidatedFinalUrl("https://8.8.8.8/a", fake);
    expect(final).toBe("https://8.8.8.8/b");
  });

  it("FAILS CLOSED when the origin can't be preflighted (network error → throws, does NOT return a url)", async () => {
    const fake = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(
      resolveValidatedFinalUrl("https://8.8.8.8/x", fake),
    ).rejects.toBeInstanceOf(ExpectedToolError);
    await expect(
      resolveValidatedFinalUrl("https://8.8.8.8/x", fake),
    ).rejects.toMatchObject({ code: "render_preflight_failed" });
  });

  it("FAILS CLOSED on too many redirects (never hands Apify an unvalidated hop)", async () => {
    const fake = fakeFetch({
      "https://8.8.8.8/1": mkRedirect("https://8.8.8.8/2"),
      "https://8.8.8.8/2": mkRedirect("https://8.8.8.8/3"),
      "https://8.8.8.8/3": mkRedirect("https://8.8.8.8/4"),
      "https://8.8.8.8/4": mkRedirect("https://8.8.8.8/5"),
    });
    await expect(
      resolveValidatedFinalUrl("https://8.8.8.8/1", fake),
    ).rejects.toMatchObject({ code: "render_too_many_redirects" });
  });

  it("FAILS CLOSED on a redirect with no Location header", async () => {
    const fake = fakeFetch({
      "https://8.8.8.8/noloc": new Response("", { status: 302, headers: new Headers() }),
    });
    await expect(
      resolveValidatedFinalUrl("https://8.8.8.8/noloc", fake),
    ).rejects.toMatchObject({ code: "render_preflight_failed" });
  });
});

describe("callApifyTool rag_web_browser: render NOT attempted when preflight fails closed (P1-B)", () => {
  let prevToken: string | undefined;
  beforeEach(() => {
    prevToken = process.env.APIFY_TOKEN;
    process.env.APIFY_TOKEN = "test-token-not-used";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevToken === undefined) delete process.env.APIFY_TOKEN;
    else process.env.APIFY_TOKEN = prevToken;
  });

  it("preflight 302→internal host: render NOT called (no apify HTTP egress)", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = url.toString();
        seen.push(u);
        if (u === "https://8.8.8.8/start") return mkRedirect("https://169.254.169.254/");
        throw new Error(`unexpected fetch ${u}`);
      }),
    );
    const r = await callApifyTool(TENANT, "rag_web_browser", {
      url: "https://8.8.8.8/start",
    });
    expect(r.is_error).toBe(true);
    expect(JSON.parse(r.content).error).toBe("ssrf_blocked");
    expect(seen.some((u) => u.includes("api.apify.com"))).toBe(false);
  });

  it("preflight network error: render NOT called (fails closed)", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        seen.push(url.toString());
        throw new Error("ETIMEDOUT");
      }),
    );
    const r = await callApifyTool(TENANT, "rag_web_browser", {
      url: "https://8.8.8.8/x",
    });
    expect(r.is_error).toBe(true);
    expect(JSON.parse(r.content).error).toBe("render_preflight_failed");
    expect(seen.some((u) => u.includes("api.apify.com"))).toBe(false);
  });
});

describe("resolveValidatedFinalUrl: allowed_origin pin (2026-07-18)", () => {
  it("refuses a redirect to a DIFFERENT public origin when pinned", async () => {
    const fake = fakeFetch({
      "https://8.8.8.8/a": mkRedirect("https://1.1.1.1/b"),
      "https://1.1.1.1/b": mkOk(),
    });
    await expect(
      resolveValidatedFinalUrl("https://8.8.8.8/a", fake, "https://8.8.8.8"),
    ).rejects.toMatchObject({ code: "render_origin_refused" });
  });

  it("allows a same-origin redirect chain when pinned", async () => {
    const fake = fakeFetch({
      "https://8.8.8.8/a": mkRedirect("https://8.8.8.8/b"),
      "https://8.8.8.8/b": mkOk(),
    });
    const final = await resolveValidatedFinalUrl(
      "https://8.8.8.8/a",
      fake,
      "https://8.8.8.8",
    );
    expect(final).toBe("https://8.8.8.8/b");
  });

  it("is byte-for-byte unchanged when NO origin is pinned (open-web callers)", async () => {
    const fake = fakeFetch({
      "https://8.8.8.8/a": mkRedirect("https://1.1.1.1/b"),
      "https://1.1.1.1/b": mkOk(),
    });
    const final = await resolveValidatedFinalUrl("https://8.8.8.8/a", fake);
    expect(final).toBe("https://1.1.1.1/b");
  });
});
