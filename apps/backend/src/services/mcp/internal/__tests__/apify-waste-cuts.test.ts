import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

const apifyUrls: string[] = [];
const bodies: Array<Record<string, unknown>> = [];
let responses: unknown[][] = [];

function mockApify() {
  apifyUrls.length = 0;
  bodies.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (!u.includes("api.apify.com")) {
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }
      apifyUrls.push(u);
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return new Response(JSON.stringify(responses.shift() ?? []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const page = (status: number, bytes: number) => [
  { markdown: "x".repeat(bytes), crawl: { httpStatusCode: status }, metadata: { url: "u" } },
];

const err = (r: unknown) => {
  const c = (r as { content: string }).content;
  return JSON.parse(c) as { error?: string; code?: string; message?: string };
};

beforeEach(async () => {
  process.env.APIFY_TOKEN = "test-token";
  delete process.env.APIFY_RAG_MEMORY_MB;
  responses = [];
  mockApify();
  const { resetUnreachableForTest } = await import("../apify");
  resetUnreachableForTest();
});

describe("rag-web-browser memory", () => {
  it("asks Apify for 4096 MB by default instead of the actor's 8 GB", async () => {
    responses = [page(200, 500)];
    const { callApifyTool } = await import("../apify");
    await callApifyTool("t1", "rag_web_browser", { url: "https://example.com/a" });
    expect(apifyUrls[0]).toContain("&memory=4096");
  });

  it("takes a valid APIFY_RAG_MEMORY_MB and ignores an invalid one", async () => {
    const { ragMemoryMb } = await import("../apify");
    process.env.APIFY_RAG_MEMORY_MB = "2048";
    expect(ragMemoryMb()).toBe(2048);
    process.env.APIFY_RAG_MEMORY_MB = "3000";
    expect(ragMemoryMb()).toBe(4096);
    process.env.APIFY_RAG_MEMORY_MB = "banana";
    expect(ragMemoryMb()).toBe(4096);
  });

  it("does not set memory on the other actors", async () => {
    responses = [[]];
    const { callApifyTool } = await import("../apify");
    await callApifyTool("t1", "scrape_reddit", { mode: "search_posts", query: "best crm" });
    expect(apifyUrls[0]).not.toContain("memory=");
  });
});

describe("per-run caps", () => {
  it("stops scrape_reddit at 12 calls in one run, and leaves another run alone", async () => {
    const { callApifyTool } = await import("../apify");
    for (let i = 0; i < 12; i++) {
      responses.push([]);
      await callApifyTool("t1", "scrape_reddit", { mode: "search_posts", query: `q${i}` }, "run-A");
    }
    const thirteenth = await callApifyTool(
      "t1",
      "scrape_reddit",
      { mode: "search_posts", query: "q13" },
      "run-A",
    );
    expect(apifyUrls.length).toBe(12);
    expect(JSON.stringify(err(thirteenth))).toContain("apify_run_budget_spent");

    responses.push([]);
    await callApifyTool("t1", "scrape_reddit", { mode: "search_posts", query: "other" }, "run-B");
    expect(apifyUrls.length).toBe(13);
  });

  it("stops the 9th reddit thread read in one run before it reaches Apify, through the real MCP path", async () => {
    const { callRedditTool } = await import("../reddit");
    const results: Array<{ content: string }> = [];
    for (let i = 1; i <= 9; i++) {
      responses.push(page(200, 600));
      results.push(
        (await callRedditTool(
          "t1",
          "thread_read",
          { url: `https://www.reddit.com/r/webdev/comments/abc${i}/some_thread/` },
          "run-T",
        )) as { content: string },
      );
    }
    expect(apifyUrls.length).toBe(8);
    expect(results[8].content).toContain("reddit_thread_read_budget_spent");
  });

  it("leaves thread reads uncapped when there is no run (chat-style caller), as before", async () => {
    const { callRedditTool } = await import("../reddit");
    for (let i = 1; i <= 9; i++) {
      responses.push(page(200, 600));
      await callRedditTool("t1", "thread_read", {
        url: `https://www.reddit.com/r/webdev/comments/def${i}/x/`,
      });
    }
    expect(apifyUrls.length).toBe(9);
  });

  it("a run that spent its thread reads can still render other pages", async () => {
    const { takeApifyCall } = await import("../apify");
    for (let i = 0; i < 8; i++) takeApifyCall("run-U", "reddit_thread_read");
    expect(takeApifyCall("run-U", "reddit_thread_read")).toBe(false);
    expect(takeApifyCall("run-U", "rag_web_browser")).toBe(true);
  });
});

describe("residential retry", () => {
  it("does not pay for a residential retry on a 404", async () => {
    responses = [page(404, 0)];
    const { callApifyTool } = await import("../apify");
    const r = await callApifyTool("t1", "rag_web_browser", { url: "https://example.com/gone" });
    expect(apifyUrls.length).toBe(1);
    expect(JSON.stringify(err(r))).toContain("rag_web_browser_not_found");
  });

  it("still retries once on a 5xx, as before", async () => {
    responses = [page(500, 0), page(200, 400)];
    const { callApifyTool } = await import("../apify");
    const r = (await callApifyTool("t1", "rag_web_browser", { url: "https://g2.com/x" })) as {
      is_error: boolean;
    };
    expect(apifyUrls.length).toBe(2);
    expect(bodies[1].proxyConfiguration).toBeDefined();
    expect(r.is_error).toBe(false);
  });

  it("skips a page for 24h after it fails on both tiers", async () => {
    responses = [page(500, 0), page(500, 0)];
    const { callApifyTool } = await import("../apify");
    await callApifyTool("t1", "rag_web_browser", { url: "https://www.iana.org/p" });
    expect(apifyUrls.length).toBe(2);

    const again = await callApifyTool("t1", "rag_web_browser", { url: "https://www.iana.org/p" });
    expect(apifyUrls.length).toBe(2);
    expect(JSON.stringify(err(again))).toContain("rag_web_browser_recently_unreachable");
  });

  it("skips a whole site after three pages miss, but a working site is untouched", async () => {
    const { callApifyTool } = await import("../apify");
    for (const p of ["a", "b", "c"]) {
      responses.push(page(500, 0), page(500, 0));
      await callApifyTool("t1", "rag_web_browser", { url: `https://example.org/${p}` });
    }
    const before = apifyUrls.length;
    const fourth = await callApifyTool("t1", "rag_web_browser", {
      url: "https://example.org/d",
    });
    expect(apifyUrls.length).toBe(before);
    expect(JSON.stringify(err(fourth))).toContain("rag_web_browser_recently_unreachable");

    responses.push(page(200, 300));
    const fine = (await callApifyTool("t1", "rag_web_browser", {
      url: "https://example.com/",
    })) as { is_error: boolean };
    expect(fine.is_error).toBe(false);
  });

  it("never skips all of reddit.com because some threads failed", async () => {
    const { recentlyUnreachable, markUnreachable } = await import("../apify");
    for (const t of ["1", "2", "3", "4"]) {
      markUnreachable("t1", `https://www.reddit.com/r/x/comments/${t}/`, { siteLevel: false });
    }
    expect(recentlyUnreachable("t1", "https://www.reddit.com/r/x/comments/5/")).toBe(0);
    expect(recentlyUnreachable("t1", "https://www.reddit.com/r/x/comments/1/")).toBeGreaterThan(0);
  });

  it("one tenant's failures never make a page or site unreadable for another tenant", async () => {
    const { recentlyUnreachable, markUnreachable } = await import("../apify");
    for (const p of ["a", "b", "c", "d"]) {
      markUnreachable("tenant-A", `https://victim.example.com/${p}`, { siteLevel: true });
    }
    expect(recentlyUnreachable("tenant-A", "https://victim.example.com/z")).toBeGreaterThan(0);
    expect(recentlyUnreachable("tenant-B", "https://victim.example.com/z")).toBe(0);
    expect(recentlyUnreachable("tenant-B", "https://victim.example.com/a")).toBe(0);
  });

  it("reports a reddit 404 as not found, not as a both-tier failure, and does not skip the page", async () => {
    responses = [page(404, 0)];
    const { callApifyTool, recentlyUnreachable } = await import("../apify");
    const url = "https://www.reddit.com/r/webdev/comments/gone1/x/";
    const r = await callApifyTool("t1", "rag_web_browser", { url });
    expect(apifyUrls.length).toBe(1);
    expect(JSON.stringify(err(r))).toContain("rag_web_browser_not_found");
    expect(recentlyUnreachable("t1", url)).toBe(0);
  });

  it("forgets a skipped page after 24 hours", async () => {
    const { recentlyUnreachable, markUnreachable } = await import("../apify");
    const t0 = 1_000_000;
    markUnreachable("t1", "https://late.example.com/p", { siteLevel: true }, t0);
    expect(recentlyUnreachable("t1", "https://late.example.com/p", t0 + 1000)).toBeGreaterThan(0);
    expect(recentlyUnreachable("t1", "https://late.example.com/p", t0 + 24 * 3600 * 1000 + 1)).toBe(0);
  });
});
