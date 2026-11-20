const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/channelList.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Map, Math, Number, String });
const c = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

const known = new Set(["meta_ads", "google_ads", "tiktok_ads", "seo", "x_organic", "sms"]);
const registry = (slug) => (known.has(slug) ? { name: slug.toUpperCase(), description: `${slug} desc` } : null);
const build = (channels, pending = {}, seen = {}, order) => c.buildChannelRows({ registry, channels, pending, seen, order });
const bySlug = (rows) => Object.fromEntries(rows.map((r) => [r.slug, r]));

test("waiting caps at 5+ like web", () => {
  assert.equal(c.waitingText(1), "1 action waiting");
  assert.equal(c.waitingText(3), "3 actions waiting");
  assert.equal(c.waitingText(12), "5+ actions waiting");
});

test("status words follow web's order of rules", () => {
  const rows = bySlug(
    build(
      [
        { channel_slug: "meta_ads", work_state: "running" },
        { channel_slug: "google_ads", work_state: "idle" },
        { channel_slug: "seo", work_state: "needs_review" },
        { channel_slug: "x_organic", work_state: "delivered" },
        { channel_slug: "tiktok_ads", work_state: "idle", locked_tier: "pro" },
      ],
      { meta_ads: 2, google_ads: 3, tiktok_ads: 4 },
      { google_ads: 1 },
    ),
  );
  assert.deepEqual(plain(rows.meta_ads.status), { tone: "working", text: "Working on it" });
  assert.deepEqual(plain(rows.google_ads.status), { tone: "new", text: "2 actions waiting" });
  assert.deepEqual(plain(rows.seo.status), { tone: "muted", text: "Ready for you" });
  assert.deepEqual(plain(rows.x_organic.status), { tone: "muted", text: "Done" });
  assert.deepEqual(plain(rows.tiktok_ads.status), { tone: "muted", text: "4 actions waiting" });
  assert.equal(rows.tiktok_ads.planTier, "pro");
  assert.equal(rows.sms.status, null);
});

test("seen actions still read as waiting, muted", () => {
  const r = bySlug(build([{ channel_slug: "seo", work_state: "idle" }], { seo: 2 }, { seo: 2 })).seo;
  assert.equal(r.unseen, 0);
  assert.deepEqual(plain(r.status), { tone: "muted", text: "2 actions waiting" });
});

test("groups follow web: open sections by family, plan locks, coming soon", () => {
  const reg = (slug) => ({
    meta_ads: { name: "Meta", description: "", category: "paid" },
    x_organic: { name: "X", description: "", category: "organic" },
    ugc: { name: "UGC", description: "", category: "organic", section: "creators" },
    sms: { name: "SMS", description: "", category: "owned" },
    seo: { name: "SEO", description: "" },
    google_ads: { name: "Google", description: "", category: "paid" },
    tiktok_ads: { name: "TikTok", description: "", category: "paid" },
  })[slug] ?? null;
  const rows = bySlug(
    c.buildChannelRows({
      registry: reg,
      channels: [
        { channel_slug: "google_ads", work_state: "idle", locked_tier: "growth" },
        { channel_slug: "tiktok_ads", work_state: "idle", locked: true },
      ],
      pending: { google_ads: 2 },
      seen: {},
    }),
  );
  assert.equal(rows.meta_ads.group, "paid");
  assert.equal(rows.x_organic.group, "organic");
  assert.equal(rows.ugc.group, "creators");
  assert.equal(rows.sms.group, "owned");
  assert.equal(rows.seo.group, "organic");
  assert.equal(rows.google_ads.group, "plan");
  assert.equal(rows.tiktok_ads.group, "soon");
  const page = plain(c.groupRows(Object.values(rows)));
  assert.deepEqual(page.sections.map((s) => s.label), ["Organic", "Creators", "Paid ads", "Email and SMS"]);
  assert.deepEqual(page.plans.map((g) => [g.tier, g.waiting]), [["growth", 2]]);
  assert.deepEqual(page.soon.map((r) => r.slug), ["tiktok_ads"]);
});

test("order: waiting, then ready for review, then running, then the rest; coming soon last", () => {
  const rows = build(
    [
      { channel_slug: "meta_ads", work_state: "running" },
      { channel_slug: "seo", work_state: "needs_review" },
      { channel_slug: "sms", work_state: "idle", locked: true },
    ],
    { x_organic: 1, sms: 3 },
  );
  assert.deepEqual(plain(rows.map((r) => r.slug)), ["x_organic", "seo", "meta_ads", "google_ads", "tiktok_ads", "sms"]);
});

test("a frozen order keeps rows still across refreshes", () => {
  const first = build([], { seo: 1 }).map((r) => r.slug);
  const next = build([], { meta_ads: 4 }, {}, first).map((r) => r.slug);
  assert.deepEqual(plain(next), plain(first));
});

test("summary counts unseen actions on open channels", () => {
  const rows = build(
    [
      { channel_slug: "meta_ads", work_state: "running" },
      { channel_slug: "sms", work_state: "idle", locked: true },
    ],
    { meta_ads: 2, seo: 3, sms: 5 },
    { seo: 1 },
  );
  assert.deepEqual(plain(c.listSummary(rows)), { actions: 4, channels: 2, working: 1 });
  assert.equal(c.planName("starter"), "Starter");
  assert.equal(c.planName(null), null);
});
