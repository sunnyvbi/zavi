
import "dotenv/config";
import { callWebSearchTool } from "@/services/mcp/internal/web-search";
import { callApifyTool } from "@/services/mcp/internal/apify";

const FAKE_TENANT = "00000000-0000-0000-0000-000000000000";

async function run(label: string, fn: () => Promise<unknown>) {
  const start = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - start;
    console.log(`\n=== ${label} (${ms}ms) ===`);
    console.log(JSON.stringify(r, null, 2).slice(0, 1500));
  } catch (e) {
    console.log(`\n=== ${label} FATAL ===`);
    console.log((e as Error).message);
  }
}

async function main() {
  console.log("envs present:", {
    TAVILY_API_KEY: !!process.env.TAVILY_API_KEY,
    APIFY_TOKEN: !!process.env.APIFY_TOKEN,
  });

  await run("web_search__search", () =>
    callWebSearchTool(FAKE_TENANT, "search", {
      query: "turo car rental marketplace 2026",
      max_results: 3,
    }),
  );

  await run("apify__scrape_instagram (hashtag=turo, 3 items)", () =>
    callApifyTool(FAKE_TENANT, "scrape_instagram", {
      hashtag: "turo",
      max_items: 3,
    }),
  );

  await run("apify__scrape_tiktok (hashtag=carrental, 3 items)", () =>
    callApifyTool(FAKE_TENANT, "scrape_tiktok", {
      hashtag: "carrental",
      max_items: 3,
    }),
  );
}

main().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(1);
});
