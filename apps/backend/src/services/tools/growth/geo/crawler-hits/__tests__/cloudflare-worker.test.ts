import { describe, it, expect, vi, afterEach } from "vitest";
import {
  WORKER_TOKEN_SECRET,
  aiBotPatternSource,
  buildCloudflareWorkerScript,
  cloudflareWorkerSetup,
  ingestUrl,
} from "../cloudflare-worker";
import { AI_BOTS, classifyUserAgent } from "../../bots";
import { aggregateHits, parseLogBody } from "../parse";

const INGEST = "https://api.zaviagent.com/api/geo/crawler-hits/ingest";
const TOKEN = `zgeo_${"a".repeat(64)}`;
const HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
const PERPLEXITY = "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)";

type Handler = {
  fetch: (req: Request, env: Record<string, string>, ctx: { waitUntil: (p: Promise<unknown>) => void }) => Promise<Response>;
};

function loadWorker(fetchMock: (input: unknown, init?: RequestInit) => Promise<Response>): Handler {
  const script = buildCloudflareWorkerScript(INGEST);
  expect(script).toContain("export default {");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("fetch", script.replace("export default", "return"))(fetchMock) as Handler;
}

function harness(fetchImpl?: (input: unknown, init?: RequestInit) => Promise<Response>) {
  const page = new Response("<html>ok</html>", { status: 200 });
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    if (input === INGEST) return fetchImpl ? fetchImpl(input, init) : new Response("{}", { status: 200 });
    return page;
  });
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void waited.push(p) };
  return { worker: loadWorker(fetchMock), page, calls, waited, ctx };
}

const req = (ua: string, url = "https://example.com/pricing?utm_source=x#top") =>
  new Request(url, { headers: { "user-agent": ua } });

describe("the generated Cloudflare Worker", () => {
  it("serves a human's page untouched and sends nothing", async () => {
    const h = harness();
    const res = await h.worker.fetch(req(HUMAN), { [WORKER_TOKEN_SECRET]: TOKEN }, h.ctx);
    expect(res).toBe(h.page);
    expect(h.calls).toHaveLength(1);
    expect(h.waited).toHaveLength(0);
  });

  it("forwards an AI bot request: user agent, path WITHOUT query, status, time — with the token as a bearer", async () => {
    const h = harness();
    const res = await h.worker.fetch(req(PERPLEXITY), { [WORKER_TOKEN_SECRET]: TOKEN }, h.ctx);
    expect(res).toBe(h.page);
    await Promise.all(h.waited);
    const ingest = h.calls.find((c) => c.input === INGEST)!;
    expect(ingest.init!.method).toBe("POST");
    expect((ingest.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(ingest.init!.body as string);
    expect(body).toEqual([{ user_agent: PERPLEXITY, path: "/pricing", status: 200, timestamp: expect.any(Number) }]);
    expect(Object.keys(body[0]).sort()).toEqual(["path", "status", "timestamp", "user_agent"]);
  });

  it("sends nothing when the token secret is missing", async () => {
    const h = harness();
    await h.worker.fetch(req(PERPLEXITY), {}, h.ctx);
    expect(h.calls).toHaveLength(1);
  });

  it("still serves the page when Zavi is down or the POST rejects", async () => {
    const h = harness(async () => {
      throw new Error("zavi unreachable");
    });
    const res = await h.worker.fetch(req(PERPLEXITY), { [WORKER_TOKEN_SECRET]: TOKEN }, h.ctx);
    expect(res).toBe(h.page);
    await expect(Promise.all(h.waited)).resolves.toBeDefined();
  });

  it("still serves the page when the counting code itself throws", async () => {
    const h = harness();
    const throwingCtx = {
      waitUntil: () => {
        throw new Error("boom");
      },
    };
    const res = await h.worker.fetch(req(PERPLEXITY), { [WORKER_TOKEN_SECRET]: TOKEN }, throwingCtx);
    expect(res).toBe(h.page);
  });

  it("round-trips: what the Worker sends becomes a stored daily row", async () => {
    const h = harness();
    await h.worker.fetch(req(PERPLEXITY), { [WORKER_TOKEN_SECRET]: TOKEN }, h.ctx);
    const body = h.calls.find((c) => c.input === INGEST)!.init!.body as string;
    const { rows } = aggregateHits(parseLogBody(Buffer.from(body)).records, Date.now());
    expect(rows).toEqual([expect.objectContaining({ bot: "PerplexityBot", path: "/pricing", status: 200, hits: 1 })]);
  });
});

describe("snippet parity with the server's bot table", () => {
  const worker = new RegExp(aiBotPatternSource(), "i");

  it("forwards exactly the bots the ingest route can classify", () => {
    const uas = [
      "compatible; GPTBot/1.2",
      "compatible; OAI-SearchBot/1.0",
      "ChatGPT-User/1.0",
      "compatible; ClaudeBot/1.0",
      "Claude-SearchBot/1.0",
      "Claude-User/1.0",
      PERPLEXITY,
      "Perplexity-User/1.0",
      "compatible; bingbot/2.0",
      "CCBot/2.0",
      "Bytespider",
      "meta-externalagent/1.1",
      HUMAN,
      "Googlebot/2.1",
    ];
    for (const ua of uas) {
      expect(worker.test(ua)).toBe(classifyUserAgent(ua) !== null);
    }
  });

  it("covers every log-visible bot in the table", () => {
    for (const bot of AI_BOTS.filter((b) => b.ua !== null)) {
      expect(aiBotPatternSource()).toContain(bot.ua!.source);
    }
  });
});

describe("cloudflareWorkerSetup", () => {
  afterEach(() => {
    delete process.env.PUBLIC_API_ORIGIN;
  });

  it("carries no secret, names the secret to create, and says what the Worker cannot see", () => {
    const s = cloudflareWorkerSetup(INGEST);
    expect(s.script).not.toMatch(/zgeo_[0-9a-f]/);
    expect(s.script).toContain(INGEST);
    expect(s.secret_name).toBe("ZAVI_GEO_TOKEN");
    expect(s.steps.join(" ")).toMatch(/fail open/i);
    expect(s.caveats.join(" ")).toMatch(/before Workers/i);
    expect(s.caveats.join(" ")).toMatch(/100,000/);
  });

  it("builds the ingest URL from PUBLIC_API_ORIGIN, defaulting to production", () => {
    expect(ingestUrl()).toBe("https://api.zaviagent.com/api/geo/crawler-hits/ingest");
    process.env.PUBLIC_API_ORIGIN = "http://localhost:3001/";
    expect(ingestUrl()).toBe("http://localhost:3001/api/geo/crawler-hits/ingest");
  });
});
