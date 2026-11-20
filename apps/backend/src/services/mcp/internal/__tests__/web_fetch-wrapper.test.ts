
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { promises as dnsPromises } from "node:dns";
import { callWebFetchTool, listWebFetchTools, __resetControlProbeMemo, SEARCH_INSTEAD_HINT } from "../web_fetch";

function mkResponse(status: number, body = "", headers: Record<string, string> = { "content-type": "text/html" }): Response {
  return new Response(body, { status, headers: new Headers(headers) });
}

beforeEach(() => {
  vi.spyOn(dnsPromises, "lookup").mockImplementation((async (host: string) => {
    const why =
      `live DNS attempted for "${host}" — this suite must not resolve real ` +
      `hostnames. Use a literal public IP, or call stubPublicDns().`;
    console.error(`[web_fetch-wrapper.test] ${why}`);
    throw new Error(why);
  }) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubPublicDns(): void {
  vi.spyOn(dnsPromises, "lookup").mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
  ] as never);
}

describe("callWebFetchTool — blocked envelope (P1-A)", () => {
  it("403 surfaces as is_error:true with capture:'blocked' + structured fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(403, "forbidden")));
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/" });
    expect(res.is_error).toBe(true);
    expect(res.ok).toBe(false);
    const parsed = JSON.parse(res.content);
    expect(parsed.error).toBe("web_fetch_http_error");
    expect(parsed.capture).toBe("blocked");
    expect(parsed.status).toBe(403);
    expect(parsed.final_url).toBe("https://8.8.8.8/");
    expect(parsed.meta.status).toBe(403);
  });

  it("401 and 429 likewise surface as is_error with capture:'blocked'", async () => {
    for (const code of [401, 429]) {
      vi.stubGlobal("fetch", vi.fn(async () => mkResponse(code)));
      const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/" });
      expect(res.is_error).toBe(true);
      expect(JSON.parse(res.content).capture).toBe("blocked");
      vi.unstubAllGlobals();
    }
  });

  it("200 stays a success (is_error:false) with capture:'dom_text'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(200, "<p>hi</p>")));
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/" });
    expect(res.is_error).toBe(false);
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.content).capture).toBe("dom_text");
  });

  it("404 still surfaces as is_error web_fetch_http_error (NOT blocked)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(404, "nope")));
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/" });
    expect(res.is_error).toBe(true);
    const parsed = JSON.parse(res.content);
    expect(parsed.error).toBe("web_fetch_http_error");
    expect(parsed.capture).toBeUndefined();
  });

  it("503 (anti-bot 5xx) surfaces as is_error with capture:'blocked'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(503, "down")));
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/" });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).capture).toBe("blocked");
  });

  it("SPA empty shell surfaces as is_error web_fetch_empty_shell + capture:'empty_shell'", async () => {
    const shell = `<!doctype html><html><body><div>Loading…</div><script>self.__next_f=[];${"z".repeat(3000)}</script></body></html>`;
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(200, shell)));
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/" });
    expect(res.is_error).toBe(true);
    const parsed = JSON.parse(res.content);
    expect(parsed.error).toBe("web_fetch_empty_shell");
    expect(parsed.capture).toBe("empty_shell");
  });
});

describe("callWebFetchTool — a failed read points the agent at web_search", () => {
  const shell = `<!doctype html><html><body><div>Loading…</div><script>self.__next_f=[];${"z".repeat(3000)}</script></body></html>`;
  it.each([
    ["403 refusal", () => mkResponse(403, "forbidden")],
    ["404", () => mkResponse(404, "nope")],
    ["SPA empty shell", () => mkResponse(200, shell)],
  ])("%s: the error message says to search for the same page or topic", async (_label, mk) => {
    __resetControlProbeMemo();
    vi.stubGlobal("fetch", vi.fn(async () => mk()));
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/pricing" });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).message).toContain(SEARCH_INSTEAD_HINT);
  });

  it("a network failure says it too; a successful read does not", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const failed = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/" });
    expect(failed.is_error).toBe(true);
    expect(JSON.parse(failed.content).message).toContain("web_search__search");
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(200, "<p>hi</p>")));
    const ok = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/" });
    expect(ok.content).not.toContain("web_search__search");
  });
});

describe("callWebFetchTool — social_card og fallback", () => {
  it("LinkedIn 999 → crawler-UA og card → ok:true/is_error:false, capture:'social_card'", async () => {
    stubPublicDns();
    const og =
      `<html><head><meta property="og:title" content="Andrea Manrique - Yanne Capital | LinkedIn">` +
      `<meta property="og:description" content="Associate at Kadenwood Group · Experience: Yanne Capital"></head><body>Sign Up | LinkedIn</body></html>`;
    const oor999 = {
      status: 999,
      headers: new Headers({ "content-type": "text/html" }),
      body: null,
    } as unknown as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const ua = ((init?.headers ?? {}) as Record<string, string>)["user-agent"] ?? "";
        return ua.includes("facebookexternalhit") ? mkResponse(200, og) : oor999;
      }),
    );
    const res = await callWebFetchTool("t1", "fetch", {
      url: "https://www.linkedin.com/in/andrea-manrique-0a90b013b/",
    });
    expect(res.is_error).toBe(false);
    expect(res.ok).toBe(true);
    const parsed = JSON.parse(res.content);
    expect(parsed.capture).toBe("social_card");
    expect(parsed.body_text).toContain("Yanne Capital");
  });
});

describe("competitor_intel__http_fetch routes to the web_fetch path", () => {
  it("the http_fetch arg shape ({url}) handled by callWebFetchTool('fetch') → dom_text on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(200, "<p>real competitor copy here</p>")));
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/" });
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content).capture).toBe("dom_text");
  });

  it("a blocked competitor fetch (403) → capture:'blocked' so the funnel can escalate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(403, "forbidden")));
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/" });
    expect(res.is_error).toBe(true);
    expect(JSON.parse(res.content).capture).toBe("blocked");
  });
});

describe("web_fetch tool schema (what an agent can actually pass)", () => {
  it("declares max_excerpt_bytes, so an agent has a lever on a large page", () => {
    const tools = listWebFetchTools();
    const fetchTool = tools.find((t) => t.tool_name === "fetch");
    expect(fetchTool).toBeDefined();
    const props = (fetchTool!.input_schema as { properties?: Record<string, unknown> })
      .properties;
    expect(Object.keys(props ?? {}).sort()).toEqual(
      ["max_bytes", "max_excerpt_bytes", "timeout_ms", "url"].sort(),
    );
  });

  it("reads the page when max_excerpt_bytes is out of range, instead of rejecting the call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(200, "<p>hi</p>")));
    for (const max_excerpt_bytes of [16000, 1_000_000]) {
      const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/", max_excerpt_bytes });
      expect(res.is_error).toBe(false);
      expect(JSON.parse(res.content).capture).toBe("dom_text");
    }
  });

  it("tells the agent in the DESCRIPTION that a big page is a partial read", () => {
    const fetchTool = listWebFetchTools().find((t) => t.tool_name === "fetch");
    expect(fetchTool!.description).toMatch(/PARTIAL read/);
    expect(fetchTool!.description).toMatch(/max_excerpt_bytes/);
  });
});

describe("callWebFetchTool — control probe", () => {
  beforeEach(() => __resetControlProbeMemo());

  it("403 where the root is refused too: control_blocked forbids an absence claim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(403, "forbidden")));
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/pricing" });
    const parsed = JSON.parse(res.content);
    expect(parsed.control_probe.verdict).toBe("control_blocked");
    expect(parsed.control_probe.url).toBe("https://8.8.8.8/");
    expect(parsed.control_probe.reading).toMatch(/do not report an absence or a dead link/i);
    expect(parsed.message).toContain("Control fetch");
  });

  it("403 where the root answers: control_inconclusive, and it licenses NOTHING", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/pricing") ? mkResponse(403, "forbidden") : mkResponse(200, "<p>home</p>"),
      ),
    );
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/pricing" });
    const parsed = JSON.parse(res.content);
    expect(parsed.control_probe.verdict).toBe("control_inconclusive");
    expect(parsed.control_probe.reading).toMatch(/proves NOTHING about the page/i);
    expect(parsed.control_probe.reading).toMatch(/do not report an absence or a dead link/i);
    expect(parsed.control_probe.reading).not.toMatch(/specific to this URL|is real|confirmed|really is dead/i);
  });

  it("404 where the root 404s too: control_blocked, no dead-link claim licensed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mkResponse(404, "nope")));
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/gone" });
    const parsed = JSON.parse(res.content);
    expect(parsed.error).toBe("web_fetch_http_error");
    expect(parsed.control_probe.verdict).toBe("control_blocked");
  });

  it("404 where the root answers: inconclusive, and the sentence still forbids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/gone") ? mkResponse(404, "nope") : mkResponse(200, "<p>home</p>"),
      ),
    );
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/gone" });
    const parsed = JSON.parse(res.content);
    expect(parsed.control_probe.verdict).toBe("control_inconclusive");
    expect(parsed.control_probe.reading).toMatch(/proves NOTHING about the page/i);
    expect(parsed.control_probe.reading).toMatch(/do not report an absence or a dead link/i);
    expect(parsed.control_probe.reading).not.toMatch(/specific to this URL|is real|confirmed/i);
  });

  it("a 429 is never probed: we do not re-hit an origin that just rate-limited us", async () => {
    const fetchMock = vi.fn(async () => mkResponse(429, "slow down"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/pricing" });
    expect(JSON.parse(res.content).control_probe).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a root that returns an SPA shell is NOT an answer: control_blocked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).endsWith("/pricing")
          ? mkResponse(403, "forbidden")
          : mkResponse(200, '<html><body><div id="root"></div><script src="/a.js"></script></body></html>'),
      ),
    );
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/pricing" });
    expect(JSON.parse(res.content).control_probe.verdict).toBe("control_blocked");
  });

  it("the probe is memoized per origin: 10 walled paths cost ONE control fetch", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url) === "https://8.8.8.8/" ? mkResponse(200, "<p>home</p>") : mkResponse(403, "no"),
    );
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < 10; i++) {
      await callWebFetchTool("t1", "fetch", { url: `https://8.8.8.8/walled-${i}` });
    }
    const rootCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "https://8.8.8.8/").length;
    expect(rootCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("a blocked ROOT does not probe itself", async () => {
    const fetchMock = vi.fn(async () => mkResponse(403, "forbidden"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/" });
    expect(JSON.parse(res.content).control_probe).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an unrelated probe failure (network) yields no verdict, and the refusal is unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/pricing")) return mkResponse(403, "forbidden");
        throw new Error("network down");
      }),
    );
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/pricing" });
    const parsed = JSON.parse(res.content);
    expect(res.is_error).toBe(true);
    expect(parsed.error).toBe("web_fetch_http_error");
    expect(parsed.control_probe).toBeUndefined();
  });

  it("a 200 never triggers a probe", async () => {
    const fetchMock = vi.fn(async () => mkResponse(200, "<p>hi</p>"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await callWebFetchTool("t1", "fetch", { url: "https://8.8.8.8/pricing" });
    expect(JSON.parse(res.content).control_probe).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
