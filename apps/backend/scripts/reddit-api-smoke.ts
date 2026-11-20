import "./_smoke-env";
import { getRedditRateLimitState } from "../src/services/connectors/reddit-api/client";
import {
  info,
  searchPosts,
  subredditAbout,
  subredditRules,
  thread,
} from "../src/services/connectors/reddit-api/endpoints";

async function main() {
  const sub = process.argv[2] ?? "smallbusiness";
  const q = process.argv[3] ?? "marketing";

  const about = await subredditAbout(sub);
  console.log(`about        r/${about.display_name} subscribers=${about.subscribers ?? "null"} type=${about.subreddit_type ?? "?"}`);

  const rules = await subredditRules(sub);
  console.log(`rules        ${rules.length} rules`);

  const search = await searchPosts({ q, subreddit: sub, t: "month", limit: 5 });
  console.log(`search       ${search.items.length} posts for "${q}"`);

  const first = search.items[0];
  if (first) {
    const t = await thread(first.id, { limit: 20 });
    const hidden = t.comments.filter((c) => c.score_hidden).length;
    console.log(
      `thread       ${first.name} locked=${t.post.locked} archived=${t.post.archived} ` +
        `comments_returned=${t.comments.length} score_hidden=${hidden}`,
    );
    const refreshed = await info([first.name]);
    console.log(`info         ${refreshed.length} of 1 returned`);
  } else {
    console.log("thread/info  skipped (no search results)");
  }

  console.log("rate limit  ", getRedditRateLimitState());
}

main().catch((err) => {
  console.error("reddit-api smoke FAILED:", err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
