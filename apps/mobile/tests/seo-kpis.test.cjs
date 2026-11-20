const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/seoKpis.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
const copySrc = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/features/channels/seoIssueCopy.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const copyMod = { exports: {} };
vm.runInNewContext(copySrc, { module: copyMod, exports: copyMod.exports });
const tablesSrc = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/features/channels/channelTables.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const tablesMod = { exports: {} };
vm.runInNewContext(tablesSrc, { module: tablesMod, exports: tablesMod.exports });
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: (n) => (n === "./channelTables" ? tablesMod.exports : copyMod.exports), Number, Math, Set, Array, Object, String, RegExp });
const seo = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

const url = (i) => `https://upcar.ai/p${i}`;
const pages = Array.from({ length: 24 }, (_, i) => ({ url: url(i), schema_types: i < 14 ? ["Organization"] : [] }));
const finding = (code, severity, urls, scope) => ({ code, severity, urls, scope, summary: code });
const payload = (over = {}) => ({
  site_health: {
    status: "ok",
    pages,
    findings: [
      finding("e1", "high", [url(0), url(1), url(2), url(3), url(4), url(5)]),
      finding("e2", "blocker", [url(0)]),
      finding("w1", "medium", Array.from({ length: 12 }, (_, i) => url(i))),
      finding("w2", "medium", [url(6), url(7), url(8), url(9)]),
      finding("w3", "medium", ["https://upcar.ai/robots.txt"]),
      finding("n1", "low", Array.from({ length: 10 }, (_, i) => url(i))),
    ],
  },
  performance: {
    lab: { state: "ok", pages: [{ categories: [{ id: "performance", score: 0.56 }, { id: "seo", score: 0.92 }] }] },
    field: { state: "ok", metrics: { largest_contentful_paint: { p75: 1800 }, interaction_to_next_paint: { p75: 150 }, cumulative_layout_shift: { p75: 0.34 } } },
  },
  geo: { status: "ok", score: { total: 58, bands: [{ key: "a", label: "Authority signals", score: 21 }, { key: "b", label: "Content", score: 80 }] } },
  ...over,
});

test("six numbers in web's order, each with its own scale and verdict", () => {
  const out = plain(seo.seoKpis(payload()));
  assert.deepEqual(out.map((m) => m.key), ["seo_issues", "seo_speed", "seo_vitals_passing", "seo_google", "seo_ai", "seo_schema"]);
  const by = Object.fromEntries(out.map((m) => [m.key, m]));
  assert.equal(by.seo_issues.value, 5);
  assert.equal(by.seo_issues.tone, "bad");
  assert.equal(by.seo_issues.note, "on 12 pages + site-wide · 1 notice");
  assert.equal(by.seo_speed.value, 56);
  assert.equal(by.seo_speed.tone, "warn");
  assert.equal(by.seo_speed.note, "Needs work · simulated phone");
  assert.equal(by.seo_vitals_passing.value, 2);
  assert.equal(by.seo_vitals_passing.note, "Worst: CLS 0.34");
  assert.equal(by.seo_google.value, 92);
  assert.equal(by.seo_google.tone, "good");
  assert.equal(by.seo_ai.note, "Weakest: Authority signals 21");
  assert.equal(by.seo_schema.value, 14);
  assert.deepEqual(by.seo_schema.outOf, { max: 24, of: true });
  assert.equal(by.seo_schema.tone, "warn");
});

test("a lane that did not report shows its reason, never a zero", () => {
  const out = plain(seo.seoKpis({ site_health: { status: "error", error_code: "fetch_failed" }, performance: { warming: true } }));
  const by = Object.fromEntries(out.map((m) => [m.key, m]));
  assert.equal(by.seo_issues.unmeasured, "Couldn't read your site (fetch failed). Press Refresh to try again.");
  assert.equal(by.seo_speed.unmeasured, "Measuring now. Check back in a few minutes.");
  assert.equal(by.seo_vitals_passing.unmeasured, "Measuring now. Check back in a few minutes.");
  assert.equal(by.seo_ai.unmeasured, "Not read yet. Press Refresh to read your site now.");
  assert.equal(out.length, 6);
});

test("a generic or missing payload answers nothing", () => {
  assert.deepEqual(plain(seo.seoKpis({ generic: true })), []);
  assert.deepEqual(plain(seo.seoKpis(null)), []);
  assert.equal(seo.seoHealth({ generic: true }), null);
});

test("site health is the share of pages with no error and no warning", () => {
  const h = plain(seo.seoHealth(payload()));
  const sick = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).size;
  assert.equal(h.score, Math.round(((24 - sick) / 24) * 100));
  assert.equal(h.headline, `${sick} of 24 pages need fixes`);
  assert.equal(h.tone, "bad");
  assert.deepEqual(h.counts.map((c) => [c.label, c.value]), [["Errors", 2], ["Warnings", 3], ["Notices", 1]]);
  assert.equal(h.counts[0].sub, "on 6 pages");
  assert.equal(h.counts[1].sub, "on 12 pages + site-wide");
  assert.equal(h.segmentsLabel, "24 pages read");
  assert.deepEqual(h.segments.map((s) => [s.label, s.value]), [["Healthy", 12], ["With warnings", 6], ["With errors", 6]]);
});

test("an unread site says so", () => {
  const h = plain(seo.seoHealth({ site_health: { status: "pending" } }));
  assert.equal(h.score, null);
  assert.equal(h.headline, "Not measured yet");
  assert.equal(h.counts[0].value, null);
});

test("Top issues: worst first, with web's headline, why, how and who", () => {
  const out = plain(seo.seoIssues({
    site_health: {
      status: "ok",
      pages: [{ url: "https://upcar.ai/a" }, { url: "https://upcar.ai/b/c" }],
      findings: [
        { code: "title_too_long", severity: "low", urls: ["https://upcar.ai/a"] },
        { code: "title_missing", severity: "high", urls: ["https://upcar.ai/a", "https://upcar.ai/b/c"] },
        { code: "sitemap_missing", severity: "medium", urls: [] },
        { code: "brand_new_rule", severity: "medium", urls: ["https://upcar.ai/a"], summary: "Brand new thing." },
      ],
    },
  }));
  assert.deepEqual(out.rows.map((r) => r.id), ["title_missing", "sitemap_missing", "brand_new_rule", "title_too_long"]);
  const [first, site, unknown, notice] = out.rows;
  assert.equal(first.sev, "error");
  assert.equal(first.title, "2 pages have no title");
  assert.equal(first.owner, "founder");
  assert.equal(first.pageCount, 2);
  assert.deepEqual(first.pages, ["upcar.ai/a", "upcar.ai/b/c"]);
  assert.match(first.fixDraft, /^Help me fix this on my site: 2 pages have no title\. Pages: upcar\.ai\/a, upcar\.ai\/b\/c\. Tell me exactly/);
  assert.equal(site.siteWide, true);
  assert.equal(unknown.title, "Brand new rule");
  assert.equal(unknown.why, "Brand new thing.");
  assert.equal(notice.sev, "notice");
});

test("Top issues: nothing found, or why nothing was read", () => {
  assert.equal(seo.seoIssues({ site_health: { status: "ok", pages: [], findings: [] } }).empty, "The crawl found none of the issues it checks for.");
  assert.match(seo.seoIssues({ site_health: { status: "pending" } }).empty, /^Not read yet/);
  assert.equal(seo.seoIssues({ generic: true }), null);
});

test("SEO's account line names the site that was read and how much of it", () => {
  assert.deepEqual(plain(seo.seoAccount({ site_health: { status: "ok", site: "https://upcar.ai/", pages_analyzed: 24 } })), { name: "upcar.ai", sub: "24 pages read" });
  assert.equal(seo.seoAccount({ site_health: { status: "ok", site: "https://upcar.ai", pages_analyzed: 1 } }).sub, "1 page read");
  assert.equal(seo.seoAccount({ site_health: { status: "ok", site: "https://upcar.ai" } }).sub, "Pages could not be read");
  assert.equal(seo.seoAccount({ site_health: { status: "pending" } }), null);
  assert.equal(seo.seoAccount(null), null);
});

test("a noindex on a Markdown file the crawl read is on that file, not site-wide", () => {
  const p = {
    site_health: {
      status: "ok",
      pages: [{ url: url(0) }, { url: url(1) }],
      pages_analyzed: 3,
      non_html_urls: ["https://upcar.ai/auth.md"],
      findings: [finding("noindex", "high", ["https://upcar.ai/auth.md"], "partial")],
    },
  };
  const h = plain(seo.seoHealth(p));
  assert.equal(h.counts.find((c) => c.kind === "error").sub, "on 1 other file");
  assert.equal(h.headline, "All 2 pages are healthy");
  assert.doesNotMatch(h.note, /site-wide/);
  assert.match(h.note, /1 file that is not a web page has issues counted below/);
  assert.equal(plain(seo.seoKpis(p)).find((m) => m.key === "seo_issues").note, "on 1 other file");
  const row = seo.seoIssues(p).rows[0];
  assert.equal(row.title, "1 file tells search engines not to list it");
  assert.equal(row.where, "1 file");
  assert.equal(row.pageCount, 0);
  const site = { site_health: { ...p.site_health, findings: [finding("noindex", "blocker", [url(0), "https://upcar.ai/auth.md"], "site")] } };
  assert.equal(plain(seo.seoHealth(site)).counts.find((c) => c.kind === "error").sub, "on 2 pages + 1 other file");
});

test("pages read is the web page count; a Markdown-only crawl says it read files, not nothing", () => {
  const mixed = { site_health: { status: "ok", site: "https://upcar.ai", pages: [{ url: url(0) }], pages_analyzed: 5, non_html_urls: ["a", "b", "c", "d"], findings: [] } };
  assert.equal(seo.seoAccount(mixed).sub, "1 page read");
  const mdOnly = { site_health: { status: "ok", site: "https://upcar.ai", pages: [], pages_analyzed: 2, non_html_urls: ["https://upcar.ai/llms.txt", "https://upcar.ai/docs.md"], findings: [] } };
  assert.equal(seo.seoAccount(mdOnly).sub, "2 files read, no web pages");
  assert.equal(seo.seoHealth(mdOnly).headline, "The crawl read 2 files, but none of them is a web page");
  assert.equal(seo.seoHealth(mdOnly).segmentsLabel, "2 files read, no web pages");
  assert.equal(plain(seo.seoKpis(mdOnly)).find((m) => m.key === "seo_schema").unmeasured, "The crawl read 2 files, but none of them is a web page.");
  assert.equal(plain(seo.seoTables(mdOnly)).find((t) => t.id === "seo_pages").empty, "The crawl read 2 files, but none of them is a web page.");
});

test("SEO tables: what real visitors got, with Google's bar and a verdict only on the three core vitals", () => {
  const t = plain(seo.seoTables(payload())).find((x) => x.id === "seo_vitals");
  assert.deepEqual(t.rows.map((r) => r.cells[0].text), ["Largest paint", "Tap response", "Layout shift"]);
  const cls = t.rows[2];
  assert.equal(cls.cells[1].text, "0.34");
  assert.equal(cls.cells[2].text, "poor");
  assert.equal(cls.cells[2].bad, true);
  assert.equal(cls.cells[3].text, "good at or under 0.10");
  assert.equal(t.rows[0].cells[1].text, "1.8 s");
  assert.equal(t.caption, "Chrome User Experience Report, 28 days of real visitors.");
});

test("SEO tables: page test fixes in the backend's order with who and what it recovers", () => {
  const p = payload();
  p.performance.lab.pages[0].final_url = "https://upcar.ai/";
  p.performance.lab.pages[0].strategy = "mobile";
  p.performance.lab.pages[0].opportunities = [
    { id: "unused-js", title: "Reduce unused JavaScript", metricSavings: [{ value: 1200, unit: "ms" }], culprits: [{ label: "a.js", detail: "a.js is 400 KB", owner: "developer" }] },
    { id: "alt", title: "Add alt text", savingsBytes: 2048, culprits: [{ label: "img", owner: "founder" }] },
    { id: "none", title: "Nothing to name" },
  ];
  const t = plain(seo.seoTables(p)).find((x) => x.id === "seo_opportunities");
  assert.deepEqual(t.rows.map((r) => r.cells[0].text), ["Reduce unused JavaScript", "Add alt text", "Nothing to name"]);
  assert.deepEqual(t.rows.map((r) => r.cells[1].text), ["Needs a developer", "You can do this", "—"]);
  assert.deepEqual(t.rows.map((r) => r.cells[2].text), ["1.2 s", "2 KB", "—"]);
  assert.equal(t.rows[0].cells[0].sub, "a.js is 400 KB");
  assert.equal(t.caption, "PageSpeed Insights, upcar.ai, simulated phone.");
});

test("SEO tables: Google's categories, the AI bands and every page the crawl read", () => {
  const p = payload();
  p.performance.lab.pages[0].categories = [{ id: "performance", title: "Performance", score: 0.56 }, { id: "seo", title: "SEO", score: 0.92 }];
  const by = Object.fromEntries(plain(seo.seoTables(p)).map((t) => [t.id, t]));
  assert.deepEqual(by.seo_google.rows.map((r) => [r.cells[0].text, r.cells[1].text, r.cells[2].text]), [["Performance", "56", "needs work"], ["SEO", "92", "good"]]);
  assert.deepEqual(by.seo_google.rows[0].cells[1].meter, { value: 56, max: 100 });
  assert.deepEqual(by.seo_ai.rows.map((r) => [r.cells[0].text, r.cells[1].text, r.cells[2].text]), [["Authority signals", "21", "—"], ["Content", "80", "—"]]);
  assert.equal(by.seo_pages.rows.length, 24);
  assert.equal(by.seo_pages.rows[0].cells[1].text, "Indexable");
  assert.equal(by.seo_pages.rows[0].cells[2].text, "Yes");
  assert.equal(by.seo_pages.rows[20].cells[2].text, "None");
  assert.equal(by.seo_pages.rows[0].cells[3].bad, true);
});

test("SEO tables: an unmeasured lane is an empty table that says why; another channel's payload draws none", () => {
  const out = plain(seo.seoTables({ site_health: { status: "pending" }, performance: { warming: true } }));
  assert.equal(out.length, 5);
  assert.ok(out.every((t) => t.rows.length === 0));
  assert.equal(out.find((t) => t.id === "seo_vitals").empty, "Measuring now. Check back in a few minutes.");
  assert.equal(out.find((t) => t.id === "seo_pages").empty, "Not read yet. Press Refresh to read your site now.");
  assert.deepEqual(plain(seo.seoTables({ generic: true })), []);
});
