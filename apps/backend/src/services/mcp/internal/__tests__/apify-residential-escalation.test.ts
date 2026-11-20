import { describe, expect, it, vi, beforeEach } from "vitest";

const payload = (r: unknown) =>
  JSON.parse((r as { content: string }).content) as Record<string, unknown>;

const calls: Array<Record<string, unknown>> = [];
let responses: unknown[][] = [];

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

function mockApify() {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string; method?: string }) => {
      const u = String(url);
      if (!u.includes("api.apify.com")) {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      calls.push(JSON.parse(init?.body ?? "{}"));
      const next = responses.shift() ?? [];
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const ok = (bytes: number) => [
  { markdown: "x".repeat(bytes), crawl: { httpStatusCode: 200 }, metadata: { url: "u" } },
];
const blocked = () => [{ markdown: "", crawl: { httpStatusCode: 500 }, metadata: { url: "u" } }];

describe("rag_web_browser proxy escalation", () => {
  beforeEach(() => {
    process.env.APIFY_TOKEN = "test-token";
    mockApify();
  });

  it("uses the cheap datacenter pool first and does NOT pay for residential when it works", async () => {
    responses = [ok(500)];
    const { callApifyTool } = await import("../apify");
    await callApifyTool("t1", "rag_web_browser", { url: "https://example.com" });
    expect(calls.length).toBe(1);
    expect(calls[0].proxyConfiguration).toBeUndefined();
  });

  it("escalates to residential exactly once when the datacenter attempt is blocked", async () => {
    responses = [blocked(), ok(60_000)];
    const { callApifyTool } = await import("../apify");
    const res = payload(
      await callApifyTool("t1", "rag_web_browser", {
        url: "https://www.g2.com/products/acme/reviews",
      }),
    );
    expect(calls.length).toBe(2);
    expect(calls[0].proxyConfiguration).toBeUndefined();
    expect(calls[1].proxyConfiguration).toEqual({
      useApifyProxy: true,
      apifyProxyGroups: ["RESIDENTIAL"],
    });
    expect(res.proxy_tier).toBe("residential");
    expect(String(res.content).length).toBeGreaterThan(0);
  });

  it("skips the futile datacenter attempt for reddit.com — ONE call, straight to residential", async () => {
    responses = [ok(60_000)];
    const { callApifyTool } = await import("../apify");
    const res = payload(
      await callApifyTool("t1", "rag_web_browser", {
        url: "https://www.reddit.com/r/smallbusiness/comments/abc/x/",
      }),
    );
    expect(calls.length).toBe(1);
    expect(calls[0].proxyConfiguration).toEqual({
      useApifyProxy: true,
      apifyProxyGroups: ["RESIDENTIAL"],
    });
    expect(res.proxy_tier).toBe("residential");
  });

  it("short-circuits a reddit SUBDOMAIN too, but never a lookalike host", async () => {
    responses = [ok(60_000)];
    const { callApifyTool } = await import("../apify");
    await callApifyTool("t1", "rag_web_browser", { url: "https://old.reddit.com/r/x/" });
    expect(calls.length).toBe(1);
    expect(calls[0].proxyConfiguration).toBeDefined();

    calls.length = 0;
    responses = [ok(500)];
    await callApifyTool("t1", "rag_web_browser", { url: "https://notreddit.com/x" });
    expect(calls.length).toBe(1);
    expect(calls[0].proxyConfiguration).toBeUndefined();
  });

  it("does not retry a third time, so a truly dead page stays an honest absence", async () => {
    responses = [blocked(), blocked()];
    const { callApifyTool } = await import("../apify");
    const res = (await callApifyTool("t1", "rag_web_browser", {
      url: "https://example.com/gone",
    })) as { ok: boolean; is_error: boolean; content: string };
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/datacenter or the residential proxy/i);
    expect(calls.length).toBe(2);
  });

  it("treats an empty body with a 200 as blocked — the false-200 shape", async () => {
    responses = [[{ markdown: "", crawl: { httpStatusCode: 200 } }], ok(40_000)];
    const { callApifyTool } = await import("../apify");
    const res = payload(
      await callApifyTool("t1", "rag_web_browser", {
        url: "https://www.g2.com/products/acme/reviews",
      }),
    );
    expect(calls.length).toBe(2);
    expect(res.proxy_tier).toBe("residential");
  });
});
