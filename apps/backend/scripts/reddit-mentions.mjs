#!/usr/bin/env node

const ACTOR = "harshmaur~reddit-scraper-pro";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const term = process.argv[2];
if (!term || term.startsWith("--")) {
  console.error('Usage: node --env-file=.env scripts/reddit-mentions.mjs "<term>" [--days 365] [--max 100] [--json]');
  process.exit(2);
}
const days = Number(arg("days", "365"));
const max = Math.min(Number(arg("max", "100")), 250);
const asJson = process.argv.includes("--json");
const token = process.env.APIFY_TOKEN;
if (!token) {
  console.error("APIFY_TOKEN is not set. Run with: node --env-file=.env scripts/reddit-mentions.mjs ...");
  process.exit(2);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rx = new RegExp(`(?<![A-Za-z0-9])${escape(term)}(?![A-Za-z0-9])`, "i");
const searchTime = days <= 1 ? "day" : days <= 7 ? "week" : days <= 31 ? "month" : days <= 366 ? "year" : "all";
const since = Date.now() - days * 24 * 3600 * 1000;

const body = {
  searchTerms: [term],
  searchPosts: true,
  searchComments: true,
  searchCommunities: false,
  searchSort: "new",
  searchTime,
  maxPostsCount: max,
  maxCommentsCount: max,
  crawlCommentsPerPost: false,
  maxCommentsPerPost: 0,
  includeNSFW: false,
  fastMode: false,
};

const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});
if (!res.ok) {
  console.error(`Apify returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const items = await res.json();

const hits = [];
for (const i of items) {
  const kind = i.dataType;
  if (kind !== "post" && kind !== "comment") continue;
  const text = kind === "post" ? `${i.title ?? ""}\n${i.body ?? ""}` : `${i.body ?? ""}`;
  const created = Date.parse(i.createdAt ?? "");
  if (!Number.isFinite(created) || created < since) continue;
  const m = rx.exec(text);
  if (!m) continue;
  const at = m.index;
  hits.push({
    kind,
    created_at: i.createdAt,
    subreddit: i.communityName ?? null,
    author: i.authorName ?? null,
    score: i.upVotes ?? i.score ?? null,
    comments: i.commentsCount ?? null,
    title: kind === "post" ? i.title : (i.postTitle ?? null),
    url: i.postUrl ?? i.url ?? null,
    context: text.slice(Math.max(0, at - 90), at + term.length + 90).replace(/\s+/g, " ").trim(),
  });
}
hits.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

if (asJson) {
  console.log(JSON.stringify({ term, days, scanned: items.length, mentions: hits }, null, 2));
  process.exit(0);
}

console.log(`Reddit mentions of "${term}" in the last ${days} days`);
console.log(`Scanned ${items.length} search results; ${hits.length} actually contain "${term}" as a word inside the window.\n`);
if (hits.length === 0) {
  console.log("No mentions found. (Absence in one search is a finding, not proof: Reddit search is incomplete.)");
}
hits.forEach((h, n) => {
  console.log(`${n + 1}. [${h.kind}] ${h.created_at?.slice(0, 10)} · ${h.subreddit ?? "?"} · u/${h.author ?? "?"} · ▲${h.score ?? "?"} · 💬${h.comments ?? "?"}`);
  if (h.title) console.log(`   ${h.title}`);
  console.log(`   …${h.context}…`);
  if (h.url) console.log(`   ${h.url}`);
});
