const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, requireShim) {
  const source = fs.readFileSync(path.join(__dirname, "../src/features/connectors", file), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: requireShim, Date, Math, Number, Set, Map, Object });
  return mod.exports;
}
const wc = load("webCatalog.ts", () => ({}));
const h = load("health.ts", (name) => {
  if (name === "./webCatalog") return wc;
  throw new Error(`unexpected import ${name}`);
});
const plain = (v) => JSON.parse(JSON.stringify(v));

const NOW = Date.parse("2026-09-30T12:00:00Z");
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

function build(rows, extra = {}) {
  return h.buildConnections({
    rows,
    suggested: ["meta_ads", "stripe", "posthog"],
    labelFor: (s) => ({ meta_ads: "Meta Ads", google_ads: "Google Ads", stripe: "Stripe", slack: "Slack", posthog: "PostHog" })[s] ?? s,
    usedByFor: (s) => (s === "stripe" ? ["Your goal", "Revenue answers"] : []),
    now: NOW,
    ...extra,
  });
}

test("Meta Ads expires 60 days after connect when no expiry is stored", () => {
  assert.equal(h.tokenHealth({ slug: "meta_ads", connected_at: iso(NOW - 61 * DAY) }, NOW).health, "reconnect");
  assert.deepEqual(plain(h.tokenHealth({ slug: "meta_ads", connected_at: iso(NOW - 50 * DAY) }, NOW)), {
    health: "expiring",
    days: 10,
  });
  assert.equal(h.tokenHealth({ slug: "meta_ads", connected_at: iso(NOW - 5 * DAY) }, NOW).health, "connected");
});

test("Google Ads uses its stored expiry, and nothing without one", () => {
  assert.equal(h.tokenHealth({ slug: "google_ads", token_expires_at: iso(NOW - DAY) }, NOW).health, "reconnect");
  assert.equal(h.tokenHealth({ slug: "google_ads", connected_at: iso(NOW - 400 * DAY) }, NOW).health, "connected");
});

test("Slack missing permissions needs a reconnect", () => {
  const [slack] = build([{ slug: "slack", team_name: "Upcar HQ" }], { slackMissing: ["chat:write"] });
  assert.equal(slack.health, "reconnect");
  assert.equal(slack.reason, "Missing scope: chat:write. Reconnect to grant them.");
  assert.equal(slack.account, "Upcar HQ");
});

test("connected rows come first, suggestions only when not connected", () => {
  const list = build([{ slug: "stripe", account_login: "acct_1" }]);
  assert.deepEqual(plain(list.map((c) => [c.slug, c.health])), [
    ["stripe", "connected"],
    ["meta_ads", "off"],
    ["posthog", "off"],
  ]);
});

test("grouping and the blocked set", () => {
  const list = build([
    { slug: "meta_ads", connected_at: iso(NOW - 90 * DAY) },
    { slug: "slack" },
    { slug: "stripe" },
  ], { slackMissing: ["channels:read"] });
  const g = h.groupConnections(list);
  assert.deepEqual(plain(g.attention.map((c) => c.slug)), ["slack", "meta_ads"]);
  assert.deepEqual(plain(g.connected.map((c) => c.slug)), ["stripe"]);
  assert.deepEqual(plain(g.off.map((c) => c.slug)), ["posthog"]);
  assert.deepEqual(plain(h.blockers(list).map((c) => c.slug)), ["meta_ads"]);
});

test("status words", () => {
  assert.equal(h.statusText({ health: "expiring", expiresInDays: 6 }), "Expiring in 6d");
  assert.equal(h.statusText({ health: "reconnect" }), "Needs reconnect");
  assert.equal(h.statusText({ health: "off" }), "Not connected");
});

test("a connector not synced for over 36 hours is Not syncing, and stays under Connected", () => {
  const list = build([{ slug: "stripe" }, { slug: "operator_db" }], {
    lastSync: { stripe: iso(NOW - 40 * 3_600_000), operator_db: iso(NOW - 30 * 3_600_000) },
  });
  assert.equal(list.find((c) => c.slug === "stripe").health, "stale");
  assert.equal(list.find((c) => c.slug === "operator_db").health, "connected");
  assert.equal(h.statusText({ health: "stale" }), "Not syncing");
  assert.deepEqual(plain(h.groupConnections(list).connected.map((c) => c.slug)), ["operator_db", "stripe"]);
});

test("Slack and GitHub lead the connected and not-connected groups", () => {
  const list = h.buildConnections({
    rows: [{ slug: "stripe" }, { slug: "github" }, { slug: "slack" }],
    suggested: ["meta_ads", "slack", "github"],
    labelFor: (s) => s,
    usedByFor: () => [],
    now: NOW,
  });
  assert.deepEqual(plain(h.groupConnections(list).connected.map((c) => c.slug)), ["slack", "github", "stripe"]);
});

test("connected follows the web row order: Slack, GitHub, then web's list, Composio apps last", () => {
  const list = h.buildConnections({
    rows: [
      { slug: "composio.gmail" },
      { slug: "stripe" },
      { slug: "tiktok" },
      { slug: "github" },
      { slug: "meta_ads" },
      { slug: "whatsapp" },
      { slug: "slack" },
    ],
    suggested: [],
    labelFor: (s) => s,
    usedByFor: () => [],
    now: NOW,
  });
  assert.deepEqual(plain(h.groupConnections(list).connected.map((c) => c.slug)), [
    "slack",
    "github",
    "whatsapp",
    "meta_ads",
    "stripe",
    "tiktok",
    "composio.gmail",
  ]);
});

test("row subtitle follows web: reason, then Last synced · detail, then detail, then purpose", () => {
  const [synced] = build([{ slug: "stripe", team_name: "billing@upcar.ai" }], {
    lastSync: { stripe: iso(NOW - 2 * 3_600_000) },
  });
  assert.equal(h.rowSubtitle(synced, NOW), "Last synced 2h ago · billing@upcar.ai");
  const [detailOnly] = build([{ slug: "stripe", team_name: "billing@upcar.ai" }]);
  assert.equal(h.rowSubtitle(detailOnly, NOW), "billing@upcar.ai");
  const [plain] = build([{ slug: "stripe", team_name: "unknown" }]);
  assert.equal(h.rowSubtitle(plain, NOW), "Read charges, payouts, and disputes.");
  const [expired] = build([{ slug: "meta_ads", connected_at: iso(NOW - 90 * DAY) }]);
  assert.equal(h.rowSubtitle(expired, NOW), "Access token expired — agents can't read this account until you reconnect.");
  const off = build([]).find((c) => c.slug === "posthog");
  assert.equal(h.rowSubtitle(off, NOW), "Answer funnel and retention questions from product events.");
});

test("web connectedDetail per connector", () => {
  assert.equal(wc.connectedDetail({ slug: "meta_ads", team_id: "act_2231" }), "act_2231");
  assert.equal(wc.connectedDetail({ slug: "google_ads", team_id: "482-119" }), "");
  assert.equal(wc.connectedDetail({ slug: "operator_db", team_id: "postgres" }), "postgres");
  assert.equal(wc.connectedDetail({ slug: "operator_db", managed_by: "zavi" }), "Your app's database, set up by Zavi");
  assert.equal(wc.connectedDetail({ slug: "github", account_login: "upcar", repo_full_names: ["a/b", "a/c"] }), "upcar · 2 repos");
  assert.equal(wc.connectedDetail({ slug: "linear", team_name: "Upcar" }), "Upcar");
});

test("sections: For You takes the first 6 unconnected in order, the rest group by web category", () => {
  const list = h.buildConnections({
    rows: [{ slug: "slack" }],
    suggested: wc.NATIVE_SLUGS,
    labelFor: (s) => wc.WEB_LABELS[s] ?? s,
    usedByFor: () => [],
    now: NOW,
  });
  const sec = h.sectionConnections(list, wc.DEFAULT_FOR_YOU_SLUGS);
  assert.deepEqual(plain(sec.connected.map((c) => c.slug)), ["slack"]);
  assert.deepEqual(plain(sec.forYou.map((c) => c.slug)), [
    "github",
    "telegram",
    "discord",
    "meta_ads",
    "google_ads",
    "google_analytics",
  ]);
  const titles = sec.categories.map((c) => c.title);
  assert.equal(titles[0], "Communication");
  assert.ok(titles.indexOf("Payments") < titles.indexOf("Data"));
  const all = [...sec.forYou, ...sec.categories.flatMap((c) => c.items)];
  assert.equal(all.length, wc.NATIVE_SLUGS.length - 1);
});

test("ago text matches web receipts agoText", () => {
  assert.equal(h.agoText(iso(NOW - 30_000), NOW), "just now");
  assert.equal(h.agoText(iso(NOW - 10 * 60_000), NOW), "10m ago");
  assert.equal(h.agoText(iso(NOW - 47 * 3_600_000), NOW), "47h ago");
  assert.equal(h.agoText(iso(NOW - 2 * DAY - 3_600_000), NOW), "2 days ago");
  assert.equal(h.agoText(undefined, NOW), undefined);
});
