const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/topPosts.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Number, Date, Array, Object, String });
const t = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

const xPost = (o = {}) => ({ id: "p1", url: "https://x.com/a/status/1", text: "Hello", format: "thread", source: "zavi", posted_at: "2026-09-12T10:00:00Z", views: 1234, likes: 5, replies: 2, reposts: 1, bookmarks: 0, eng_rate: 12.5, ...o });

test("X: eight columns, the format line, and the views under the rate", () => {
  const out = plain(t.topPostsTable("x_organic", { connected: true, top_posts: [xPost()] }));
  assert.deepEqual(out.columns.map((c) => c.label), ["Post", "Views", "Likes", "Replies", "Reposts", "Bookmarks", "Eng. rate", "Posted"]);
  const cells = out.rows[0].cells;
  assert.equal(cells[0].text, "Hello");
  assert.equal(cells[0].sub, "Thread · Zavi wrote it");
  assert.equal(cells[0].href, "https://x.com/a/status/1");
  assert.equal(cells[1].text, "1,234");
  assert.equal(cells[1].strong, true);
  assert.equal(cells[6].text, "12.5%");
  assert.equal(cells[6].sub, "1,234 views");
  assert.match(cells[7].text, /^12 Sep/);
});

test("X: no rate is a dash; no text is a placeholder", () => {
  const out = plain(t.topPostsTable("x_organic", { top_posts: [xPost({ eng_rate: null, text: "", url: null })] }));
  assert.equal(out.rows[0].cells[6].text, "—");
  assert.equal(out.rows[0].cells[0].text, "(no text)");
  assert.equal(out.rows[0].cells[0].href, undefined);
});

test("empty sentences depend on whether the account is connected", () => {
  assert.equal(t.topPostsTable("x_organic", { connected: true, top_posts: [] }).empty, "Nothing published in this window yet.");
  assert.equal(t.topPostsTable("x_organic", { connected: false, top_posts: [] }).empty, "Connect X to see your posts here.");
  assert.equal(t.topPostsTable("linkedin_organic", { page_url: null, top_posts: [] }).empty, "Save your LinkedIn page in Settings to see its posts here.");
});

test("absent is not empty: a payload with no list draws no table", () => {
  assert.equal(t.topPostsTable("x_organic", { connected: true }), null);
  assert.equal(t.topPostsTable("x_organic", null), null);
  assert.equal(t.topPostsTable("blog", { top_posts: [] }), null);
});

test("LinkedIn, Instagram and TikTok: their own columns, a dash for what the platform did not say", () => {
  const li = plain(t.topPostsTable("linkedin_organic", { page_url: "x", top_posts: [{ id: "a", text: "T", reactions: 3, comments: 1, reposts: null, posted_at: null }] }));
  assert.deepEqual(li.columns.map((c) => c.label), ["Post", "Reactions", "Comments", "Reposts", "Posted"]);
  assert.equal(li.rows[0].cells[3].text, "—");
  assert.equal(li.rows[0].cells[4].text, "—");
  const ig = plain(t.topPostsTable("instagram_organic", { connected: true, top_posts: [{ id: "a", text: "", views: null, likes: 4, comments: null, saves: 2 }] }));
  assert.deepEqual(ig.columns.map((c) => c.label), ["Post", "Views", "Likes", "Comments", "Saves", "Posted"]);
  assert.equal(ig.rows[0].cells[0].text, "(no caption)");
  assert.equal(ig.rows[0].cells[1].text, "—");
  const tk = plain(t.topPostsTable("tiktok_organic", { connected: true, top_posts: [] }));
  assert.deepEqual(tk.columns.map((c) => c.label), ["Post", "Views", "Likes", "Comments", "Shares", "Posted"]);
});
