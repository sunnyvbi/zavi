
import { AI_BOTS } from "../bots";

export const WORKER_TOKEN_SECRET = "ZAVI_GEO_TOKEN";

export function ingestUrl(): string {
  const origin = (process.env.PUBLIC_API_ORIGIN || "https://api.zaviagent.com").trim().replace(/\/+$/, "");
  return `${origin}/api/geo/crawler-hits/ingest`;
}

export function aiBotPatternSource(): string {
  return AI_BOTS.filter((b) => b.ua !== null)
    .map((b) => b.ua!.source)
    .join("|");
}

export function buildCloudflareWorkerScript(url: string = ingestUrl()): string {
  return `// Zavi GEO — AI crawler hits.
// Forwards ONLY requests from named AI crawlers (their user agent, the path without
// its query string, the response status and the time) so Zavi can show which AI
// bots fetch your pages. Nothing about human visitors is sent, and your site is
// served exactly as before: if Zavi is unreachable, a count is skipped, never a page.
const ZAVI_INGEST_URL = ${JSON.stringify(url)};
const AI_BOT = /${aiBotPatternSource()}/i;

export default {
  async fetch(request, env, ctx) {
    const response = await fetch(request);
    try {
      const userAgent = request.headers.get("user-agent") || "";
      const token = env.${WORKER_TOKEN_SECRET};
      if (token && AI_BOT.test(userAgent)) {
        const payload = [{
          user_agent: userAgent,
          path: new URL(request.url).pathname,
          status: response.status,
          timestamp: Date.now(),
        }];
        ctx.waitUntil(
          fetch(ZAVI_INGEST_URL, {
            method: "POST",
            headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }).catch(() => {}),
        );
      }
    } catch (_) {
      // Never let crawler counting affect the page.
    }
    return response;
  },
};
`;
}

export type CloudflareWorkerSetup = {
  kind: "cloudflare_worker";
  script: string;
  secret_name: string;
  ingest_url: string;
  steps: string[];
  caveats: string[];
};

export function cloudflareWorkerSetup(url: string = ingestUrl()): CloudflareWorkerSetup {
  return {
    kind: "cloudflare_worker",
    script: buildCloudflareWorkerScript(url),
    secret_name: WORKER_TOKEN_SECRET,
    ingest_url: url,
    steps: [
      "In Zavi, create the crawler-log token and copy it. It is shown once.",
      "In the Cloudflare dashboard, open Workers & Pages and create a Worker from the Hello World template. Name it something like zavi-geo-crawler-hits and deploy it.",
      "Open the Worker's code editor, replace everything with the script above, and deploy.",
      `In the Worker's Settings, under Variables and Secrets, add a Secret named ${WORKER_TOKEN_SECRET} with the token as its value, and deploy.`,
      "In the Worker's Settings, under Domains & Routes, add a Route for your site, for example example.com/* (add www.example.com/* too if you use it). Set the failure mode to fail open, so your site is served normally if the Worker is ever unavailable.",
      "Done. The panel moves from waiting for logs to live after the first AI bot visits a page. To check the wiring straight away, request any page with a bot user agent, for example: curl -A \"PerplexityBot/1.0\" https://example.com/ — this adds one test hit.",
    ],
    caveats: [
      "Cloudflare's own bot protection runs before Workers. A bot blocked by Bot Fight Mode, a WAF rule or the Block AI bots setting never reaches the Worker, so it shows here as zero hits, not as a blocked request. If a search bot stays at zero, check Security → Bots in Cloudflare first.",
      "The route runs for every visitor, not only bots. The Workers Free plan allows 100,000 requests a day across your account; past that, a fail-open route serves your site normally and crawler counts pause until the next day. Busier sites need Workers Paid.",
      "Only traffic that goes through Cloudflare's proxy (orange-cloud DNS records) passes through the Worker.",
    ],
  };
}
