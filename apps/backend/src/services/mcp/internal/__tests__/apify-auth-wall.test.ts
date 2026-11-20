import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));

const THREAD = "https://old.reddit.com/r/SaaS/comments/1f5mjfs/x/";
const LOGIN =
  "https://old.reddit.com/login/?reason=lor2&dest=https%3A%2F%2Fold.reddit.com%2Fr%2FSaaS%2Fcomments%2F1f5mjfs%2Fx%2F";

const LOGIN_MARKDOWN =
  "Welcome to Reddit\n\n# Log in\n\nBy continuing, you agree to our User Agreement. " +
  "x".repeat(4000);

function stub(opts: { redirectTo?: string; renderedUrl: string; markdown: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { redirect?: string }) => {
      const u = String(url);
      if (u.includes("api.apify.com")) {
        return new Response(
          JSON.stringify([
            {
              markdown: opts.markdown,
              crawl: { httpStatusCode: 200 },
              metadata: { url: opts.renderedUrl, title: "Welcome to Reddit" },
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (opts.redirectTo && u === THREAD && init?.redirect === "manual") {
        return new Response("", { status: 302, headers: { location: opts.redirectTo } });
      }
      return new Response("", { status: 200, headers: { "content-type": "text/html" } });
    }),
  );
}

describe("rag_web_browser auth-wall guard", () => {
  beforeEach(() => {
    process.env.APIFY_TOKEN = "test-token";
  });

  it("refuses to return a login page as if it were the requested thread", async () => {
    stub({ redirectTo: LOGIN, renderedUrl: LOGIN, markdown: LOGIN_MARKDOWN });
    const { callApifyTool } = await import("../apify");
    const res = (await callApifyTool("t1", "rag_web_browser", { url: THREAD })) as {
      is_error: boolean;
      content: string;
    };
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/auth_wall|authentication page/i);
    expect(res.content).not.toMatch(/Welcome to Reddit/);
  });

  it("still returns a real thread that never redirected", async () => {
    const body = "# Any employee scheduling tools?\n\n" + "real thread text ".repeat(200);
    stub({ renderedUrl: THREAD, markdown: body });
    const { callApifyTool } = await import("../apify");
    const res = (await callApifyTool("t1", "rag_web_browser", { url: THREAD })) as {
      is_error: boolean;
      content: string;
    };
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).content).toContain("employee scheduling");
  });

  it("does NOT fire when the caller deliberately asked for a login page", async () => {
    const target = "https://example.com/login";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("api.apify.com")
          ? new Response(
              JSON.stringify([
                {
                  markdown: LOGIN_MARKDOWN,
                  crawl: { httpStatusCode: 200 },
                  metadata: { url: target },
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            )
          : new Response("", { status: 200, headers: { "content-type": "text/html" } }),
      ),
    );
    const { callApifyTool } = await import("../apify");
    const res = (await callApifyTool("t1", "rag_web_browser", { url: target })) as {
      is_error: boolean;
    };
    expect(res.is_error).toBe(false);
  });

  it("does NOT fire on a path that merely contains the word login", async () => {
    const target = "https://example.com/blog/x";
    const landed = "https://example.com/blog/login-flow-teardown";
    stub({ redirectTo: landed, renderedUrl: landed, markdown: "a real article ".repeat(200) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { redirect?: string }) => {
        const u = String(url);
        if (u.includes("api.apify.com")) {
          return new Response(
            JSON.stringify([
              {
                markdown: "a real article ".repeat(200),
                crawl: { httpStatusCode: 200 },
                metadata: { url: landed },
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u === target && init?.redirect === "manual") {
          return new Response("", { status: 302, headers: { location: landed } });
        }
        return new Response("", { status: 200, headers: { "content-type": "text/html" } });
      }),
    );
    const { callApifyTool } = await import("../apify");
    const res = (await callApifyTool("t1", "rag_web_browser", { url: target })) as {
      is_error: boolean;
    };
    expect(res.is_error).toBe(false);
  });
});
